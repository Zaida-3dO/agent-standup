// `record_tool_calls` — MILESTONES.md #50: "Tool-call ingest from the hook,
// with the item's state at the time, caps on the big fields." SCHEMA.md §10
// (`tool_calls` — "The highest-volume table and the foundation for
// everything measured. Written by the hook; zero agent effort.").
//
// This is the entry point for the whole of M7. #51 (runs), #52 (cost), #53
// (aggregation), #54 (repeat detection and file spread) and #56 (usage
// readings) all read what this writes.
//
// **The record shape and the caps are not defined here.** They live in
// `@/lib/telemetry/contract`, which the hook's spool (MILESTONES.md #88)
// imports too — one definition, so the two halves cannot disagree about a
// field name, a cap, or where the truncation marker goes. That module's
// header records what went wrong when they were two agreeing copies.
//
// ── A batch, not a single call ─────────────────────────────────────────
//
// The input is an array of records. The reason is the shape of the client:
// the hook runs on the critical path of every tool call, and a telemetry
// write costing a round trip per call would add latency to every action an
// agent takes — for data nothing reads in real time. So the hook spools
// locally and flushes in batches, and this operation is the server half of
// that contract.
//
// **`ts` is supplied by the caller, not defaulted to now.** A batch flushed
// five minutes after the fact must record when each call happened, not when
// it was uploaded, or every cost-per-stage figure #53 computes is
// attributed to whichever stage the item was in at flush time. The column
// has a `now()` default for a caller that genuinely has no clock; the hook
// is not that caller.
//
// **`sessionId` is on the envelope, not on each record.** A flush is one
// session's work — the records in it came from one hook process in one
// session — so hoisting the field says that structurally rather than
// trusting 500 records to repeat the same value, and it makes the
// assignment lookup once per request rather than once per record. A client
// whose spool spans sessions groups by session and posts once per group,
// which is free while building the batch and cheaper there than a per-record
// lookup is here.
//
// ── Duplicates are possible, and nothing here removes them ─────────────
//
// **An open loop, recorded rather than silently assumed.** The client's
// flush is deliberately at-least-once: it does not drop a batch until the
// server acknowledges it, so a batch that was stored but whose response was
// lost is sent again. That is the right side to err on — a duplicated row
// can be collapsed later, a lost one cannot be reconstructed, and §10 says
// this data cannot be backfilled.
//
// This operation does **not** de-duplicate. There is no unique constraint,
// no `ON CONFLICT`, and no idempotency key: `ToolCall` is a `bigserial` with
// two non-unique indexes, so a retried batch writes a second set of rows.
// The consequence is concrete — duplicate rows inflate every cost figure
// #52 computes and every rollup #53 aggregates.
//
// It is left open here rather than solved because the fix belongs with a
// consumer that can say what identity means: the natural key is something
// like (session, ts, tool, command), and whether two genuinely identical
// calls a millisecond apart are one event or two is a question #51's run
// boundaries answer and this row cannot. Naming it is the point — both
// halves of this feature reasoned correctly in isolation and neither
// implemented the counterpart, which is exactly the composition gap
// MILESTONES.md describes for #98-#102.
//
// ── The item's state at the time ───────────────────────────────────────
//
// `stateAt` is resolved here, from the item's current state at ingest,
// rather than accepted from the client. Two reasons, and the second is the
// stronger one:
//
//   1. The client does not know it. The hook sees a tool call; it has no
//      item and no state, and asking it to carry one would mean a lookup
//      per call — the exact cost the spool exists to avoid.
//   2. A client-supplied state is a client-supplied *claim about the
//      server's data*, and this column exists precisely so cost can be
//      sliced by stage (§10: "slicing cost by stage is the whole reason
//      this column exists"). A stage attribution a client can assert is one
//      a buggy client can silently corrupt, and the corruption would be
//      invisible — there is nothing to check it against.
//
// The honest limit of resolving at ingest: for a batch flushed after the
// item has moved on, `stateAt` records the state at *flush*, not at the
// call. That is a real inaccuracy, accepted rather than hidden, because the
// alternative — a correlated lookup into `events` per row, which §10
// explicitly rejects as the reason the column is denormalised at all —
// costs more than the error. The error is bounded by the flush interval and
// is zero for the common case of a session flushing while it still holds
// the item. It is recorded in SCHEMA.md §10 beside the column, because the
// consumers that read `state_at` as exact will never read this file.
//
// ── Ghost sessions are first-class ─────────────────────────────────────
//
// §10: `assignment_id` and `item_id` are "Null for a **ghost session** —
// real work with no minted task", and `state_at` is null for the same
// reason. So a record with no resolvable assignment is *recorded*, not
// refused. Refusing would mean the system measures only work that was
// already tracked, which is a survivorship bias baked into the data the M9
// picker learns from — and unminted work is exactly the work worth knowing
// about.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext, TransactionHandle } from "../context";
import {
  MAX_BATCH_SIZE,
  MAX_COMMAND_CHARS,
  MAX_PATHS,
  MAX_SESSION_ID_CHARS,
  MAX_TOOL_CHARS,
  capPaths,
  capText,
} from "@/lib/telemetry/contract";

