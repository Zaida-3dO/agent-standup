// `get_board` — SCHEMA.md §19 `GET /board`: "Items grouped by derived
// column." MILESTONES.md #36, extended by #75 ("Filters and search: area,
// repo, state, who's on it, priority").
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
// adds `kind`, board-specific.
//
// **`state` — added by #75, with one deliberate exclusion.** #36 left this
// out on the reasoning that "a state filter would silently have no meaning
// for half of what the board renders" — true of a bare equality check,
// because every project is created with the same `on_deck` default and
// never transitions (guards never run against a project's own state,
// per DECISIONS.md §13c), so a raw `state = 'on_deck'` filter would return
// every untouched project alongside genuinely on-deck tasks. #75 needs this
// filter anyway — SCHEMA.md §1.1 names the exact case: "paused and blocked
// share a column ... the needs-you count wants a badge or filter of its
// own" — so the fix is to keep the equality check AND exclude `kind =
// 'project'` outright whenever `state` is supplied. A project's column
// still derives from its descendants (unfiltered, see below); it just never
// appears in the board's *item list* when the caller is narrowing by raw
// state, because it has no raw state that filter could honestly mean.
//
// **`assignee` — "who's on it" (#75).** A live assignment (`releasedAt IS
// NULL`, the same predicate `liveAssignments` in `claims.ts` reads) with
// `holderId` equal to the filter value. Unlike `state`, this is meaningful
// for a project too — an orchestrator can hold a project — so no kind
// exclusion applies here.
//
// **`search` — free text over `title`/`body` (#75).** A case-insensitive
// substring match (`ILIKE`), `%`/`_`/`\` escaped so a literal percent sign
// in the search text doesn't act as a wildcard.
//
// **All five dimensions filter server-side, in this one WHERE clause** —
// not fetched-whole-then-filtered in a client. #36 already established the
// pattern (priority/area/repo/kind as SQL conditions on the same query that
// builds the board), and every reason that held then still holds: the
// database has the indexes (`SCHEMA.md §1: "(repo) is there because listing
// filters on it exactly as it filters on area"`), there is no board UI yet
// to hold a client-side cache in (`src/app/page.tsx` is still the
// placeholder — row #37 hasn't landed), and a second, parallel filtering
// implementation in a future client would only be another place for the
// five dimensions to drift out of sync with what `list_items` (#26) and
// this operation already agree on. When the board UI is built, it is a thin
// shell passing these same query params through, exactly as
// `src/app/api/board/route.ts` already does for the first four.
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
    // Same eleven-value vocabulary `list_items` (#26) already validates
    // against — kept in sync by hand here because the two operations have
    // no shared schema fragment to both read from; `tests/board-columns.test.ts`
    // (and this operation's own state-machine import) would need to change
    // too if the vocabulary itself ever moved.
    state: z
      .enum([
        "someday",
        "on_deck",
        "planning",
        "plan_review",
        "executing",
        "in_review",
        "paused",
        "blocked",
        "merged",
        "research_done",
        "wont_do",
        "cancelled",
      ])
      .optional(),
    /** "Who's on it" — matches a live assignment's `holderId` (person or agent crew name). */
    assignee: z.string().min(1).optional(),
    /** Free-text, case-insensitive substring match over `title` and `body`. */
    search: z.string().min(1).optional(),
  })
  .strict();

export type GetBoardInput = z.infer<typeof inputSchema>;

/** Escapes `%`, `_` and `\` so a search term is matched literally by `ILIKE ... ESCAPE '\'`. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface BoardEntry {
  readonly item: ItemRecord;
  /** The item's own state, mapped straight through for a task/subtask. Always present on a project too — see `columns.ts`'s `columnForProject` header for why it must not be read as the project's column. */
  readonly column: BoardColumn;
}

export type BoardOutput = Readonly<Record<BoardColumn, readonly BoardEntry[]>>;

export const getBoard = defineOperation({
  name: "get_board",
  kind: "read",
  summary:
    "Items grouped by derived column, filterable by priority, area, repo, kind, state, assignee and search.",
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
    if (input.state !== undefined) {
      conditions.push(`"state" = $${paramIndex}::"ItemState"`);
      values.push(input.state);
      paramIndex++;
      // See the module header: a project's stored `state` is a leftover
      // creation default, never a fact about it, so it never honestly
      // matches a caller's raw-state filter — exclude it outright rather
      // than let an on_deck filter silently sweep in every untouched
      // project alongside genuinely on-deck tasks.
      conditions.push(`"kind" != 'project'::"ItemKind"`);
    }
    if (input.assignee !== undefined) {
      conditions.push(
        `EXISTS (SELECT 1 FROM "Assignment" a WHERE a."itemId" = "Item"."id" AND a."releasedAt" IS NULL AND a."holderId" = $${paramIndex})`,
      );
      values.push(input.assignee);
      paramIndex++;
    }
    if (input.search !== undefined) {
      conditions.push(
        `("title" ILIKE $${paramIndex} ESCAPE '\\' OR "body" ILIKE $${paramIndex} ESCAPE '\\')`,
      );
      values.push(`%${escapeLikePattern(input.search)}%`);
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
        const list = descendantStatesByProject.get(row.rootId) ?? [];
        list.push(row.state);
        descendantStatesByProject.set(row.rootId, list);
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
