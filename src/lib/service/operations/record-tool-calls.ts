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
import { costForModel } from "@/lib/telemetry/pricing";
import {
  UNREPORTED,
  attribute,
  openRun,
  persistRun,
  pricesFrom,
  type RunOwner,
  type RunState,
} from "../telemetry/runs";

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
 * `model` and `effort` are accepted and are **not stored on this table**.
 * §11 is explicit on both halves: they are not columns here ("two strings
 * on ~450k rows a year buys little"), and the feature "requires the hook to
 * report model and effort on every call, or a `/model` switch is invisible
 * and the run silently spans both". They are read to decide run boundaries
 * (`../../telemetry/run-boundary`) and then discarded, which is why a
 * `ToolCall` row has no trace of them and a `Run` row does.
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
    /**
     * The exact vendor model ID that served this call, and the effort it ran
     * at, when the agent tool reported them.
     *
     * **Nullable as well as optional**, because the hook's own reader treats
     * an unreadable field as absent rather than as a refusal, and a client
     * that serialises "nothing" as an explicit `null` must not have its
     * whole batch rejected for saying the same thing a different way. Both
     * collapse to "not reported" at the boundary decision.
     *
     * Bounded by the tool name's cap rather than one invented for them: a
     * vendor model ID is the same shape and order of length as an
     * MCP-namespaced tool name, and it is the bound the spool already
     * applies, so a value that arrives uncapped is one this server capped
     * where the client did not.
     */
    model: z.string().max(MAX_TOOL_CHARS).nullable().optional(),
    effort: z.string().max(MAX_TOOL_CHARS).nullable().optional(),
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
  /**
   * The runs this batch touched, in the order they were opened or extended.
   *
   * Returned because a client has no other way to see the boundary
   * decisions its own reports caused. A flush that reports two models
   * produces two entries here, which is how a hook author confirms the
   * field is being read at all — the alternative is inferring it from a
   * table they may not be able to query.
   *
   * Empty for a ghost session: §11 defines a run as "one agent's turn on
   * one item", so work with no item has calls but no runs.
   */
  readonly runs: readonly RunTouch[];
}

/** One run this batch opened or added calls to. */
export interface RunTouch {
  readonly id: string;
  /** True when this batch opened it, false when it was already open. */
  readonly opened: boolean;
  /** The run's model after this batch, or null if nothing has ever reported one. */
  readonly model: string | null;
  readonly effort: string | null;
  /** Calls from *this batch* attributed to it — not the run's lifetime total. */
  readonly calls: number;
  /**
   * The run's cost after this batch, or null when its model has no rate in
   * `pricing.model_prices`. Recomputed from the run's accumulated counts on
   * every batch rather than incremented, so the stored figure is always the
   * one the current price table produces for the counts beside it.
   */
  readonly cost: number | null;
}

interface LiveAssignmentRow {
  readonly id: string;
  readonly itemId: string;
  readonly state: string;
}

/**
 * The session's live assignment and the item's state right now, or null
 * when the session holds nothing — **and, as the same statement, the stamp
 * that makes `lastActive` mean what its name says.**
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
 *
 * ── Why the read is an UPDATE ──────────────────────────────────────────
 *
 * SCHEMA.md §2 describes `last_active` as "stamped by the hook on every
 * tool call — free, no agent effort". Until this statement it was not: the
 * only writer in the tree was the `heartbeat` operation, whose own summary
 * told callers it was "usually unnecessary — the hook does it". The hook
 * did not, so for any session that never called `heartbeat` explicitly the
 * column was frozen at the instant of the claim, and every threshold read
 * off it was reasoning about claim age wearing an activity column's name.
 *
 * This is the write that closes that gap, and it is deliberately *here*
 * rather than in a new operation or a second statement:
 *
 *   - **It is the hook's own path.** `record_tool_calls` is what the hook's
 *     spool flushes into, so stamping here is the documented mechanism
 *     ("the hook does it") actually happening, rather than a third signal
 *     invented beside two that do not work.
 *   - **It costs nothing.** The row had to be located anyway to attribute
 *     the batch. `UPDATE ... RETURNING` returns exactly what the `SELECT`
 *     returned, off the same index lookup, so the stamp is free rather than
 *     an added round trip on the highest-volume path in the system.
 *   - **It fires on evidence, not on courtesy.** A tool call is something
 *     the session demonstrably did. `heartbeat` remains available for a
 *     session that wants to say "still here" without making a call, which
 *     is the case it was always actually for.
 *
 * **The `ts` the caller supplied is deliberately NOT used for the stamp.**
 * `CURRENT_TIMESTAMP` is. Every other consumer of `ts` in this operation
 * wants when the call *happened* (the whole reason the field is on the
 * envelope — see the header). `lastActive` answers a different question:
 * "when did the server last hear from this session". A batch flushed now
 * carrying an hour-old `ts` is evidence the session was alive *now*, since
 * something had to be running to flush it. Stamping a call's own timestamp
 * would make a live session look an hour quiet, which is the false negative
 * this stamp exists to prevent — arriving through the very path meant to
 * prevent it.
 *
 * **The `Item` join stays an ordinary join.** Only the assignment is
 * written; `Item` is read for its state exactly as before.
 */
