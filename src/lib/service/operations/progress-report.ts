// `progress_report` — MILESTONES.md #136.
//
// The report is computed here and shaped in `@/lib/progress-report`, which
// carries the argument for why the shape is fixed at all. This module is the
// half that reads: it gathers the facts the server already holds and maps
// them into the rows, and its job is to gather them **honestly**.
//
// ── Two things the row asks for that the schema does not have ───────────
//
// The row describes a link to the open PR and a blocked-on drawn from the
// dependency graph. Neither exists, and inventing them would be the worse
// failure — a report is trusted precisely because a reader does not have to
// audit it, so a fabricated link is more damaging than an absent one.
//
//   - **No PR field.** Nothing in the schema stores a pull-request number or
//     URL. The row's own parenthetical allows the alternative — "(or branch
//     name)" — so a row references `Item.branch`, falling back to the item id,
//     which is the thing a reader can always act on. When a PR reference is
//     stored one day, this is the one function that changes.
//   - **No dependency graph.** There is no item-to-item edge anywhere. What
//     exists is what an item records about *itself* when it is stopped:
//     `blockedReason` with `blockedOnType`, and `pauseReason` with
//     `resumeCondition`. That is a narrower answer than a graph would give,
//     and it is the true one, so it is what the row carries.
//
// ── Where the bullets come from ─────────────────────────────────────────
//
// Not from asking a session to write them — that is the variance the row
// exists to remove. They are read from what sessions already recorded:
//
//   - the newest **checkpoint** headline, which is a one-line statement of
//     where the work got to, written when it got there;
//   - **open loops**, which become the sub-bullets. SCHEMA.md §3a defines a
//     loop as a loose end a session is carrying, and that is exactly the
//     "the decision was controversial, option B is still viable" line the
//     format exists to surface. Reserving sub-bullets for loops is what keeps
//     them sparing without anyone having to judge sparingness.
//   - **actionable children**, counted, which is "what is left" for a row
//     that has any.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { checkpointHeadline } from "../items/checkpoint-headline";
import { deriveOpenLoops, type LoopEventLike } from "@/lib/open-loops";
import {
  DONE_STATES,
  renderProgressReport,
  summarise,
  type ProgressReport,
  type ProgressRow,
} from "@/lib/progress-report";

/**
 * How many sub-bullets one row may carry.
 *
 * "Use sparingly" made concrete. A cap rather than a convention because the
 * source is a list that grows on its own — an item accumulating nine open
 * loops would otherwise bury the eight rows around it, and the report's whole
 * claim is that it can be read at a glance.
 */
export const MAX_FLAGS_PER_ROW = 2;

const inputSchema = z
  .object({
    sessionId: z.string().min(1),
    /**
     * Include work this session has finished, which is off by default.
     *
     * A progress report answers "where is everything I am working on", so an
     * item this session finished is history and has its own reads — a session
     * running for a week would otherwise report mostly on work nobody is
     * asking about. The summary counts finished work either way, so nothing
     * disappears silently; this only decides whether it is listed.
     *
     * The same posture as the board's default slice: the useful answer to an
     * unqualified "how is it going" is open work, and everything else is
     * asked for explicitly.
     */
    includeCompleted: z.boolean().default(false),
  })
  .strict();

export type ProgressReportInput = z.infer<typeof inputSchema>;

/** One item this session holds, as the report's query returns it. */
interface RawProgressRow {
  id: string;
  title: string;
  state: string;
  branch: string | null;
  blockedReason: string | null;
  blockedOnType: string | null;
  pauseReason: string | null;
  resumeCondition: string | null;
}

interface RawCheckpointRow {
  itemId: string;
  headline: string | null;
  body: string | null;
}

interface RawChildRow {
  parentId: string;
  openChildren: bigint | number;
}

interface RawLoopRow extends LoopEventLike {
  itemId: string;
}

/**
 * What is stopping this row, in a reader's words.
 *
 * `blockedReason` is prose a person wrote, so it is used as it stands; the
 * type is appended only when it adds something the prose cannot be assumed to
 * carry — who or what the wait is on.
 */
