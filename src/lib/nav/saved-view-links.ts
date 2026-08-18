// Turning stored board views into sidebar links — MILESTONES.md #75.
//
// **This is the whole of the sidebar's knowledge of filters, and it is a
// string.** A saved view stores the board's query string; a link is
// `/board?<that>`. So the sidebar renders destinations, exactly as it does
// for `NAV_ROUTES`, and never learns what an area or a priority is.
//
// It lives under `@/lib/nav` rather than `@/lib/board` because its consumer
// is the shell, which is on every screen — putting it in the board's module
// would mean the app shell imported the board to draw its own sidebar.

/** A pinned view as the sidebar renders it: a name and where it goes. */
export interface SavedViewLinkData {
  readonly name: string;
  readonly href: string;
}

/** The stored shape this reads — deliberately structural, so nothing here imports the board's schema. */
export interface StoredView {
  readonly name: string;
  readonly query: string;
  readonly pinned?: boolean;
}

/**
 * The board href for a stored query string.
 *
 * An empty query gives `/board` with no trailing `?`. A bare `?` in an
 * address reads as a filter that failed to apply, and it would also make the
 * `currentHref` comparison miss on the unfiltered board — the sidebar would
 * never mark a pinned "everything" view as current.
 */
export function boardHrefForQuery(query: string): string {
  return query === "" ? "/board" : `/board?${query}`;
}

/**
 * The links for every pinned view.
 *
 * Unpinned views are filtered out rather than rendered greyed: the sidebar
 * is where "pinned" means something, so an unpinned view showing there would
 * make the flag decorative. `pinned` is optional in the structural type and
 * an absent one counts as pinned, matching the stored schema's default —
 * a view written before the flag existed should not silently disappear.
 */
export function savedViewLinksFrom(views: readonly StoredView[]): readonly SavedViewLinkData[] {
  return views
    .filter((view) => view.pinned !== false)
    .map((view) => ({ name: view.name, href: boardHrefForQuery(view.query) }));
}

/**
 * The full path-and-query being rendered, as one comparable string.
 *
 * The comparison the sidebar makes is against an href, so a path alone
 * cannot answer it: every saved view points at `/board`, and comparing paths
 * would mark *every* view current the moment the reader opened the board.
 */
export function currentHrefFrom(pathname: string | undefined, query: string): string | null {
  if (pathname === undefined) return null;
  return query === "" ? pathname : `${pathname}?${query}`;
}