/**
 * The largest token count accepted, matching Postgres `integer`.
 *
 * The columns are `int` (SCHEMA.md §10), so a larger value is not a big
 * measurement — it is one that cannot be stored, and Postgres would refuse
 * the whole batch with an error naming a column rather than a field. This
 * bound turns that into an `invalid_input` naming the offending record,
 * which is the difference between a client that can fix its bug and one
 * whose every flush fails forever.
 *
 * Deliberately **not clamped**: a token count is a measurement, and
 * clamping fabricates one. A count past two billion is a client bug, and
 * recording a plausible-looking wrong number would hide it inside data
 * whose entire purpose is to be trusted.
 */
const MAX_TOKEN_COUNT = 2_147_483_647;

const tokenCount = z.number().int().min(0).max(MAX_TOKEN_COUNT);

/**
 * A usage reading — the fraction of a rate-limit window consumed, carried
 * by the hook so the server's budget picture stays fresh "without it
 * holding credentials" (§10).
 *
 * Bounded at 0 and left open above 1: a window can legitimately read as
 * over-full, and refusing that would drop the reading that matters most.
 * Non-finite values are refused rather than stored — `NaN` in a `numeric`
 * column is a value every later comparison silently loses to.
 */
const usageReading = z.number().finite().min(0).nullable().optional();

/**
 * One record, matching `ToolCallRecord` in `@/lib/telemetry/contract`.
 *
 * **`.strict()` is deliberate and is kept.** A telemetry ingest is the one
 * place a silently-ignored field is most expensive: nothing downstream
 * reads these rows in real time, so a client sending `input_tokens` where
 * the schema says `inputTokens` would have every count recorded as zero,
 * and the first person to notice would be whoever tries to compute costs
 * from a month of zeroes. Strictness turns that into an immediate,
 * specific refusal naming the key.
 *
 * The cost of strictness is real and worth stating: it rejects the *whole
 * batch* for one unrecognised key, and a client whose flush keeps-and-stops
 * on failure will spool rather than drop. That is the correct side to err
 * on — a refused batch is retained and retried once the client is fixed,
 * whereas an accepted batch with a misread field is unbackfillable garbage
 * written into the one table §10 says cannot be reconstructed. Loud and
 * recoverable beats quiet and permanent.
 *
 * `model` and `effort` are **not** accepted here, and that is not an
 * oversight. §11 is explicit that they are not columns on this table ("two
 * strings on ~450k rows a year buys little"); #51 is the row that consumes
 * them, and it will decide how they arrive. Accepting them now would mean
 * accepting a field this build has nowhere to put.
 */
const recordSchema = z
  .object({
    /** The tool name, e.g. `Bash`. Required — a call with no tool is not one. */
    tool: z.string().min(1),
    /** When the call happened, per the client's clock. */
    ts: z.coerce.date(),
    /** The command text, for shell-shaped tools. Absent for tools carrying none. */
    command: z.string().nullable().optional(),
    /** What the call touched. Absent and empty are both stored as an empty array. */
    paths: z.array(z.string()).optional(),
    inputTokens: tokenCount.optional(),
    outputTokens: tokenCount.optional(),
    cacheWriteTokens: tokenCount.optional(),
    cacheReadTokens: tokenCount.optional(),
    usage5h: usageReading,
    usageWeekly: usageReading,
  })
  .strict();

const inputSchema = z
  .object({
    /**
     * Whose calls these are. §10: `session_id` is "Always present", and it
     * is the only field tying a ghost session's rows together at all.
     *
     * **On the envelope, not on each record.** A flush is one session's
     * work: the records in it were produced by one hook process, in one
     * session, and hoisting the field says so structurally rather than
     * trusting every record in the array to repeat the same value. It also
     * makes the assignment lookup once-per-request rather than
     * once-per-record — the difference between one query and up to 500.
     *
     * A client whose spool spans sessions groups by session and posts once
     * per group; that is a grouping the client can do for free while
     * building the batch, and it is cheaper there than a per-record lookup
     * is here.
     */
    sessionId: z.string().min(1),
    calls: z.array(recordSchema).min(1).max(MAX_BATCH_SIZE),
  })
  .strict();

export type RecordToolCallsInput = z.infer<typeof inputSchema>;