async function liveAssignment(
  db: TransactionHandle,
  sessionId: string,
): Promise<LiveAssignmentRow | null> {
  const rows = await db.$queryRawUnsafe<LiveAssignmentRow[]>(
    `UPDATE "Assignment" a
        SET "lastActive" = CURRENT_TIMESTAMP
       FROM "Item" i
      WHERE a."id" = (
              SELECT a2."id" FROM "Assignment" a2
               WHERE a2."sessionId" = $1 AND a2."releasedAt" IS NULL
               ORDER BY a2."claimedAt" DESC
               LIMIT 1
            )
        AND i."id" = a."itemId"
     RETURNING a."id", a."itemId", i."state"::text AS "state"`,
    sessionId,
  );
  return rows[0] ?? null;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const recordToolCalls = defineOperation({
  name: "record_tool_calls",
  kind: "write",
  summary: "Records a batch of tool calls as telemetry, with the item's state at the time.",
  // Stryker restore all
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

    // The run rollup (#51). Only for a session holding an item: §11 defines
    // a run as "one agent's turn on **one item**", and a ghost session has
    // none — its calls are recorded as `ToolCall` rows and roll up to
    // nothing, which is the honest reading rather than a gap. The token
    // counts survive either way, so unminted work is still measured.
    const prices = pricesFrom(ctx.settings);
    const owner: RunOwner | null =
      live === null
        ? null
        : {
            assignmentId: live.id,
            itemId: live.itemId,
            sessionId,
            stateAt: live.state,
          };
    let run = owner === null ? null : await openRun(ctx.db, owner.assignmentId);
    // Every run this batch opened or extended, keyed by id so a batch that
    // switches model and switches back reports two entries rather than
    // three — the second switch reopens nothing, it cuts a third run, and
    // the map records each distinct run once with its final state.
    const touched = new Map<string, RunState>();

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

      // The boundary decision is per call and cannot be deferred: a model
      // change lands at one specific call, and a decision made once at the
      // end of a batch could not say which calls fell either side of it.
      // What *is* deferred is the run's own row write — see `attribute`.
      if (owner !== null) {
        run = await attribute(
          ctx.db,
          owner,
          run,
          { model: call.model, effort: call.effort },
          {
            inputTokens: call.inputTokens ?? 0,
            outputTokens: call.outputTokens ?? 0,
            cacheWriteTokens: call.cacheWriteTokens ?? 0,
            cacheReadTokens: call.cacheReadTokens ?? 0,
          },
          call.ts,
          prices,
        );
        touched.set(run.id, run);
      }
    }

    // The run still open at the end of the batch is written once, here,
    // rather than on every call. Runs closed mid-batch by a cut were
    // written at the moment they were closed, so every touched run has had
    // its final counts and its recomputed cost stored by the time this
    // returns.
    const runs: RunTouch[] = [];
    for (const state of touched.values()) {
      const cost =
        state.id === run?.id
          ? await persistRun(ctx.db, state, prices)
          : costForModel(
              state.model ?? UNREPORTED,
              {
                inputTokens: Number(state.inputTokens),
                outputTokens: Number(state.outputTokens),
                cacheWriteTokens: Number(state.cacheWriteTokens),
                cacheReadTokens: Number(state.cacheReadTokens),
              },
              prices,
            ).cost;
      runs.push({
        id: state.id,
        opened: state.opened,
        model: state.model,
        effort: state.effort,
        calls: state.callsThisBatch,
        cost,
      });
    }

    return {
      recorded: input.calls.length,
      sessionId,
      assignmentId: live?.id ?? null,
      itemId: live?.itemId ?? null,
      stateAt: live?.state ?? null,
      truncatedFields,
      runs,
    };
  },
});

export { MAX_BATCH_SIZE };
