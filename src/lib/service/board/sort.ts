// How a board page is ordered in SQL, and how a keyset cursor follows that
// order — MILESTONES.md #75's other half.
//
// The board could always be *filtered*; it could never be *sorted*. Every
// page came back on `("createdAt", "id") DESC` and nothing could ask for
// anything else, so "show me the P0s first" or "what moved most recently"
// were questions the board could not answer however hard a reader squinted
// at it.
//
// **The hard part is not the ORDER BY, it is the cursor.** Paging here is
// keyset, not offset: a page carries the id of its last row and the next
// page asks for "everything after that row". That comparison has to be
// written in terms of the *same* key the rows are ordered by — order by
// priority and compare on `createdAt` and page two is drawn from a
// different sequence than page one, which duplicates some rows and skips
// others without either query being wrong on its own. So a sort key and its
// cursor predicate are one decision, and this module makes them one object.
//
// **The vocabulary is imported, not redeclared.** `BOARD_SORT_KEYS` lives in
// `@/lib/board/sort` because the filter bar needs it and must not import
// anything on the database client's graph. Adding a key there is a type
// error in the two `Record<BoardSortKey, …>` maps below until its SQL is
// written — which is the order those changes should happen in, and the
// reason the maps are exhaustive records rather than lookups with fallbacks.
//
// Everything here is a pure function over plain data returning SQL
// fragments. Nothing opens a connection, so the ordering and the cursor
// arithmetic are testable without a database; the database-gated suites then
// check the SQL actually runs.
import {
  BOARD_SORT_KEYS,
  BOARD_SORT_DIRECTIONS,
  DEFAULT_BOARD_SORT,
  DEFAULT_BOARD_SORT_DIRECTION,
  type BoardSortKey,
  type BoardSortDirection,
} from "@/lib/board/sort";

export { BOARD_SORT_KEYS, BOARD_SORT_DIRECTIONS, DEFAULT_BOARD_SORT, DEFAULT_BOARD_SORT_DIRECTION };
export type { BoardSortKey, BoardSortDirection };

/**
 * The column a sort key reads, quoted for SQL.
 *
 * `name` maps to `title` rather than to a `name` column because items have
 * no `name` — the reader's word and the schema's word differ, and the
 * translation belongs here rather than in every caller.
 */
const SORT_COLUMN: Record<BoardSortKey, string> = {
  priority: `"priority"`,
  name: `"title"`,
  created: `"createdAt"`,
  updated: `"updatedAt"`,
};

/**
 * The Postgres type a cursor value must be cast to when it is compared.
 *
 * A cursor value is read back out of the database as a JavaScript value and
 * goes in again as a bind parameter, and Postgres will not infer the type of
 * a bare placeholder inside a row comparison against a non-text column.
 * `null` means no cast is needed — `text` compares fine untyped.
 */
const SORT_CAST: Record<BoardSortKey, string | null> = {
  priority: `"Priority"`,
  name: null,
  created: "timestamptz",
  updated: "timestamptz",
};

/**
 * Which SQL direction a key's chosen direction becomes.
 *
 * Identity for three of the four. **Priority is inverted**, and that is the
 * single most surprising line in this module, so it is stated rather than
 * left to be discovered: the `Priority` enum is declared `P0, P1, P2, P3`,
 * so `ORDER BY "priority" ASC` puts P0 first. A reader asking for priority
 * *descending* means "most important at the top", in the ordinary sense of
 * a descending priority list — P0 first — and a reader asking for ascending
 * wants P3 first. Mapping them straight through gives the exact opposite of
 * both, which nobody would report as a sort bug; they would conclude the
 * sort was broken and stop using it.
 */
export function sqlDirection(key: BoardSortKey, direction: BoardSortDirection): "ASC" | "DESC" {
  if (key === "priority") return direction === "desc" ? "ASC" : "DESC";
  return direction === "desc" ? "DESC" : "ASC";
}

/**
 * The `ORDER BY` a page is drawn in — always two terms.
 *
 * `id` is the tie-break and is never omitted. Three of the four keys are
 * not unique (two items can share a priority, a title, or a millisecond),
 * and a non-unique sort key with no tie-break gives Postgres licence to
 * return tied rows in any order it likes — including a *different* order on
 * the next query, which makes a keyset cursor skip and repeat rows for
 * reasons that look like data corruption. The tie-break always runs in the
 * same SQL direction as the key, so the row comparison below is a valid
 * lexicographic one.
 */
export function orderByClause(key: BoardSortKey, direction: BoardSortDirection): string {
  const dir = sqlDirection(key, direction);
  return `ORDER BY ${SORT_COLUMN[key]} ${dir}, "id" ${dir}`;
}

/** The column a cursor row's sort value is read from — `SELECT <this> FROM "Item" WHERE "id" = $1`. */
export function cursorSelectColumn(key: BoardSortKey): string {
  return SORT_COLUMN[key];
}

/**
 * The predicate that resumes a page after `cursor`.
 *
 * A row comparison — `(sortCol, id) < ($1, $2)` — rather than the
 * `sortCol < $1 OR (sortCol = $1 AND id < $2)` expansion, because the two
 * are equivalent and only the first one can use a composite index. The
 * comparison direction follows the SQL direction of the sort: a `DESC` page
 * takes rows strictly below the cursor, an `ASC` page rows strictly above
 * it.
 *
 * `firstParam` is the 1-based placeholder number the sort value takes; the
 * id takes `firstParam + 1`. A parameter rather than an assumption, because
 * this predicate is appended after a variable number of filter parameters.
 */
export function cursorCondition(
  key: BoardSortKey,
  direction: BoardSortDirection,
  firstParam: number,
): string {
  const comparison = sqlDirection(key, direction) === "DESC" ? "<" : ">";
  const cast = SORT_CAST[key];
  const valuePlaceholder = cast === null ? `$${firstParam}` : `$${firstParam}::${cast}`;
  return `(${SORT_COLUMN[key]}, "id") ${comparison} (${valuePlaceholder}, $${firstParam + 1})`;
}
