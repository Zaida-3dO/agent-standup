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
// **`includeTerminal` — finished work is off by default (#103).** The
// completed column is the majority of a store that has been used for a
// while and its share only grows, because nothing prunes terminal state; a
// board read that ships all of it is expensive on every call and, past a
// certain size, fails outright rather than merely being slow. So the
// default board is *the work*, and `includeTerminal: true` asks for the
// completed column back.
//
// Two consequences specific to this operation, both deliberate:
//
//   - **A project is dropped when its derived column is `completed`** —
//     not by its stored `state`, which is a leftover creation default and
//     means nothing (DECISIONS.md §13c). Filtering projects by raw state
//     in SQL would keep every finished project on the board, which is
//     exactly the payload #103 exists to remove, so the exclusion has to
//     happen after derivation. It is the same "a project has no honest raw
//     state" reasoning the `state` filter above acts on, reaching the
//     opposite mechanism because this filter *can* be answered from the
//     subtree the board already computes.
//   - **The subtree walk stays unfiltered.** It was already unfiltered on
//     purpose (see below), and this filter does not change that: a
//     project's column must not depend on which filter was applied, or a
//     project with one merged child and one executing child would derive
//     `completed` under a filter that removed the executing child and
//     vanish from a board it belongs on.
//
// **Each card carries only what it draws (#107).** The board selected all
// thirty item columns on every call, so `body` and `customFields` — which no
// card renders — were the overwhelming majority of a board response. The
// default projection is now the eleven fields a card actually uses plus the
// item's headline; `full: true` asks for whole records. See
// `BoardItemSummaryRecord` for why the board's slim shape is wider than the
// one `get_item` and `list_items` return.
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
import {
  itemColumnsFor,
  toBoardItemSummaryRecord,
  toItemRecord,
  type BoardItemSummaryRecord,
  type ItemRecord,
  type RawBoardItemSummaryRow,
  type RawItemRow,
} from "../items/row";
import {
  TERMINAL_STATES,
  columnForProject,
  columnForState,
  type BoardColumn,
} from "../board/columns";
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
    /**
     * Include the completed column — finished work. Off by default; see
     * the module header. Has no effect when `state` names a terminal state
     * explicitly, because that filter is already the caller asking for
     * exactly one of them.
     */
    includeTerminal: z.boolean().default(false),
    /**
     * Return whole `items` rows rather than the slim board shape. Off by
     * default — see `BoardItemSummaryRecord`. The board has no `limit` and
     * no `cursor` at all (MILESTONES.md #109 owns that), so until it does,
     * the projection is the only thing bounding this response.
     */
    full: z.boolean().default(false),
  })
  .strict();

export type GetBoardInput = z.infer<typeof inputSchema>;

/** Escapes `%`, `_` and `\` so a search term is matched literally by `ILIKE ... ESCAPE '\'`. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface BoardEntry {
  /** The slim board shape by default; the whole record when `full` was passed. */
  readonly item: BoardItemSummaryRecord | ItemRecord;
  /** The item's own state, mapped straight through for a task/subtask. Always present on a project too — see `columns.ts`'s `columnForProject` header for why it must not be read as the project's column. */
  readonly column: BoardColumn;
}

export type BoardOutput = Readonly<Record<BoardColumn, readonly BoardEntry[]>>;

export const getBoard = defineOperation({
  name: "get_board",
  kind: "read",
  summary:
    "Items grouped by derived column, filterable by priority, area, repo, kind, state, assignee and search. Each card carries only what it renders, including its headline — pass full for whole records. Finished work is excluded by default — pass includeTerminal to get the completed column.",
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
    } else if (!input.includeTerminal) {
      // Only when the caller named no state of their own — an explicit
      // `state: "merged"` is a caller asking for terminal work, and
      // answering it with nothing would be a worse bug than the payload
      // this default trims.
      //
      // Scoped to non-projects: a project's stored `state` is a leftover
      // creation default, so excluding on it would drop live projects and
      // keep finished ones — precisely backwards. Projects are filtered
      // after their column is derived, below.
      conditions.push(
        `("kind" = 'project'::"ItemKind" OR "state" != ALL($${paramIndex}::"ItemState"[]))`,
      );
      values.push(TERMINAL_STATES);
      paramIndex++;
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
    const rows = await ctx.db.$queryRawUnsafe<(RawItemRow | RawBoardItemSummaryRow)[]>(
      `SELECT ${itemColumnsFor(input.full, "board")} FROM "Item" ${where} ORDER BY "createdAt" DESC, "id" DESC`,
      ...values,
    );
    const items: (BoardItemSummaryRecord | ItemRecord)[] = input.full
      ? (rows as RawItemRow[]).map(toItemRecord)
      : (rows as RawBoardItemSummaryRow[]).map(toBoardItemSummaryRecord);

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

    // A project's column is the only one that cannot be excluded in SQL —
    // see the module header. Dropping it here, after derivation, is what
    // keeps `includeTerminal: false` from leaving every finished project
    // sitting in the completed column it exists to empty. `state` supplied
    // by the caller already excludes projects outright above, so this
    // branch cannot double-apply to a state-filtered read.
    const dropCompletedProjects = !input.includeTerminal && input.state === undefined;

    for (const item of items) {
      const column =
        item.kind === "project"
          ? columnForProject(
              (descendantStatesByProject.get(item.id) ?? []).map((state) =>
                requireItemState(state, item.id),
              ),
            )
          : columnForState(requireItemState(item.state, item.id));
      if (dropCompletedProjects && item.kind === "project" && column === "completed") continue;
      board[column].push({ item, column });
    }

    return Object.freeze(board);
  },
});
