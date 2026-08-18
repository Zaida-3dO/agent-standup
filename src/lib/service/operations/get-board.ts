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
// **A board is many paginated reads, not one (#109).** Returning every
// column in one call is the wrong shape even once each column is bounded:
// the caller pays for sections it is not looking at, and a column that is
// three items long costs the same first paint as one that is sixty-eight.
// So a call names a `column` and gets **one page of that column plus that
// column's true total** — the count renders at the top of the column and a
// *show more* control pages the rest with the returned `nextCursor`.
//
// With no `column`, the read answers "what is being worked on": the open
// columns only (`board/slice.ts` — `in_progress` and `waiting`), each
// bounded, with `backlog` and `completed` withheld and a `notice` naming
// the calls that return them. That is a narrower default than #103's
// non-terminal one, and the narrowing is the point: backlog is unbounded,
// never pruned, and nothing in it is being worked on.
//
// **Totals are counted, never inferred from the page.** #123 is what
// happens otherwise: the completed column rendered empty with a count of
// `0` while 161 `merged` + 14 `cancelled` rows sat in the database, and
// backlog read `68` against 58 `on_deck`. A count taken from the length of
// a filtered, defaulted, paginated page is not the column's size and never
// was — so every column's `total` comes from its own `COUNT(*)` over the
// same predicate the page is drawn from, and a withheld column reports the
// true total it is withholding rather than zero. **An empty state and a
// hidden state must not render identically**, which is only possible if the
// count is honest when the page is absent.
//
// **The completed column opts out of the terminal-state default (#123).**
// #103's exclusion is right for every other column and exactly wrong for
// the one column whose entire purpose is terminal work: asking for
// `column: "completed"` is a caller asking for finished work, so answering
// it with nothing would be the same class of bug as answering an explicit
// `state: "merged"` with nothing.
//
// **A card says who is on it (F7).** `assignee` was a filter input with no
// matching output: a caller could narrow the board to one holder and still
// not be told, for any card, who held it. So every entry carries its live
// assignments — the slim `BoardAssignment` shape, seven scalars, described
// in `items/assignment-view.ts`.
//
// Two properties of how it is fetched are load-bearing:
//
//   - **One statement for the whole response, not one per card.** The rows
//     for every entry across every returned column are read in a single
//     `itemId = ANY(...)` query after the pages are assembled, so a
//     sixty-eight-card board costs one added round trip rather than
//     sixty-eight. A card-by-card fetch is the obvious implementation and
//     is the one thing this read cannot afford.
//   - **It is the slim shape, deliberately.** This response has already had
//     to be narrowed twice for size (#107, #109), and ownership carries
//     seven more columns that no card draws — machine, branch, worktree,
//     model, effort, session, pid. Those are `get_item_detail`'s, on a
//     response that returns one item.
//
// An item nobody holds gets `[]`, never a missing field: "nobody is on this"
// and "this read does not report ownership" are different facts, and #123's
// lesson is that they must not render identically.
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
  NOT_ARCHIVED_CONDITION,
  toBoardItemSummaryRecord,
  toItemRecord,
  type BoardItemSummaryRecord,
  type ItemRecord,
  type RawBoardItemSummaryRow,
  type RawItemRow,
} from "../items/row";
import {
  BOARD_COLUMNS,
  STATES_BY_COLUMN,
  columnForProject,
  columnForState,
  type BoardColumn,
} from "../board/columns";
import {
  MAX_PAGE_LIMIT,
  defaultLimitFor,
  OPEN_COLUMNS,
  WITHHELD_COLUMNS,
  buildSliceNotice,
} from "../board/slice";
import { isItemState } from "../state-machine/states";
import { areaFilterCondition } from "../items/area-filter";
import {
  LIVE_BOARD_ASSIGNMENTS_SQL,
  groupBoardAssignmentsByItem,
  type BoardAssignment,
  type RawBoardAssignmentRow,
} from "../items/assignment-view";

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
    /**
     * An area id. Matches an item carrying this area **anywhere in its area
     * set**, not only as its primary one (SCHEMA.md §23.1).
     */
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
    /**
     * One section to page through (MILESTONES.md #109). Omitted means the
     * default open-work slice — `in_progress` and `waiting` — with the
     * other two columns withheld and named in `notice`.
     *
     * Naming a column is what makes `backlog` and `completed` reachable, so
     * this doubles as the explicit ask both of those require. Asking for
     * `completed` also opts that column out of the terminal-state exclusion
     * (#123): a caller naming the completed column is asking for finished
     * work by definition.
     */
    column: z.enum(BOARD_COLUMNS).optional(),
    /** "Who's on it" — matches a live assignment's `holderId` (person or agent crew name). */
    assignee: z.string().min(1).optional(),
    /** Free-text, case-insensitive substring match over `title` and `body`. */
    search: z.string().min(1).optional(),
    /**
     * Include the completed column — finished work. Off by default; see
     * the module header. Has no effect when `state` names a terminal state
     * explicitly, or when `column` is `completed`, because either is
     * already the caller asking for exactly that.
     */
    includeTerminal: z.boolean().default(false),
    /**
     * Return whole `items` rows rather than the slim board shape. Off by
     * default — see `BoardItemSummaryRecord`.
     */
    full: z.boolean().default(false),
    /**
     * How many items per column. Applies to **each** returned column, not
     * to the response as a whole, because a caller pages one column at a
     * time and a shared budget would make one column's page size depend on
     * how full another column happened to be.
     *
     * **Optional rather than defaulted in the schema**, because the right
     * default depends on `full`: the same row count is a small response in
     * the slim projection and an oversized one in the full record (see
     * `defaultLimitFor`). A schema-level `.default()` cannot read a sibling
     * field, so the default is resolved in the handler instead — and
     * `undefined` here means "the caller did not choose", which is exactly
     * the case that has to be safe.
     */
    limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
    /**
     * Keyset cursor — the `nextCursor` from a previous page of **this same
     * column**. Meaningless across columns, because each column is its own
     * ordered sequence; a cursor is only ever paired with the `column` it
     * came from.
     */
    cursor: z.string().min(1).optional(),
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
  /**
   * Who holds this item — live assignments only (`releasedAt IS
   * NULL`), in the order they were claimed.
   *
   * **Empty, never absent, when nobody holds it.** An array is also the
   * right shape rather than a single holder: SCHEMA.md §2 allows an
   * orchestrator, a builder and two reviewers on one item at once, so a
   * scalar field would have to pick one and silently hide the rest.
   *
   * The slim shape — see `BoardAssignment` for what it deliberately omits
   * and why.
   */
  readonly assignments: readonly BoardAssignment[];
}

