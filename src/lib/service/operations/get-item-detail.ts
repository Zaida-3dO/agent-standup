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
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";
// `columnForProject` rather than a local copy of the same rule: its own
// header says the mapping lives in one place so `get_board` and every other
// reader cannot drift apart on it, and a project's column on the detail
// view has to be the column the board shows for that same project.
import { columnForProject, columnForState, type BoardColumn } from "../board/columns";
import type { ItemStateValue } from "../state-machine/states";

const inputSchema = z
  .object({
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
  /** `person` or `agent` — who produced this artifact. See the select in the handler for why it is surfaced. */
  readonly createdByType: string;
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
  createdByType: string;
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
  summary: "One item in full: its subtask tree, artifacts, history, and completion summary.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetItemDetailInput): Promise<ItemDetailOutput> {
    const itemRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      input.id,
    );
    const itemRow = itemRows[0];
    if (!itemRow) {
      throw new NotFoundError(`No such item: ${input.id}.`, { fields: ["id"] });
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
    const subtreeRows = await ctx.db.$queryRawUnsafe<RawSubtreeRow[]>(
      `WITH RECURSIVE subtree AS (
         SELECT i."id", i."parentId", i."title", i."kind", i."state", i."priority",
                1 AS "depth",
                ARRAY[to_char(i."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') || i."id"] AS "path"
         FROM "Item" i WHERE i."parentId" = $1
         UNION ALL
         SELECT i."id", i."parentId", i."title", i."kind", i."state", i."priority",
                s."depth" + 1,
                s."path" || (to_char(i."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') || i."id")
         FROM "Item" i JOIN subtree s ON i."parentId" = s."id"
       )
       SELECT "id", "parentId", "title", "kind", "state", "priority", "depth"
       FROM subtree ORDER BY "path" ASC`,
      input.id,
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
              "commitSha", "ref", "body", "findings", "createdByType"::text AS "createdByType",
              "createdAt"
       FROM "Artifact" WHERE "itemId" = $1
       ORDER BY "reviewRound" ASC, "createdAt" ASC`,
      input.id,
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
      createdByType: row.createdByType,
      createdAt: row.createdAt.toISOString(),
    }));

    // History, newest first and capped. Read one row beyond the cap so
    // "there is more" is a fact rather than an inference from a full page —
    // a page that happens to be exactly `historyLimit` long is genuinely
    // ambiguous otherwise.
    const historyRows = await ctx.db.$queryRawUnsafe<RawHistoryRow[]>(
      `SELECT "id", "ts", "type"::text AS "type", "actorType"::text AS "actorType",
              "actorId", "sessionId", "body", "payload"
       FROM "Event" WHERE "itemId" = $1
       ORDER BY "id" DESC LIMIT $2`,
      input.id,
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
      }));

    const summaryRows = await ctx.db.$queryRawUnsafe<RawSummaryRow[]>(
      `SELECT "shipped", "notDone", "userFacing", "whatToTest", "howVerified",
              "watchFor", "finalState", "createdAt"
       FROM "Summary" WHERE "itemId" = $1`,
      input.id,
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

    return { item, column, subtasks, artifacts, history, historyTruncated, summary };
  },
});
