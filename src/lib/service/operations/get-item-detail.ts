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
import { columnForState, type BoardColumn } from "../board/columns";
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

/**
 * The column a **project** sits in, from the states of its descendants —
 * the same rule `get_board`'s `columnForProject` applies, reached here from
 * the subtree this operation has already walked rather than by walking it a
 * second time.
 *
 * The rule, in priority order: anything actively moving puts the project in
 * `in_progress`; else anything waiting puts it in `waiting`; else anything
 * unstarted puts it in `backlog`; else every descendant is finished and so
 * is the project. A project with no descendants at all has nothing to
 * derive from and falls back to `backlog` — it is work that exists and has
 * not started, which is what an empty project is.
 */
export function columnForSubtree(states: readonly string[]): BoardColumn {
  let sawWaiting = false;
  let sawBacklog = false;
  let sawAny = false;
  for (const state of states) {
    const column = columnForState(state as ItemStateValue);
    if (column === undefined) continue;
    sawAny = true;
    if (column === "in_progress") return "in_progress";
    if (column === "waiting") sawWaiting = true;
    if (column === "backlog") sawBacklog = true;
  }
  if (sawWaiting) return "waiting";
  if (sawBacklog) return "backlog";
  return sawAny ? "completed" : "backlog";
}

export const getItemDetail = defineOperation({
  name: "get_item_detail",
  kind: "read",
  summary: "One item in full: its subtask tree, artifacts, history, and completion summary.",
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
    // carrying a path of creation timestamps and sorting on it — ordering
    // by `depth` alone would interleave unrelated branches, which is
    // exactly wrong for a tree the client indents but does not re-nest.
    const subtreeRows = await ctx.db.$queryRawUnsafe<RawSubtreeRow[]>(
      `WITH RECURSIVE subtree AS (
         SELECT i."id", i."parentId", i."title", i."kind", i."state", i."priority",
                1 AS "depth", ARRAY[i."createdAt"] AS "path"
         FROM "Item" i WHERE i."parentId" = $1
         UNION ALL
         SELECT i."id", i."parentId", i."title", i."kind", i."state", i."priority",
                s."depth" + 1, s."path" || i."createdAt"
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
    const column: BoardColumn =
      item.kind === "project"
        ? columnForSubtree(subtreeRows.filter((r) => r.kind !== "project").map((r) => r.state))
        : columnForState(item.state as ItemStateValue);

    const artifactRows = await ctx.db.$queryRawUnsafe<RawArtifactRow[]>(
      `SELECT "id", "kind"::text AS "kind", "verdict"::text AS "verdict", "reviewRound",
              "commitSha", "ref", "body", "findings", "createdAt"
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