/**
 * One column: the page asked for, the column's real size, and where the
 * rest of it is.
 *
 * `total` is a counted fact about the column, **not** `entries.length` —
 * see the module header on #123. It is populated even when `entries` is
 * empty because the column was withheld, which is the whole mechanism that
 * keeps an empty column and a hidden one from rendering identically.
 */
export interface BoardSection {
  readonly entries: readonly BoardEntry[];
  /** Every item in this column under the current filters, regardless of the page. */
  readonly total: number;
  /** Pass back as `cursor` with this same `column` for the next page. Null when this page is the last. */
  readonly nextCursor: string | null;
  /**
   * True when this column was not read because the default slice excludes
   * it. `total` is still the truth; `entries` is empty because nothing was
   * fetched, not because there is nothing there.
   */
  readonly withheld: boolean;
}

export interface BoardOutput {
  readonly columns: Readonly<Record<BoardColumn, BoardSection>>;
  /**
   * What this read withheld and the call that returns it (MILESTONES.md
   * #109 part 3). Null when nothing was withheld — see `buildSliceNotice`
   * for why a notice that announces nothing is worse than none.
   */
  readonly notice: string | null;
}

/** One column's `COUNT(*)`, as Postgres returns it. */
interface RawCountRow {
  count: bigint | number | string;
}

