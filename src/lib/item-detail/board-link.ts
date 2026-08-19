// Chip → board links — M10 T10.
//
// A chip on this page (area, repo, priority, state, assignee) is a link
// back to `/board` narrowed to that one value — "what else is in this
// area" becomes one click instead of a filter rebuilt by hand.
//
// **The parameter names here are not invented.** `/board`'s filter bar
// (MILESTONES.md #75) reads its query string with `parseBoardQuery`, and
// its own module header states the contract explicitly: "the parameter
// names below are load-bearing across features … a chip on an item's
// detail page … links back to a board narrowed to that chip, and it does
// so by building one of these query strings." `tests/board-filters-url.test.ts`
// asserts the eight names literally for exactly that reason.
//
// **Why this file exists instead of importing `boardHref` from
// `@/lib/board/filters`.** At the time this tab was built, the module that
// owns that contract (`feat/board-filter-sort-search`, MILESTONES.md #75)
// had not landed on `main` — it exists only as a sibling branch. Importing
// a module that is not on `main` is not an option, so this is a narrow,
// independent implementation of the documented contract: eight query
// parameters, the same names, the same board path. Once #75 merges, this
// module becomes a thin re-export of `boardHref`/`BoardFilters` rather than
// its own encoder — the two are already identical in shape by construction
// (see the test suite this file's own tests were written against, quoted
// in the module comments above).
//
// The single-character failure mode this exists to catch: a chip that
// links to a URL the board does not actually filter on is worse than a
// plain, unlinked chip — it reads as navigation and silently does nothing.
export type BoardLinkFilter =
  "area" | "repo" | "assignee" | "actor" | "priority" | "state" | "kind" | "search";

/** The eight axes, in the fixed order `/board`'s own encoder emits them — see the header. */
export const BOARD_LINK_PARAMS: readonly BoardLinkFilter[] = [
  "area",
  "repo",
  "assignee",
  "actor",
  "priority",
  "state",
  "kind",
  "search",
];

/**
 * The board's address, narrowed to one filter.
 *
 * A blank or whitespace-only value produces the unfiltered board rather
 * than a query string that would ask the API for `area=` — the same rule
 * `readParam` in the board's own filter codec applies, so a chip with
 * nothing to say about (an item with no `repo`) degrades to a plain link
 * rather than a broken one.
 */
export function boardLinkFor(filter: BoardLinkFilter, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "/board";
  const params = new URLSearchParams();
  params.set(filter, trimmed);
  return `/board?${params.toString()}`;
}