export interface RecordToolCallsOutput {
  /** How many rows were written. Equals `calls.length` — the write is all-or-nothing inside the call's transaction. */
  readonly recorded: number;
  /**
   * The session these rows were stored under.
   *
   * Echoed back because it is **capped** on the way in
   * (`MAX_SESSION_ID_CHARS`), so a client sending an over-long id needs to
   * know which key its rows actually landed on — otherwise it would look
   * for them under the id it sent and find nothing.
   */
  readonly sessionId: string;
  /** The assignment these rows were attributed to, or null for a ghost session. */
  readonly assignmentId: string | null;
  readonly itemId: string | null;
  /** The item state stamped on every row in this batch, or null for a ghost session. */
  readonly stateAt: string | null;
  /**
   * How many stored fields were shortened by a cap, across the whole batch.
   *
   * Returned rather than kept internal so a client can see its payloads are
   * being clipped without reading the table back. A number that climbs
   * steadily is a hook sending file bodies where it means to send commands
   * — a bug otherwise completely silent, because a truncated row looks
   * exactly like a small one from the client's side.
   */
  readonly truncatedFields: number;
}

interface LiveAssignmentRow {
  readonly id: string;
  readonly itemId: string;
  readonly state: string;
}

/**
 * The session's live assignment and the item's state right now, or null
 * when the session holds nothing.
 *
 * One query rather than two: the state is only ever wanted for the item the
 * assignment points at, and a second round trip would widen the window in
 * which the item transitions between the two reads — stamping a batch with
 * a state the item was never in while these calls happened.
 *
 * **`ORDER BY claimedAt DESC` is load-bearing, not cosmetic.** A session
 * can hold more than one live assignment, and this decides which item the
 * whole batch attributes to — so the wrong order puts a run's cost against
 * the wrong item, on every row, which is #53's cost-per-stage attribution.
 * Newest wins because the most recently claimed item is the one the session
 * is working on now, and these records describe what it is doing now.
 */
async function liveAssignment(
  db: TransactionHandle,
  sessionId: string,
): Promise<LiveAssignmentRow | null> {
  const rows = await db.$queryRawUnsafe<LiveAssignmentRow[]>(
    `SELECT a."id", a."itemId", i."state"::text AS "state"
     FROM "Assignment" a
     JOIN "Item" i ON i."id" = a."itemId"
     WHERE a."sessionId" = $1 AND a."releasedAt" IS NULL
     ORDER BY a."claimedAt" DESC
     LIMIT 1`,
    sessionId,
  );
  return rows[0] ?? null;
}

export const recordToolCalls = defineOperation({
  name: "record_tool_calls",
  kind: "write",
  summary: "Records a batch of tool calls as telemetry, with the item's state at the time.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: RecordToolCallsInput): Promise<RecordToolCallsOutput> {
    // Capped before it is used, not merely before it is stored. This is an
    // index key (`ToolCall_sessionId_ts_idx`), so an uncapped id that
    // differs from another only past the cap would split one session's
    // telemetry across two keys — a wrong measurement rather than an
    // expensive one — and the lookup below must use the same value the rows
    // are written under or the attribution and the rows disagree.
    const sessionId = capText(input.sessionId, MAX_SESSION_ID_CHARS);
    let truncatedFields = sessionId === input.sessionId ? 0 : 1;

    const live = await liveAssignment(ctx.db, sessionId);

    for (const call of input.calls) {
      const tool = capText(call.tool, MAX_TOOL_CHARS);
      if (tool !== call.tool) truncatedFields += 1;

      const rawCommand = call.command ?? null;
      const command = rawCommand === null ? null : capText(rawCommand, MAX_COMMAND_CHARS);
      if (command !== rawCommand) truncatedFields += 1;

      const rawPaths = call.paths ?? [];
      const paths = capPaths(rawPaths);
      // One count for the list, however many ways it was cut: a caller
      // acting on this number wants "is this payload too big", not a tally
      // of individual entries, and counting per entry would let one wide
      // glob dwarf every other signal in the figure.
      if (rawPaths.length > MAX_PATHS || paths.some((path, index) => path !== rawPaths[index])) {
        truncatedFields += 1;
      }

      await ctx.db.$executeRawUnsafe(
        `INSERT INTO "ToolCall"
           ("sessionId", "assignmentId", "itemId", "ts", "tool", "command", "paths",
            "stateAt", "inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens",
            "usage5h", "usageWeekly")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"ItemState", $9, $10, $11, $12, $13, $14)`,
        sessionId,
        live?.id ?? null,
        live?.itemId ?? null,
        call.ts,
        tool,
        command,
        paths,
        live?.state ?? null,
        call.inputTokens ?? 0,
        call.outputTokens ?? 0,
        call.cacheWriteTokens ?? 0,
        call.cacheReadTokens ?? 0,
        call.usage5h ?? null,
        call.usageWeekly ?? null,
      );
    }

    return {
      recorded: input.calls.length,
      sessionId,
      assignmentId: live?.id ?? null,
      itemId: live?.itemId ?? null,
      stateAt: live?.state ?? null,
      truncatedFields,
    };
  },
});

export { MAX_BATCH_SIZE };