/**
 * Postgres `count(*)` arrives as a `bigint`, which cannot cross a JSON
 * boundary at all — `JSON.stringify` throws on one outright rather than
 * silently truncating — so every count is narrowed here before it can reach
 * a response.
 */
function toCount(value: bigint | number | string): number {
  return typeof value === "number" ? value : Number(value);
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getBoard = defineOperation({
  name: "get_board",
  kind: "read",
  summary:
    "One paginated page of one board column, with that column's true total, and who holds each item. With no column, returns open work only — in_progress and waiting — plus a notice naming the calls that return backlog and completed. Filterable by priority, area, repo, kind, state, assignee and search; pass full for whole records.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetBoardInput): Promise<BoardOutput> {
    // Which columns this call is answering for. A named column is exactly
    // that column; no named column is the open-work default (#109 part 2).
    const requested: readonly BoardColumn[] =
      input.column !== undefined ? [input.column] : OPEN_COLUMNS;

    // A caller's own limit always wins; otherwise the default is chosen
    // against the projection, because a row bound is not a size bound
    // (#107) — see `defaultLimitFor`.
    const limit = input.limit ?? defaultLimitFor(input.full);

    // Asking for the completed column IS the explicit ask for terminal work
    // (#123), so it opts out of #103's exclusion the same way an explicit
    // `state: "merged"` does. Without this, the one column whose purpose is
    // finished work would be permanently empty — which is the defect.
    const wantsTerminal = input.includeTerminal || input.column === "completed";

    // Archived rows are served by no ordinary read (MILESTONES.md #137), and
    // this is a shared condition where #103's terminal-state exclusion
    // deliberately is not. The two look alike and are opposite cases. A
    // terminal item is real, finished work, so a column's `total` counting
    // it is truthful and which terminal work a caller sees is decided by
    // which columns they read. An archived item is a row the installation
    // has said should never have existed — counting it would make a column
    // report a number larger than anything it can ever show, which is the
    // one way a `total` becomes a lie rather than a truth about a wider set.
    // Shared, so the project read, the per-column `COUNT(*)` and the page
    // query all exclude it together and cannot disagree.
    const shared: string[] = [NOT_ARCHIVED_CONDITION];
    const sharedValues: unknown[] = [];
    let paramIndex = 1;

    if (input.priority !== undefined) {
      shared.push(`"priority" = $${paramIndex}::"Priority"`);
      sharedValues.push(input.priority);
      paramIndex++;
    }
    if (input.area !== undefined) {
      // Matches ANY of the item's areas, not only its primary one — see
      // `areaFilterCondition` (../items/area-filter.ts) for why.
      shared.push(areaFilterCondition(paramIndex));
      sharedValues.push(input.area);
      paramIndex++;
    }
    if (input.repo !== undefined) {
      shared.push(`"repo" = $${paramIndex}`);
      sharedValues.push(input.repo);
      paramIndex++;
    }
    if (input.kind !== undefined) {
      shared.push(`"kind" = $${paramIndex}::"ItemKind"`);
      sharedValues.push(input.kind);
      paramIndex++;
    }
    if (input.state !== undefined) {
      shared.push(`"state" = $${paramIndex}::"ItemState"`);
      sharedValues.push(input.state);
      paramIndex++;
      // See the module header: a project's stored `state` is a leftover
      // creation default, never a fact about it, so it never honestly
      // matches a caller's raw-state filter — exclude it outright rather
      // than let an on_deck filter silently sweep in every untouched
      // project alongside genuinely on-deck tasks.
      shared.push(`"kind" != 'project'::"ItemKind"`);
    }
    // #103's terminal-state exclusion is deliberately NOT a shared
    // condition here, and its absence is load-bearing rather than an
    // oversight.
    //
    // Every per-column query below already constrains `state` to exactly
    // the states of the column it is reading — `STATES_BY_COLUMN[column]`
    // — and that filter strictly subsumes the exclusion: for the three
    // non-terminal columns it is implied, and for `completed` the two
    // directly contradict, which is what made the completed column
    // unreachable (#123). Which terminal work a *caller* gets is therefore
    // decided by which columns are read (`requested`), not by a `WHERE`
    // clause — and a column's `total` stays a truthful count of what
    // exists rather than of what this call chose to return.
    //
    // The exclusion still applies to projects, whose column cannot be
    // expressed in SQL at all; it is applied to them after their column is
    // derived, below.
    if (input.assignee !== undefined) {
      shared.push(
        `EXISTS (SELECT 1 FROM "Assignment" a WHERE a."itemId" = "Item"."id" AND a."releasedAt" IS NULL AND a."holderId" = $${paramIndex})`,
      );
      sharedValues.push(input.assignee);
      paramIndex++;
    }
    if (input.search !== undefined) {
      shared.push(
        `("title" ILIKE $${paramIndex} ESCAPE '\\' OR "body" ILIKE $${paramIndex} ESCAPE '\\')`,
      );
      sharedValues.push(`%${escapeLikePattern(input.search)}%`);
      paramIndex++;
    }

    // The parameter position each per-column query appends its own state
    // array at. Fixed here, after every shared condition has taken its
    // placeholder, so the count query and the page query agree on it
    // without either having to know what the other appended.
    const statesParam = paramIndex;

    // A task or subtask's column is a pure function of its own stored
    // state, so it can be selected in SQL — which is what makes a bounded
    // page and an honest `COUNT(*)` possible at all. A project's cannot: it
    // is derived from a recursive walk of its subtree (DECISIONS.md §13c),
    // a fact no `WHERE` clause on `Item` can express.
    //
    // So the two are read differently and merged. Non-projects are
    // paginated and counted in the database; projects are read whole, their
    // columns derived, then bucketed. The asymmetry is stated rather than
    // hidden: projects number in the tens and tasks in the thousands, so
    // paginating the large side and walking the small one is where the
    // payload actually goes. If projects ever outgrow that, the fix is a
    // stored derived column, not a bigger page.
    const projectsExcluded = input.kind !== undefined && input.kind !== "project";
    const projectsOnly = input.kind === "project";

    // Every project, with its derived column — read once and reused for
    // both the counts and the pages, so no project is walked twice.
    const projectEntries = new Map<BoardColumn, BoardEntry[]>();
    if (!projectsExcluded) {
      const projectWhere = [...shared, `"kind" = 'project'::"ItemKind"`];
      const projectRows = await ctx.db.$queryRawUnsafe<(RawItemRow | RawBoardItemSummaryRow)[]>(
        `SELECT ${itemColumnsFor(input.full, "board")} FROM "Item" WHERE ${projectWhere.join(" AND ")}
         ORDER BY "createdAt" DESC, "id" DESC`,
        ...sharedValues,
      );
      const projects: (BoardItemSummaryRecord | ItemRecord)[] = input.full
        ? (projectRows as RawItemRow[]).map(toItemRecord)
        : (projectRows as RawBoardItemSummaryRow[]).map(toBoardItemSummaryRecord);

      // Projects need their *whole* subtree's states, regardless of whether
      // the filters kept those descendants — a filtered-out descendant is
      // still real work sitting under the project, and leaving it out would
      // make a project's column depend on which filter happened to be
      // applied rather than on the state of its work. One recursive query
      // answers "state of every non-project descendant of every project".
      //
      // Archived descendants are the exception, and for the reason the rest
      // of the sentence gives: they are not real work sitting under the
      // project. An archived duplicate left in this walk would hold its
      // parent in `in_flight` forever on the strength of a row nobody can
      // see and nobody will ever move — a project stuck on a ghost, with no
      // visible child explaining why.
      const projectIds = projects.map((item) => item.id);
      const descendantStatesByProject = new Map<string, string[]>();
      if (projectIds.length > 0) {
        const descendantRows = await ctx.db.$queryRawUnsafe<{ rootId: string; state: string }[]>(
          `WITH RECURSIVE subtree AS (
             SELECT "id", "parentId" AS "rootId" FROM "Item" WHERE "parentId" = ANY($1::text[])
             UNION ALL
             SELECT i."id", s."rootId"
             FROM "Item" i JOIN subtree s ON i."parentId" = s."id"
           )
           SELECT s."rootId", i."state" FROM subtree s JOIN "Item" i ON i."id" = s."id"
           WHERE i.${NOT_ARCHIVED_CONDITION}`,
          projectIds,
        );
        for (const row of descendantRows) {
          const list = descendantStatesByProject.get(row.rootId) ?? [];
          list.push(row.state);
          descendantStatesByProject.set(row.rootId, list);
        }
      }

      // A project whose derived column is `completed` is dropped unless
      // terminal work was asked for — by its *derived* column, never by its
      // stored `state`, which is a creation leftover (DECISIONS.md §13c).
      // Filtering it in SQL would keep every finished project on the board,
      // which is exactly the payload #103 exists to remove.
      const dropCompletedProjects = !wantsTerminal && input.state === undefined;
      for (const item of projects) {
        const column = columnForProject(
          (descendantStatesByProject.get(item.id) ?? []).map((state) =>
            requireItemState(state, item.id),
          ),
        );
        if (dropCompletedProjects && column === "completed") continue;
        const list = projectEntries.get(column) ?? [];
        // Ownership is attached in one pass over the whole response below,
        // so nothing here — project or task — queries for its own holder.
        list.push({ item, column, assignments: [] });
        projectEntries.set(column, list);
      }
    }

    const board: Record<BoardColumn, BoardSection> = {
      backlog: { entries: [], total: 0, nextCursor: null, withheld: true },
      in_progress: { entries: [], total: 0, nextCursor: null, withheld: true },
      waiting: { entries: [], total: 0, nextCursor: null, withheld: true },
      completed: { entries: [], total: 0, nextCursor: null, withheld: true },
    };

    // Every column reports a truthful `total` — including the ones this
    // read is withholding, which is what lets a caller tell "backlog is
    // empty" from "backlog was not read" (#123). Only the *pages* are
    // limited to the requested columns.
    for (const column of BOARD_COLUMNS) {
      let total = (projectEntries.get(column) ?? []).length;

      if (!projectsOnly) {
        // The non-project half of this column's size, counted over exactly
        // the predicate its page is drawn from — never derived from the
        // page, which is the #123 defect itself.
        //
        // The completed column is counted even when the read excluded
        // terminal work: its size is a fact about the store, not about what
        // this call chose to return, and reporting it as `0` is precisely
        // the "175 items completed, column says 0" bug.
        const countWhere = [
          ...shared,
          `"kind" != 'project'::"ItemKind"`,
          `"state" = ANY($${statesParam}::"ItemState"[])`,
        ];
        const countRows = await ctx.db.$queryRawUnsafe<RawCountRow[]>(
          `SELECT COUNT(*)::bigint AS "count" FROM "Item" WHERE ${countWhere.join(" AND ")}`,
          ...sharedValues,
          STATES_BY_COLUMN[column],
        );
        total += toCount(countRows[0]?.count ?? 0);
      }

      board[column] = { entries: [], total, nextCursor: null, withheld: true };
    }

    // Now the pages, for the requested columns only.
    for (const column of requested) {
      const projectsInColumn = projectEntries.get(column) ?? [];
      let entries: BoardEntry[] = [];
      let nextCursor: string | null = null;

      if (!projectsOnly) {
        const pageValues: unknown[] = [...sharedValues, STATES_BY_COLUMN[column]];
        let pageIndex = statesParam + 1;
        const pageWhere = [
          ...shared,
          `"kind" != 'project'::"ItemKind"`,
          `"state" = ANY($${statesParam}::"ItemState"[])`,
        ];

        if (input.cursor !== undefined) {
          // Keyset pagination on `("createdAt", "id")`, both descending —
          // the same key and tie-break `list_items` uses, so the two reads
          // page identically and a reader of one is not surprised by the
          // other. `id` breaks ties between rows created in the same
          // millisecond, which `createdAt` alone cannot: without it, two
          // items created together could interleave across pages or repeat
          // depending on scan order.
          const cursorRows = await ctx.db.$queryRawUnsafe<{ createdAt: Date | string }[]>(
            `SELECT "createdAt" FROM "Item" WHERE "id" = $1`,
            input.cursor,
          );
          const cursorRow = cursorRows[0];
          if (cursorRow) {
            pageWhere.push(`("createdAt", "id") < ($${pageIndex}::timestamptz, $${pageIndex + 1})`);
            pageValues.push(cursorRow.createdAt, input.cursor);
            pageIndex += 2;
          }
        }

        // One row more than asked for, to learn whether a further page
        // exists without a second query.
        pageValues.push(limit + 1);
        const rows = await ctx.db.$queryRawUnsafe<(RawItemRow | RawBoardItemSummaryRow)[]>(
          `SELECT ${itemColumnsFor(input.full, "board")} FROM "Item" WHERE ${pageWhere.join(" AND ")}
           ORDER BY "createdAt" DESC, "id" DESC
           LIMIT $${pageIndex}`,
          ...pageValues,
        );

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const items: (BoardItemSummaryRecord | ItemRecord)[] = input.full
          ? (page as RawItemRow[]).map(toItemRecord)
          : (page as RawBoardItemSummaryRow[]).map(toBoardItemSummaryRecord);
        entries = items.map((item) => ({
          item,
          column: columnForState(requireItemState(item.state, item.id)),
          assignments: [],
        }));
        nextCursor = hasMore ? (entries[entries.length - 1]?.item.id ?? null) : null;
      }

      // Projects are prepended rather than merged by `createdAt`: they were
      // read whole and sit outside the cursor's sequence, so interleaving
      // them would make a page's contents depend on how far through the
      // non-project sequence the cursor had reached. Putting them on the
      // first page only — a cursor means "continuing", so a continuation
      // page carries none — keeps every project visible exactly once across
      // the whole pagination.
      if (input.cursor === undefined && projectsInColumn.length > 0) {
        entries = [...projectsInColumn, ...entries];
      }

      board[column] = {
        entries,
        total: board[column].total,
        nextCursor,
        withheld: false,
      };
    }

    // Ownership for every entry in the whole response, in **one** statement
    // (F7). Deliberately after the pages are assembled rather than inside
    // the per-column loop: the ids are only all known here, and one query
    // per column would reintroduce a smaller version of the same N+1 this
    // is shaped to avoid. Skipped entirely when nothing was returned, so a
    // withheld or empty board adds no query at all.
    const entryIds = requested.flatMap((column) =>
      board[column].entries.map((entry) => entry.item.id),
    );
    if (entryIds.length > 0) {
      const assignmentRows = await ctx.db.$queryRawUnsafe<RawBoardAssignmentRow[]>(
        LIVE_BOARD_ASSIGNMENTS_SQL,
        // De-duplicated because a project appears on the first page of its
        // derived column only, but nothing stops the same id reaching this
        // list twice if that ever changes — and a duplicated id would
        // duplicate every one of its assignment rows.
        [...new Set(entryIds)],
      );
      const assignmentsByItem = groupBoardAssignmentsByItem(assignmentRows);
      for (const column of requested) {
        board[column] = {
          ...board[column],
          entries: board[column].entries.map((entry) => ({
            ...entry,
            // `?? []` is what makes "nobody holds this" an empty array
            // rather than an absent field — see `BoardEntry.assignments`.
            assignments: assignmentsByItem.get(entry.item.id) ?? [],
          })),
        };
      }
    }

    // The notice names only what was actually withheld, with its real
    // total, so it is never a false lead (see `buildSliceNotice`).
    const shown = requested.reduce((sum, column) => sum + board[column].entries.length, 0);
    const notice =
      input.column === undefined
        ? buildSliceNotice(
            shown,
            WITHHELD_COLUMNS.map((column) => ({ column, total: board[column].total })),
          )
        : null;

    return Object.freeze({ columns: Object.freeze(board), notice });
  },
});
