// `progress_report` — MILESTONES.md #136.
//
// The report is computed here and shaped in `@/lib/progress-report`, which
// carries the argument for why the shape is fixed at all. This module is the
// half that reads: it gathers the facts the server already holds and maps
// them into the rows, and its job is to gather them **honestly**.
//
// ── The PR link, and why it is read rather than composed ────────────────
//
// The row asks for a link to the open PR. That is now a recorded fact: a
// `pull_request` artifact carries the URL in `ref`, written by whoever opened
// the PR, and this module reads the newest one per item. It links only when
// that row says `open` and carries an http(s) URL, and otherwise falls back
// to the branch — the full argument for recording over composing is in
// `@/lib/pull-requests`, and the short version is that `repo` + `branch` are
// present whether a PR is open, closed or never opened, so a composed URL
// would be a confident link to nothing in two cases out of three.
//
// A report is trusted precisely because a reader does not have to audit it,
// so a fabricated link is more damaging than an absent one.
//
// ── One thing the row asks for that the schema still does not have ──────
//
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
import { NOT_ARCHIVED_CONDITION } from "../items/row";
import { countsAsWork, deriveOpenLoops } from "@/lib/open-loops";
import { groupLoopEventsByItem, loopEventsForMany } from "./loop-shared";
import {
  DONE_STATES,
  MAX_FLAGS_PER_REPORT,
  applyFlagBudget,
  renderProgressReport,
  summarise,
  type ProgressReport,
  type ProgressRow,
} from "@/lib/progress-report";
import { isLinkableUrl, pullRequestStatusOf } from "@/lib/pull-requests";

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