function blockedOnFor(row: RawProgressRow): string | null {
  if (row.state === "blocked") {
    const reason = row.blockedReason ?? "something unrecorded";
    return row.blockedOnType === null ? reason : `${reason} (${row.blockedOnType})`;
  }
  if (row.state === "paused") {
    const reason = row.pauseReason ?? "something unrecorded";
    return row.resumeCondition === null ? reason : `${reason}; resumes when ${row.resumeCondition}`;
  }
  return null;
}

/**
 * The lines of "what is done and what is left" for one row.
 *
 * Every entry is something a session recorded at the time, never something
 * composed here — see the module header. The specification allows two or
 * three; this produces at most two, and there is deliberately **no cap
 * applied** on the way out. A `slice` here would be unreachable code, because
 * the count is bounded by the branches below rather than by the data: a row
 * has at most one newest checkpoint and at most one child count. A guard that
 * cannot fire is untestable by construction, and reads as protection that
 * is not there. A third source of bullets is the change that would need one.
 */
function bulletsFor(
  row: RawProgressRow,
  checkpoint: string | null,
  openChildren: number,
): string[] {
  const bullets: string[] = [];

  if (checkpoint !== null) {
    bullets.push(checkpoint);
  }
  if (openChildren > 0) {
    bullets.push(`${openChildren} open ${openChildren === 1 ? "subtask" : "subtasks"} remaining.`);
  }
  // Said only when there is nothing else to say. A row with a checkpoint and
  // open children has already told the reader where it is; repeating the
  // state it printed on its own line would be the noise the cap exists for.
  if (bullets.length === 0) {
    bullets.push(`No checkpoint recorded yet; the item sits at ${row.state}.`);
  }

  return bullets;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const progressReport = defineOperation({
  name: "progress_report",
  kind: "read",
  summary:
    "A progress report on everything this session holds, in one fixed shape: a numbered row per item with its branch, state and blocker, and two or three bullets on what is done and what is left.",
  contract: {
    rules: [
      {
        fields: ["sessionId"],
        rule: "The report covers the items this session holds a live claim on. A session holding nothing gets an empty report rather than a refusal — holding nothing is a real answer to 'how is it going'.",
      },
      {
        fields: ["includeCompleted"],
        rule: "Completed work is omitted by default and still counted in the summary line. Pass `includeCompleted: true` to list it.",
      },
    ],
    example: { sessionId: "a-session-id" },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ProgressReportInput): Promise<ProgressReport> {
    // Named columns rather than `i.*`: this is a read, and the bounded-read
    // assertion applies to it. `body` and `customFields` are the two columns
    // that made an unbounded item read overflow, and a report has no use for
    // either.
    const rows = await ctx.db.$queryRawUnsafe<RawProgressRow[]>(
      `SELECT
         i."id", i."title", i."state", i."branch",
         i."blockedReason", i."blockedOnType", i."pauseReason", i."resumeCondition"
       FROM "Assignment" a
       JOIN "Item" i ON i."id" = a."itemId"
       WHERE a."sessionId" = $1 AND a."releasedAt" IS NULL
       ORDER BY a."claimedAt" ASC`,
      input.sessionId,
    );

    // One row per item needs no deduplication here, and the reason is worth
    // stating because the opposite is easy to assume: several sessions work
    // one item at once (SCHEMA.md §2), so a *item*-keyed join would duplicate
    // — but this join is keyed on one session, and the partial unique index
    // `Assignment_one_live_row_per_session_per_item` makes one live row per
    // session per item a database-level guarantee. A defensive fold here
    // would be unreachable code guarding an invariant Postgres already
    // enforces, and unreachable code is untestable by construction.
    //
    // This is where `my_work` and this report legitimately differ: its
    // subject is the assignment, so it returns one row per assignment and a
    // session holding an item in two roles would show twice there. That
    // cannot arise for one session either, for the same index.
    const held = rows;
    const itemIds = held.map((row) => row.id);

    // Three lookups over the whole set rather than three per row: a session
    // holding twelve items would otherwise cost thirty-seven round trips for
    // a read whose entire purpose is to be cheap enough to ask constantly.
    const checkpoints = new Map<string, string | null>();
    const openChildren = new Map<string, number>();
    const loops = new Map<string, string[]>();

    if (itemIds.length > 0) {
      // `DISTINCT ON` takes the newest checkpoint per item in one pass — the
      // same single-row-per-item read `orientation` does, widened to a set.
      const checkpointRows = await ctx.db.$queryRawUnsafe<RawCheckpointRow[]>(
        `SELECT DISTINCT ON ("itemId") "itemId", "headline", "body"
           FROM "Event"
          WHERE "itemId" = ANY($1) AND "type" = 'checkpoint'::"EventType"
          ORDER BY "itemId", "id" DESC`,
        itemIds,
      );
      for (const row of checkpointRows) {
        checkpoints.set(row.itemId, checkpointHeadline(row));
      }

      // "What is left", counted. The excluded states are the ones that mean
      // a child needs nobody — the same split `orientation` applies when it
      // decides which children are actionable.
      const childRows = await ctx.db.$queryRawUnsafe<RawChildRow[]>(
        `SELECT "parentId", COUNT(*) AS "openChildren"
           FROM "Item"
          WHERE "parentId" = ANY($1)
            AND "state" NOT IN ('merged', 'research_done', 'wont_do', 'cancelled')
          GROUP BY "parentId"`,
        itemIds,
      );
      for (const row of childRows) {
        openChildren.set(row.parentId, Number(row.openChildren));
      }

      // Both halves of every loop pair, folded per item by the same pure
      // function `orientation` uses — so "which loops are open" has one
      // definition rather than one per reader.
      const loopRows = await ctx.db.$queryRawUnsafe<RawLoopRow[]>(
        `SELECT "itemId", "id", "ts", "type", "payload"
           FROM "Event"
          WHERE "itemId" = ANY($1)
            AND "type" IN ('open_loop'::"EventType", 'open_loop_closed'::"EventType")
          ORDER BY "id" ASC`,
        itemIds,
      );
      const byItem = new Map<string, RawLoopRow[]>();
      for (const row of loopRows) {
        const list = byItem.get(row.itemId);
        if (list === undefined) byItem.set(row.itemId, [row]);
        else list.push(row);
      }
      for (const [itemId, events] of byItem) {
        loops.set(
          itemId,
          deriveOpenLoops(events).map((loop) => loop.text),
        );
      }
    }

    // The summary counts everything held, including finished work, so the
    // headline figure does not change depending on a filter. The list below
    // is what the filter applies to.
    const allRows: ProgressRow[] = held.map((row, index) => ({
      n: index + 1,
      itemId: row.id,
      title: row.title,
      state: row.state,
      reference: { branch: row.branch, itemId: row.id },
      blockedOn: blockedOnFor(row),
      bullets: bulletsFor(row, checkpoints.get(row.id) ?? null, openChildren.get(row.id) ?? 0),
      flags: (loops.get(row.id) ?? []).slice(0, MAX_FLAGS_PER_ROW),
    }));

    const summary = summarise(allRows);

    // Renumbered after filtering so the numbers a reader sees run 1..n with
    // no gaps — the number is a handle for conversation, and a list that
    // skips from 2 to 5 invites the question "where are 3 and 4?", which is
    // the opposite of what the numbering is for.
    const listed = input.includeCompleted
      ? allRows
      : allRows
          // `DONE_STATES` from the shared module rather than a second list
          // spelled here, so "done" cannot come to mean two things in one
          // report — the summary counts by it and the filter drops by it.
          .filter((row) => !DONE_STATES.has(row.state))
          .map((row, index) => ({ ...row, n: index + 1 }));

    return {
      sessionId: input.sessionId,
      rows: listed,
      summary,
      report: renderProgressReport(listed, summary),
    };
  },
});
