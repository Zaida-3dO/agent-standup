// The board's sort vocabulary — the four keys, the two directions, and
// which of each a caller gets by default. MILESTONES.md #75.
//
// **Vocabulary only. No SQL.** The `ORDER BY` and the keyset cursor
// predicate live in `@/lib/service/board/sort`, which imports this file.
// The split is the same one `@/lib/board/types.ts` explains at length: the
// front end reaches the service layer through the adapter's JSON and never
// through its modules, so a filter bar that needed the sort keys would
// otherwise have to import a module on the database client's import graph
// — which `npm run check:db-imports` exists to prevent, and which would put
// server-only code in the browser bundle.
//
// The direction is the other way round: the service imports these, so there
// is one list of sort keys rather than two that can disagree. A fifth key
// added here is a type error in the service until its SQL mapping is
// written, which is exactly the order those two changes should happen in.

/** The four things a reader can order the board by. */
export const BOARD_SORT_KEYS = ["priority", "name", "created", "updated"] as const;

export type BoardSortKey = (typeof BOARD_SORT_KEYS)[number];

export const BOARD_SORT_DIRECTIONS = ["asc", "desc"] as const;

export type BoardSortDirection = (typeof BOARD_SORT_DIRECTIONS)[number];

/**
 * What a caller gets when they ask for nothing.
 *
 * Newest first — the order every board page was served in before sorting
 * existed. Kept as the default deliberately rather than switching to, say,
 * priority: a changed default would silently re-order every existing
 * caller's board, including the CLI and the MCP adapter, to answer a
 * question none of them asked.
 */
export const DEFAULT_BOARD_SORT: BoardSortKey = "created";
export const DEFAULT_BOARD_SORT_DIRECTION: BoardSortDirection = "desc";