/** The newest `pull_request` artifact per item: its URL and its status. */
interface RawPullRequestRow {
  itemId: string;
  ref: string | null;
  body: string | null;
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

// The two rules below are anchored on `sessionId` rather than on the output
// fields they describe (`flags`, `reference`). A contract's `fields` name the
// INPUT a rule is read against, so that a caller who has just been refused
// finds the rule by matching on what they sent — `tests/describe-tool.test.ts`
// enforces it. Neither behaviour has an input that switches it on, so both
// belong to the call as a whole.
//
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
    "A progress report on everything this session holds, in one fixed shape: a numbered row per item linking to its open PR (or naming its branch), with its state, its blocker, and two or three bullets on what is done and what is left.",
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
      {
        fields: ["sessionId"],
        rule: `Sub-bullets are the report's emphasis, so they are budgeted rather than merely advised against: at most ${MAX_FLAGS_PER_ROW} per row and at most ${MAX_FLAGS_PER_REPORT} across the whole report, spent in row order. They are not authored — they are the item's OPEN LOOPS, so the way to raise one is \`loop_add\` and the way to clear one is \`loop_close\`. Anything either cap withholds is counted at the foot of the report and listed in full by \`open_loops\`, so a dropped flag is never silent.`,
      },
      {
        fields: ["sessionId"],
        rule: "A row links to its pull request only when a `pull_request` artifact has been recorded for the item, is the newest one, and carries an http(s) URL in `ref`; otherwise it falls back to the branch and then to the item id. The report never composes a PR URL from the repo and branch, so record one with `record_artifact` when you open it — and record a PR that closes as a NEW `pull_request` artifact whose `body` is `closed`, since artifacts are append-only.",
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
       -- Archived rows never appear in a report (MILESTONES.md #137), and
       -- this is the read where it matters most: a progress report's whole
       -- value is being trusted without audit, so one row in it that the
       -- reader cannot open costs the credibility of every other row.
       JOIN "Item" i ON i."id" = a."itemId"
       WHERE a."sessionId" = $1 AND a."releasedAt" IS NULL AND i.${NOT_ARCHIVED_CONDITION}
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
    const prUrls = new Map<string, string>();

    if (itemIds.length > 0) {
      // The newest `pull_request` artifact per item, and only that one.
      // Artifacts are append-only, so a PR that closed is a NEWER row saying
      // `closed` rather than an edit to the row that opened it — which makes
      // "is there a live PR right now" this single-row read, while the whole
      // history of an item's PRs survives underneath it.
      //
      // Ordered by `createdAt` and NOT by `id`, which is the one thing that
      // differs from the checkpoint lookup above. `Event.id` is a sequence,
      // so ordering an event by id really is newest-last; `Artifact.id` is a
      // **random uuid**, so the same ORDER BY would pick an arbitrary row and
      // the report would link to a closed PR roughly half the time.
      //
      // **`closed` wins a same-millisecond tie, and that is the second
      // ordering term rather than the third.** `createdAt` is
      // `Timestamptz(3)`, so two artifacts written back-to-back genuinely do
      // land on the same millisecond — measured at 75% of back-to-back
      // writes on one machine — and with a random uuid as the only
      // tie-break, an open/closed pair at one timestamp resolved to the
      // CLOSED row 51% of the time. That is the same coin flip the `id DESC`
      // fix was meant to end, narrowed to a tie rather than removed.
      //
      // Ranking `closed` above `open` at equal timestamps is the safe
      // direction on purpose: the two ways to be wrong are not symmetric.
      // Suppressing a link for a PR that is really open costs a reader one
      // extra click to the branch — the fallback this report already renders
      // whenever no PR was recorded. Emitting a link for a PR that is really
      // closed is the dead link §6a-pr promises never to emit, and a reader
      // who clicks one stops trusting the links that work. So a tie resolves
      // to the pessimistic reading, deterministically, in the same order on
      // every machine and every run.
      //
      // `seq DESC` stays as the last term so the ordering is a total one: two
      // rows with the same timestamp AND the same status still need a stable
      // winner, and either is equally correct because they say the same
      // thing. `seq`, not `id` — `Artifact.id` is a random uuid and not an
      // insertion-order tiebreak (see `artifact-tip.ts`'s `currentTipCommitSha`
      // doc); this site was found during the sweep that fixed the load-bearing
      // ones and switched for consistency, not because a tie here could pick
      // a wrong answer — the two rows reaching this term already agree on
      // both timestamp and closed/open status.
      const prRows = await ctx.db.$queryRawUnsafe<RawPullRequestRow[]>(
        `SELECT DISTINCT ON ("itemId") "itemId", "ref", "body"
           FROM "Artifact"
          WHERE "itemId" = ANY($1) AND "kind" = 'pull_request'::"ArtifactKind"
          ORDER BY "itemId", "createdAt" DESC,
                   (CASE WHEN btrim(COALESCE("body", '')) = 'closed' THEN 0 ELSE 1 END) ASC,
                   "seq" DESC`,
        itemIds,
      );
      for (const row of prRows) {
        // Three conditions, each of which independently means "do not link":
        // the newest row says the PR closed; the row carries no URL; the URL
        // is not an http(s) address. The write path refuses the latter two,
        // so they can only arrive on a row written before that guard existed
        // — which is exactly when a report is most at risk of rendering
        // something dead, so they are checked at the read as well.
        if (pullRequestStatusOf(row.body) !== "open") continue;
        if (!isLinkableUrl(row.ref)) continue;
        prUrls.set(row.itemId, row.ref!.trim());
      }
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
            -- "What is left" counts work somebody still has to do, so an
            -- archived child is not one of them.
            AND ${NOT_ARCHIVED_CONDITION}
            AND "state" NOT IN ('merged', 'research_done', 'wont_do', 'cancelled')
          GROUP BY "parentId"`,
        itemIds,
      );
      for (const row of childRows) {
        openChildren.set(row.parentId, Number(row.openChildren));
      }

      // Every event in a loop's lifecycle, folded per item by the same pure
      // function `orientation` uses — so "which loops are open" has one
      // definition rather than one per reader.
      //
      // Read through `loopEventsForMany` rather than with a local statement:
      // the fold is only correct when handed the *complete* slice, and a
      // hand-written `IN` list that omits a type does not fail loudly. It
      // reports a deleted loop as still open and serves an edited loop with
      // its superseded text — which is precisely what this call site did
      // while every test stayed green.
      const loopRows = await loopEventsForMany(ctx, itemIds);
      for (const [itemId, events] of groupLoopEventsByItem(loopRows)) {
        // Notes are excluded here for the reason `orientation` excludes
        // them: this is a progress read, and a loose-end list padded with
        // references and status markers overstates what is outstanding.
        // `blocked_on_person` is kept — `countsAsWork` treats a loop
        // waiting on a human as work, because it is the most pending thing
        // an item can carry.
        loops.set(
          itemId,
          deriveOpenLoops(events)
            .filter((loop) => countsAsWork(loop.kind))
            .map((loop) => loop.text),
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
      reference: { prUrl: prUrls.get(row.id) ?? null, branch: row.branch, itemId: row.id },
      blockedOn: blockedOnFor(row),
      bullets: bulletsFor(row, checkpoints.get(row.id) ?? null, openChildren.get(row.id) ?? 0),
      // The per-row cap. What it drops is counted below rather than
      // discarded, because a flag withheld by THIS cap is exactly as invisible
      // to a reader as one withheld by the report budget — and the whole
      // argument for announcing truncation is that a silently dropped flag is
      // worse than one too many.
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

    // The report-level flag budget, spent after filtering rather than before.
    // Spending it on rows that are then dropped would let completed work
    // consume the budget of the in-flight work the reader actually asked
    // about — the flags would be withheld from the rows that matter, and the
    // footer would explain a truncation the reader could not see the cause of.
    const budgeted = applyFlagBudget(listed);

    // What the PER-ROW cap dropped, counted over the rows that are actually
    // listed — a row filtered out as completed withheld nothing a reader
    // could have seen, so counting it would explain a truncation with no
    // visible cause. Added to the report budget's own count so the foot of
    // the report states one number for "flags you are not seeing", which is
    // the only figure a reader can act on: both caps are equally invisible
    // from the outside, and `open_loops` shows everything either of them hid.
    const withheldByRowCap = listed.reduce((sum, row) => {
      const all = loops.get(row.itemId)?.length ?? 0;
      return sum + Math.max(0, all - MAX_FLAGS_PER_ROW);
    }, 0);

    return {
      sessionId: input.sessionId,
      rows: budgeted.rows,
      summary,
      report: renderProgressReport(budgeted.rows, summary, budgeted.withheld + withheldByRowCap),
    };
  },
});
