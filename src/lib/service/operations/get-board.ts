// `get_board` — SCHEMA.md §19 `GET /board`: "Items grouped by derived
// column." MILESTONES.md #36.
//
// Two shapes of row feed the board, and they are queried differently:
//
//   - A `task` or `subtask` has a real, stored `state` (SCHEMA.md §1.1),
//     so its column is `columnForState(item.state)` directly.
//   - A `project` has **no stored state to read** (DECISIONS.md §13c: "a
//     project's column is computed on read, so guards never run against a
//     project's own state") — its column is derived from every descendant
//     in its subtree, however deep (kind's nesting is unbounded, per
//     SCHEMA.md §1). That needs a recursive walk, not a single-level join.
//
// Filters apply to which items appear on the board, project and task alike
// — SCHEMA.md's `list_items` (#26) filters on `state`, `priority`, `area`,
// `repo`, `parentId`; the board reuses `priority`, `area` and `repo`
// (columns already indexed for exactly this per SCHEMA.md §1: "(repo) is
// there because listing filters on it exactly as it filters on area") and
// adds `kind`, board-specific. `state` is deliberately not a board filter:
// the board's whole unit of filtering is the derived *column*, not the raw
// state a project doesn't even have one of — a `state` filter would silently
// have no meaning for half of what the board renders.
import { z } from "zod";
import { InternalError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";
import { columnForProject, columnForState, type BoardColumn } from "../board/columns";
import { isItemState } from "../state-machine/states";

/**
 * Narrows a raw `state` string to the typed vocabulary, or throws.
 *
 * `items.state` is a Postgres enum column — a value outside `ITEM_STATES`
 * cannot occur through any write path this service exposes. Reachable only
 * if a row's stored state has drifted out of the vocabulary this module
 * knows (the same "data problem, not a caller error" case
 * `state-machine/transition.ts` calls out at its own equivalent check), so
 * this throws rather than silently substituting a default column — a wrong
 * default would misplace the item on the board without anyone noticing.
 */
function requireItemState(
  state: string,
  itemId: string,
): import("../state-machine/states").ItemStateValue {
  if (!isItemState(state)) {
    throw new InternalError(
      new Error(`Item ${itemId} has state "${state}", outside the known vocabulary.`),
    );
  }
  return state;
}

const inputSchema = z
  .object({
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    area: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    kind: z.enum(["project", "task", "subtask"]).optional(),
  })
  .strict();

export type GetBoardInput = z.infer<typeof inputSchema>;

export interface BoardEntry {
  readonly item: ItemRecord;
  /** The item's own state, mapped straight through for a task/subtask. Always present on a project too — see `columns.ts`'s `columnForProject` header for why it must not be read as the project's column. */
  readonly column: BoardColumn;
}

export type BoardOutput = Readonly<Record<BoardColumn, readonly BoardEntry[]>>;

export const getBoard = defineOperation({
  name: "get_board",
  kind: "read",
  summary: "Items grouped by derived column, filterable by priority, area, repo and kind.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetBoardInput): Promise<BoardOutput> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.priority !== undefined) {
      conditions.push(`"priority" = $${paramIndex}::"Priority"`);
      values.push(input.priority);
      paramIndex++;
    }
    if (input.area !== undefined) {
      conditions.push(`"area" = $${paramIndex}`);
      values.push(input.area);
      paramIndex++;
    }
    if (input.repo !== undefined) {
      conditions.push(`"repo" = $${paramIndex}`);
      values.push(input.repo);
      paramIndex++;
    }
    if (input.kind !== undefined) {
      conditions.push(`"kind" = $${paramIndex}::"ItemKind"`);
      values.push(input.kind);
      paramIndex++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" ${where} ORDER BY "createdAt" DESC, "id" DESC`,
      ...values,
    );
    const items = rows.map(toItemRecord);

    // Projects need their *whole* subtree's states, regardless of whether
    // the filters above kept those descendants in `items` — a filtered-out
    // descendant is still real work sitting under the project, and leaving
    // it out of the column derivation would make a project's column depend
    // on which filter happened to be applied, not on the state of its work.
    // One recursive query, unfiltered, answers "state of every non-project
    // descendant of every project" in one round trip rather than one query
    // per project.
    const projectIds = items.filter((item) => item.kind === "project").map((item) => item.id);
    const descendantStatesByProject = new Map<string, string[]>();
    if (projectIds.length > 0) {
      const descendantRows = await ctx.db.$queryRawUnsafe<{ rootId: string; state: string }[]>(
        `WITH RECURSIVE subtree AS (
           SELECT "id", "parentId" AS "rootId" FROM "Item" WHERE "parentId" = ANY($1::text[])
           UNION ALL
           SELECT i."id", s."rootId"
           FROM "Item" i JOIN subtree s ON i."parentId" = s."id"
         )
         SELECT s."rootId", i."state" FROM subtree s JOIN "Item" i ON i."id" = s."id"`,
        projectIds,
      );
      for (const row of descendantRows) {
        const list = descendantStatesByProject.get(row.rootId);
        if (list) {
          list.push(row.state);
        } else {
          descendantStatesByProject.set(row.rootId, [row.state]);
        }
      }
    }

    const board: Record<BoardColumn, BoardEntry[]> = {
      backlog: [],
      in_progress: [],
      waiting: [],
      completed: [],
    };

    for (const item of items) {
      const column =
        item.kind === "project"
          ? columnForProject(
              (descendantStatesByProject.get(item.id) ?? []).map((state) =>
                requireItemState(state, item.id),
              ),
            )
          : columnForState(requireItemState(item.state, item.id));
      board[column].push({ item, column });
    }

    return Object.freeze(board);
  },
});
