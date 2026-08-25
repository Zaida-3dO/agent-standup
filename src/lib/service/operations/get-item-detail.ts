// `get_item_detail` — everything one item's detail view shows in a single
// read: the item, its subtask tree, its artifacts, its history, and the
// summary it was completed with. MILESTONES.md #72.
//
// **Why this is a new operation rather than four calls the client makes.**
// The four things #72 names are one screen and one question ("what is the
// state of this piece of work"), and a client assembling them from four
// round trips would be reading them at four different instants — a subtask
// completing between call two and call three yields a screen whose tree and
// whose history disagree. Reading them inside one service call reads them
// inside one transaction (`context.ts`), so the screen is a consistent
// snapshot rather than four independently-fresh fragments. It is also the
// only shape an adapter can serve, because an adapter is a thin shell over
// **one** service call (CLAUDE.md) — four reads would have to become four
// endpoints, and the consistency would then be genuinely unobtainable.
//
// **History here is the newest window; `get_item_history` pages past it
// (T24).** The `historyLimit` cap below is deliberate and stays — this read
// exists to deliver one coherent snapshot of a whole screen, and an
// unbounded ledger inside it would make the most detailed read in the
// product also the one most likely to fail on payload size. Entries past
// the cap are reached through `get_item_history`, a keyset-paged read of
// the same table that the detail view calls on demand. `historyTruncated`
// is the fact that says whether any exist. See that operation's header for why it is a
// separate read with a per-page snapshot rather than an offset threaded
// through this payload — the consistency trade is the substance of it.
//
// **The subtree is recursive, not one level.** `kind`'s nesting is
// unbounded (SCHEMA.md §1) and #72 asks for a *tree*. `orientation` reads
// direct children only, which is right for its question ("what still needs
// attention right now") and wrong for this one. The walk is the same
// recursive CTE `get_board` uses to derive a project's column, carrying a
// depth so the client can indent without reconstructing the parent chain
// itself.
//
// **A project's own `state` is not reported as meaningful.** DECISIONS.md
// §13c: a project's state is a creation leftover, its real column derives
// from its children. So this operation returns `derivedColumn` for the
// root — computed here, server-side, from the subtree it has already
// walked — and the client renders that rather than recomputing a derivation
// it cannot reproduce (the convention #37's review established: the client
// reads what the server derived).
//
// **Ownership, current and past (F7).** This read is the one screen that can
// answer "where is this work actually happening", so it returns the *whole*
// assignment row — machine, branch, worktree, model, effort, session, pid —
// where a board card gets seven scalars (`items/assignment-view.ts`).
//
// It returns **previous holders separately**, and that is the half worth
// stating: a released assignment is the record of who had this item before
// the current holder, which is what makes *"who was on this before it
// stalled"* answerable at all. Nothing else in the store carries it —
// `assignments` is the only table that remembers a session that has since
// let go. Returning live and released in one list with a null check to
// re-split would push that partition onto every reader; returning only the
// live ones would drop the history on the floor.
//
// Both come from **one** statement over the same index, partitioned here,
// because they are the same rows differing only by whether `releasedAt` is
// set — two queries would pay two round trips for one question.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ITEM_COLUMNS,
  NOT_ARCHIVED_CONDITION,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "../items/row";
// `columnForProject` rather than a local copy of the same rule: its own
// header says the mapping lives in one place so `get_board` and every other
// reader cannot drift apart on it, and a project's column on the detail
// view has to be the column the board shows for that same project.
import { resolveItemId } from "../items/resolve-id";
import { columnForProject, columnForState, type BoardColumn } from "../board/columns";
import type { ItemStateValue } from "../state-machine/states";
import {
  ALL_ITEM_ASSIGNMENTS_SQL,
  toItemDetailAssignment,
  type ItemDetailAssignment,
  type RawItemDetailAssignmentRow,
} from "../items/assignment-view";

