// The parts of the filter bar's behaviour that are decisions rather than
// React — MILESTONES.md #75.
//
// Split out for the reason every other `@/lib/board` module is: this repo's
// harness runs `environment: "node"` with no DOM, so anything left inside a
// hook is only reachable through a real render pass. What is here is what a
// press or a keystroke *means*; the `useState` and the router live in the
// container.

import {
  boardHref,
  boardQueryString,
  withFilter,
  withoutFilters,
  type BoardFilters,
  type BoardQuery,
  type BoardSortDirection,
  type BoardSortKey,
} from "./filters";
import {
  savedViewNameProblem,
  upsertSavedView,
  removeSavedView,
  type SavedView,
  type SavedViews,
} from "./saved-views";

/**
 * How long the search box waits after the last keystroke before it changes
 * the URL.
 *
 * A search that re-queried on every keystroke would issue four requests for
 * "auth" and push four entries onto the browser's history, so the back
 * button would walk back through a word letter by letter. 300ms is long
 * enough to swallow a typed word and short enough not to feel like the box
 * has stopped responding.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/** Choosing a value on one axis. */
export function filterChanged<K extends keyof BoardFilters>(
  query: BoardQuery,
  key: K,
  value: BoardFilters[K] | undefined,
): BoardQuery {
  return withFilter(query, key, value);
}

/**
 * Choosing a sort key.
 *
 * **The direction is kept, not reset.** A reader who is looking at the
 * board newest-first and switches to priority is changing what they are
 * ordering by, not asking to start over — resetting the direction would
 * silently undo half of what they had set up.
 */
export function sortChanged(query: BoardQuery, sort: BoardSortKey): BoardQuery {
  return { ...query, sort };
}

/** Flipping the direction. */
export function directionToggled(query: BoardQuery): BoardQuery {
  const direction: BoardSortDirection = query.direction === "asc" ? "desc" : "asc";
  return { ...query, direction };
}

/**
 * Clearing every filter.
 *
 * **The sort survives.** Clearing a filter and reordering the board are
 * different intents, and the "clear filters" control names only the first —
 * a control that quietly did both would be doing something its own label
 * does not mention.
 */
export function filtersCleared(query: BoardQuery): BoardQuery {
  return withoutFilters(query);
}

/**
 * What the search box should show when the URL says one thing and the
 * reader has typed another.
 *
 * The draft wins while it differs, which is the whole point of a debounce —
 * but only until the URL catches up. This is the function that decides when
 * a draft is stale: after navigation, the URL's value is the truth, so a
 * reader arriving on a link with `search=auth` sees "auth" in the box rather
 * than an empty one that silently contradicts the results.
 */
export function searchDraftFor(urlSearch: string | undefined, draft: string | null): string {
  return draft ?? urlSearch ?? "";
}

/** The address a board query should be at — what the container pushes. */
export function hrefFor(query: BoardQuery): string {
  return boardHref(query);
}

/** The stored form of a board query — what a saved view holds. */
export function queryStringFor(query: BoardQuery): string {
  return boardQueryString(query);
}

/** The result of pressing "save view": the new list, or why it was refused. */
export type SaveViewResult =
  | { readonly ok: true; readonly views: SavedViews }
  | { readonly ok: false; readonly reason: string };

/**
 * Saving a board query under a name.
 *
 * The name is stored trimmed but with its case intact — the reader typed
 * "My P0s" and should see "My P0s" — while uniqueness is decided
 * case-insensitively by `upsertSavedView`, so "my p0s" lands on the same
 * entry instead of sitting beside it looking like a duplicate.
 */
export function viewSaved(views: SavedViews, name: string, query: BoardQuery): SaveViewResult {
  const problem = savedViewNameProblem(views, name);
  if (problem !== null) return { ok: false, reason: problem.reason };
  const view: SavedView = {
    name: name.trim(),
    query: boardQueryString(query),
    pinned: true,
  };
  return { ok: true, views: upsertSavedView(views, view) };
}

/** Deleting a view by name. */
export function viewDeleted(views: SavedViews, name: string): SavedViews {
  return removeSavedView(views, name);
}
