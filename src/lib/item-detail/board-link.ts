// Chip → board links — M10 T10.
//
// A chip on this page (area, repo, priority, state, assignee) is a link
// back to `/board` narrowed to that one value — "what else is in this
// area" becomes one click instead of a filter rebuilt by hand.
//
// **This module encodes nothing of its own.** It is a thin adapter over
// `@/lib/board/filters`, which owns the board's URL contract
// (MILESTONES.md #75); every address here is built by that module's
// `boardHref`.
//
// **Why one encoder and not two agreeing ones.** The board decides "you
// are looking at this saved view" by comparing address strings for
// equality, so the *exact* string is load-bearing and not merely the set of
// parameters. Two independent encoders can agree on every input and still
// diverge the moment one gains an axis or changes emission order — and the
// failure is silent: a chip that links to a URL the board does not filter
// on reads as navigation and does nothing. Delegating to `boardHref` makes
// that class of drift unrepresentable rather than merely tested against.
import {
  BOARD_FILTER_PARAMS,
  boardHref,
  emptyBoardQuery,
  type BoardFilters,
} from "@/lib/board/filters";

/**
 * The chip-linkable axes.
 *
 * A subset of the board's filter vocabulary rather than a restatement:
 * `level` and `project` are board-shaped narrowings with no single chip to
 * carry them, and `trust` is a property of a row rather than a value a chip
 * displays. Derived from `BoardFilters` by key, so an axis renamed on the
 * board is a type error here rather than a dead link.
 */
export type BoardLinkFilter = Extract<
  keyof BoardFilters,
  "area" | "repo" | "assignee" | "actor" | "priority" | "state" | "kind" | "search"
>;

/**
 * The eight axes, in the fixed order `/board`'s own encoder emits them.
 *
 * Filtered from `BOARD_FILTER_PARAMS` rather than listed again, so the
 * order is the board's order by construction — a property held by the type
 * system rather than by a test that has to be remembered.
 */
export const BOARD_LINK_PARAMS: readonly BoardLinkFilter[] = BOARD_FILTER_PARAMS.filter(
  (name): name is BoardLinkFilter => name !== "level" && name !== "project" && name !== "trust",
);

/**
 * The board's address, narrowed to one filter.
 *
 * A blank or whitespace-only value produces the unfiltered board rather
 * than a query string that would ask the API for `area=` — `boardHref`
 * omits an empty value for the same reason `readParam` drops one, so a chip
 * with nothing to say about (an item with no `repo`) degrades to a plain
 * link rather than a broken one.
 *
 * The narrowing is applied to `emptyBoardQuery()`, whose default `level`
 * emits no parameter — so the address stays the short one-parameter string
 * a chip should produce, and is byte-identical to the one the board's own
 * filter bar builds for the same selection.
 */
export function boardLinkFor(filter: BoardLinkFilter, value: string): string {
  const base = emptyBoardQuery();
  return boardHref({
    ...base,
    filters: { ...base.filters, [filter]: value.trim() },
  });
}