const inputSchema = z
  .object({
    /**
     * The item's id — a full UUID, or a short id that is a prefix of one
     * (see `../items/resolve-id.ts`).
     */
    id: z.string().min(1),
    /**
     * How many history entries to return, newest first. Bounded because an
     * item that has been worked for weeks has a ledger longer than any
     * screen, and an unbounded default would make the most detailed read in
     * the product also the one most likely to fail on payload size — the
     * failure #103 exists to stop happening elsewhere.
     */
    historyLimit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export type GetItemDetailInput = z.infer<typeof inputSchema>;

/**
 * One node of the subtask tree. Flat with a `depth` rather than nested
 * children arrays: a flat list is what a list view renders directly, it
 * survives a JSON boundary without a recursive type, and the nesting is
 * still fully recoverable from `parentId`. Ordered depth-first by creation
 * so a client can render it top to bottom without sorting.
 */
export interface ItemDetailSubtaskNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly kind: "project" | "task" | "subtask";
  readonly state: string;
  readonly priority: string;
  /** Distance from the root item — 1 for a direct child. The root itself is never in this list. */
  readonly depth: number;
  /**
   * The board column this node's own state maps to, or `null` for a
   * project — whose stored state is a creation leftover (DECISIONS.md
   * §13c) and so maps to nothing honest. Derived here so the client never
   * has to decide when a state may be read and when it may not.
   */
  readonly column: BoardColumn | null;
}

/** One artifact against this item (SCHEMA.md §6a) — a review, a plan, a commit, a screenshot. */
export interface ItemDetailArtifact {
  readonly id: string;
  readonly kind: string;
  readonly verdict: string | null;
  readonly reviewRound: number;
  readonly commitSha: string | null;
  readonly ref: string | null;
  readonly body: string | null;
  readonly findings: unknown;
  /**
   * The item this review's findings were deferred into — set only for
   * `lgtm_with_followups`, which is the one verdict that merges on the
   * promise that the outstanding work is filed somewhere (SCHEMA.md §6a).
   *
   * Surfaced for the same reason `createdByType` is: the whole bargain of
   * that verdict is that the follow-up is real, and a reader deciding
   * whether the merge was honest cannot check a promise they cannot see.
   */
  readonly followUpItemId: string | null;
  /** `person` or `agent` — who produced this artifact. See the select in the handler for why it is surfaced. */
  readonly createdByType: string;
  /**
   * *Which* person or agent produced it — the id, where one was recorded.
   *
   * `createdByType` alone answers "a person or an agent", which is the
   * question the merge gate asks. A reader asking "can I trust this state"
   * is asking a different one — *who* checked — and for a marking whose
   * whole job is to say whether a row can be taken on faith, an anonymous
   * check is most of the way to no check. Nullable because the column is:
   * an artifact can be written without a holder id attached.
   */
  readonly createdById: string | null;
  readonly createdAt: string;
}

/** One history entry — an `events` row, with every bigint stringified for the JSON boundary. */
export interface ItemDetailHistoryEntry {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly body: string | null;
  readonly payload: unknown;
  /**
   * The event's stored one-line BLUF, where it has one — the column
   * `checkpoint` writes (MILESTONES.md #108). Null on every event type that
   * does not carry one, which is most of them.
   *
   * Selected here so a reader holding this payload can reduce the newest
   * checkpoint to a line **by the same precedence rule the server uses**:
   * stored wins, prose is the floor. Without the column a client could only
   * ever derive from `body`, which silently answers with the derivation even
   * where a writer supplied a line — the exact failure
   * `checkpointHeadline`'s own header calls out as caught by one test.
   */
  readonly headline: string | null;
}

/** The summary an item was completed with (SCHEMA.md §5a). Null until it has been completed. */
export interface ItemDetailSummary {
  readonly shipped: unknown;
  readonly notDone: unknown;
  readonly userFacing: boolean;
  readonly whatToTest: unknown;
  readonly howVerified: string | null;
  readonly watchFor: unknown;
  readonly finalState: unknown;
  readonly createdAt: string;
}

export interface ItemDetailOutput {
  readonly item: ItemRecord;
  /**
   * The root item's board column. For a task or subtask this is its own
   * state's column; for a **project** it is derived from the subtree below
   * — the same rule `get_board` applies, applied here so the detail view
   * and the board never disagree about where the same item sits.
   */
  readonly column: BoardColumn;
  /** Every descendant, depth-first, deepest nesting included. Empty for a leaf. */
  readonly subtasks: readonly ItemDetailSubtaskNode[];
  readonly artifacts: readonly ItemDetailArtifact[];
  /** History newest-first, capped at `historyLimit`. */
  readonly history: readonly ItemDetailHistoryEntry[];
  /** True when the ledger has more entries than were returned — so the view can say so rather than imply completeness. */
  readonly historyTruncated: boolean;
  readonly summary: ItemDetailSummary | null;
  /**
   * Who holds this item right now — live assignments (`releasedAt IS NULL`),
   * newest claim first. Empty when nobody does, never absent.
   *
   * An array because one item can be held by several holders at once
   * (SCHEMA.md §2: an orchestrator *plus* a builder *plus* two reviewers).
   */
  readonly assignments: readonly ItemDetailAssignment[];
  /**
   * Who held it before — released assignments, most recent first.
   *
   * The ownership history, and the only place it exists: a released row is
   * the store's sole record of a session that has let go. Kept apart from
   * `assignments` rather than merged and re-split by a null check — see the
   * module header.
   */
  readonly previousHolders: readonly ItemDetailAssignment[];
}

interface RawSubtreeRow {
  id: string;
  parentId: string | null;
  title: string;
  kind: string;
  state: string;
  priority: string;
  depth: number;
}

interface RawArtifactRow {
  id: string;
  kind: string;
  verdict: string | null;
  reviewRound: number;
  commitSha: string | null;
  ref: string | null;
  body: string | null;
  findings: unknown;
  followUpItemId: string | null;
  createdByType: string;
  createdById: string | null;
  createdAt: Date;
}

interface RawHistoryRow {
  id: bigint;
  ts: Date;
  type: string;
  actorType: string;
  actorId: string | null;
  sessionId: string | null;
  body: string | null;
  payload: unknown;
  headline: string | null;
}

interface RawSummaryRow {
  shipped: unknown;
  notDone: unknown;
  userFacing: boolean;
  whatToTest: unknown;
  howVerified: string | null;
  watchFor: unknown;
  finalState: unknown;
  createdAt: Date;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getItemDetail = defineOperation({
  name: "get_item_detail",
  kind: "read",
  summary:
    "One item in full: its subtask tree, artifacts, history, completion summary, who holds it now, and who held it before.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetItemDetailInput): Promise<ItemDetailOutput> {
    // Resolved once, up front, and every query below uses the canonical id.
    // Resolving per-query would mean a short id could match one item for
    // the header read and a different one for the history read if a row
    // were created in between; one resolution makes that impossible.
    const id = await resolveItemId(ctx.db, input.id);

    const itemRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      id,
    );
    const itemRow = itemRows[0];
    if (!itemRow) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }
    const item = toItemRecord(itemRow);

    // The subtask tree. Depth-first ordering is built into the CTE by
    // carrying a path down each branch and sorting on it — ordering by
    // `depth` alone would interleave unrelated branches, which is exactly
    // wrong for a tree the client indents but does not re-nest.
    //
    // **The path is `text[]`, not `timestamptz[]`, and that is not
    // incidental.** A recursive CTE requires the non-recursive term's column
    // types to match the overall type exactly, and `"createdAt"` is
    // `timestamptz(3)` while the `||` in the recursive term widens the array
    // to plain `timestamptz` — Postgres refuses the whole query with 42804
    // rather than coercing. Formatting each step to text sidesteps that, and
    // is sortable in the same order because the format is fixed-width and
    // big-endian.
    //
    // The item's `id` is appended to each step so siblings created inside
    // the same millisecond still have a total order. Without it their
    // relative position would be whatever the plan happened to produce, and
    // a tree that reorders itself between two identical reads is worse than
    // one ordered by something arbitrary but stable.
    // Both arms of the recursion exclude archived rows (MILESTONES.md #137),
    // which prunes an archived item's whole subtree rather than only the row
    // itself. That is the honest reading for a tree: an archived parent's
    // children are reachable in the interface *through* the parent, so
    // showing them under a node the reader cannot see would place them
    // nowhere. The board's own walk filters only its final select instead,
    // because there a descendant contributes a state rather than a position.
    const subtreeRows = await ctx.db.$queryRawUnsafe<RawSubtreeRow[]>(
      `WITH RECURSIVE subtree AS (
         SELECT i."id", i."parentId", i."title", i."kind", i."state", i."priority",
                1 AS "depth",
                ARRAY[to_char(i."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') || i."id"] AS "path"
         FROM "Item" i WHERE i."parentId" = $1 AND i.${NOT_ARCHIVED_CONDITION}
         UNION ALL
         SELECT i."id", i."parentId", i."title", i."kind", i."state", i."priority",
                s."depth" + 1,
                s."path" || (to_char(i."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') || i."id")
         FROM "Item" i JOIN subtree s ON i."parentId" = s."id"
         WHERE i.${NOT_ARCHIVED_CONDITION}
       )
       SELECT "id", "parentId", "title", "kind", "state", "priority", "depth"
       FROM subtree ORDER BY "path" ASC`,
      id,
    );
    const subtasks: ItemDetailSubtaskNode[] = subtreeRows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      title: row.title,
      kind: row.kind as ItemDetailSubtaskNode["kind"],
      state: row.state,
      priority: row.priority,
      depth: Number(row.depth),
      // A project's own state is a creation leftover (DECISIONS.md §13c),
      // so it maps to no column here. A nested project's *derived* column
      // would need its own subtree walk; the detail view indents it as
      // structure and shows no column rather than showing a false one.
      column: row.kind === "project" ? null : columnForState(row.state as ItemStateValue),
    }));

    // The root's own column: derived from the subtree for a project,
    // read directly for anything with a state of its own.
    // Nested projects are excluded from the descendant states, for the same
    // reason their own `column` is null above: a project's stored state is a
    // creation leftover, so feeding it into the derivation would let a
    // sub-project's stale `on_deck` drag the parent into `backlog`. Only
    // items with a real state contribute.
    const column: BoardColumn =
      item.kind === "project"
        ? columnForProject(
            subtreeRows.filter((r) => r.kind !== "project").map((r) => r.state as ItemStateValue),
          )
        : columnForState(item.state as ItemStateValue);

    const artifactRows = await ctx.db.$queryRawUnsafe<RawArtifactRow[]>(
      // `createdByType` is selected because it is the difference between a
      // review a person signed and one an agent wrote, which is the exact
      // question `merge.requires_authorisation` decides a merge on. It was
      // written by one operation and read by one guard, and surfaced to
      // nobody — so the fact that decides whether a merge gate means anything
      // was invisible to every human and agent reading the item back. A
      // record that cannot be read is not an audit trail.
      `SELECT "id", "kind"::text AS "kind", "verdict"::text AS "verdict", "reviewRound",
              "commitSha", "ref", "body", "findings", "followUpItemId",
              "createdByType"::text AS "createdByType", "createdById", "createdAt"
       FROM "Artifact" WHERE "itemId" = $1
       ORDER BY "reviewRound" ASC, "createdAt" ASC`,
      id,
    );
    const artifacts: ItemDetailArtifact[] = artifactRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      verdict: row.verdict,
      reviewRound: Number(row.reviewRound),
      commitSha: row.commitSha,
      ref: row.ref,
      body: row.body,
      findings: row.findings ?? null,
      followUpItemId: row.followUpItemId,
      createdByType: row.createdByType,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
    }));

    // History, newest first and capped. Read one row beyond the cap so
    // "there is more" is a fact rather than an inference from a full page —
    // a page that happens to be exactly `historyLimit` long is genuinely
    // ambiguous otherwise.
    const historyRows = await ctx.db.$queryRawUnsafe<RawHistoryRow[]>(
      `SELECT "id", "ts", "type"::text AS "type", "actorType"::text AS "actorType",
              "actorId", "sessionId", "body", "payload", "headline"
       FROM "Event" WHERE "itemId" = $1
       ORDER BY "id" DESC LIMIT $2`,
      id,
      input.historyLimit + 1,
    );
    const historyTruncated = historyRows.length > input.historyLimit;
    const history: ItemDetailHistoryEntry[] = historyRows
      .slice(0, input.historyLimit)
      .map((row) => ({
        // `id` is a bigint and cannot cross a JSON boundary — `JSON.stringify`
        // throws on one outright rather than truncating, so every bigint is
        // stringified here, the same rule `orientation` follows.
        id: row.id.toString(),
        ts: row.ts.toISOString(),
        type: row.type,
        actorType: row.actorType,
        actorId: row.actorId,
        sessionId: row.sessionId,
        body: row.body,
        payload: row.payload ?? null,
        headline: row.headline,
      }));

    const summaryRows = await ctx.db.$queryRawUnsafe<RawSummaryRow[]>(
      `SELECT "shipped", "notDone", "userFacing", "whatToTest", "howVerified",
              "watchFor", "finalState", "createdAt"
       FROM "Summary" WHERE "itemId" = $1`,
      id,
    );
    const summaryRow = summaryRows[0];
    const summary: ItemDetailSummary | null = summaryRow
      ? {
          shipped: summaryRow.shipped ?? null,
          notDone: summaryRow.notDone ?? null,
          userFacing: summaryRow.userFacing,
          whatToTest: summaryRow.whatToTest ?? null,
          howVerified: summaryRow.howVerified,
          watchFor: summaryRow.watchFor ?? null,
          finalState: summaryRow.finalState ?? null,
          createdAt: summaryRow.createdAt.toISOString(),
        }
      : null;

    // Every assignment on this item, live and released, in one statement —
    // partitioned on `releasedAt` here rather than fetched twice. The
    // predicate is the same one `liveAssignments` in claims.ts enforces on,
    // so this read and the claim machinery cannot disagree about which rows
    // count as current.
    const assignmentRows = await ctx.db.$queryRawUnsafe<RawItemDetailAssignmentRow[]>(
      ALL_ITEM_ASSIGNMENTS_SQL,
      id,
    );
    const assignments: ItemDetailAssignment[] = [];
    const previousHolders: ItemDetailAssignment[] = [];
    for (const row of assignmentRows) {
      const assignment = toItemDetailAssignment(row);
      // Partitioned on the mapped `releasedAt` rather than the raw column so
      // the two lists cannot disagree with the field each row carries.
      (assignment.releasedAt === null ? assignments : previousHolders).push(assignment);
    }

    return {
      item,
      column,
      subtasks,
      artifacts,
      history,
      historyTruncated,
      summary,
      assignments,
      previousHolders,
    };
  },
});
