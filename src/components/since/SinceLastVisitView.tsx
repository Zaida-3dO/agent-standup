// The presentational half of MILESTONES.md #38: the load/error/loaded
// branching, the per-item grouping, and the "seen" actions.
//
// Deliberately prop-driven and hook-free rather than a `useSince()` caller
// — same reasoning as `BoardView.tsx` and `AppShellView.tsx`: with
// `environment: "node"` and no DOM, a component that takes plain props can
// be called directly as a function and its returned tree inspected, which
// is what actually proves these branches. `SinceLastVisit.tsx` is the thin
// client container that fetches and hands this component its props.
import type { SinceLoadState } from "@/lib/since/state";
import { emptyStateMessage, groupByItem, unseenEventIds } from "@/lib/since/view";
import { EventRow } from "./EventRow";
import styles from "./SinceLastVisit.module.css";

export interface SinceLastVisitViewProps {
  readonly loadState: SinceLoadState;
  /** The active profile's id, or `null` — decides whether the seen actions are offered at all. */
  readonly personId: string | null;
  readonly onMarkSeen?: (eventId: string) => void;
  readonly onMarkAllSeen?: (eventIds: readonly string[]) => void;
  /** Asks for the next page from the server's cursor. Absent when the caller does not page. */
  readonly onLoadMore?: () => void;
  /** True while a page is in flight — disables the control so a second press cannot double-fetch. */
  readonly loadingMore?: boolean;
  /**
   * Whether the ledger may hold more past what is on screen.
   *
   * Shown only when the container says so, so the control never appears on a
   * list that is already complete — a button whose only possible outcome is
   * "nothing happened" teaches a reader that the feature is broken.
   */
  readonly hasMore?: boolean;
}

export function SinceLastVisitView({
  loadState,
  personId,
  onMarkSeen,
  onMarkAllSeen,
  onLoadMore,
  loadingMore = false,
  hasMore = false,
}: SinceLastVisitViewProps) {
  if (loadState.status === "error") {
    return (
      <div className={styles.centered}>
        <p>{loadState.message}</p>
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className={styles.centered}>
        <p>Loading what&apos;s new…</p>
      </div>
    );
  }

  const feed = loadState.feed;
  const empty = emptyStateMessage(feed);
  const groups = groupByItem(feed.events);
  const unseen = unseenEventIds(feed.events);
  // The seen actions need somebody to attribute the read to — `personId`
  // is what `POST /events/{id}/seen` requires. With no profile chosen the
  // feed is still perfectly readable; it just cannot be marked.
  const canMark = personId !== null;

  return (
    <section className={styles.panel} aria-label="Since your last visit">
      <div className={styles.head}>
        <h2 className={styles.title}>Since your last visit</h2>
        {feed.unseenCount > 0 && (
          <span className={styles.unseenCount} aria-label={`${feed.unseenCount} unseen`}>
            {feed.unseenCount}
          </span>
        )}
        {canMark && unseen.length > 0 && onMarkAllSeen && (
          <button type="button" className={styles.markAll} onClick={() => onMarkAllSeen(unseen)}>
            Mark all as seen
          </button>
        )}
      </div>

      {empty !== null ? (
        <div className={styles.centered}>
          <p>{empty}</p>
        </div>
      ) : (
        <ul className={styles.groups}>
          {groups.map((group) => (
            <li key={group.itemId ?? "__unscoped"} className={styles.group}>
              <h3 className={styles.groupHead}>
                {/* An event with no item is a system-level change
                    (SCHEMA.md §3: `setting_change`'s `item_id` is null), and
                    it gets an honest heading rather than being hidden. */}
                {group.itemTitle ?? (group.itemId === null ? "System" : group.itemId)}
                {group.unseenCount > 0 && (
                  <span className={styles.unseenCount}>{group.unseenCount}</span>
                )}
              </h3>
              <ul className={styles.events}>
                {group.events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    onMarkSeen={canMark ? onMarkSeen : undefined}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {/* The pager. Rendered below the list because it continues forward
          into newer events — `get_events` is `WHERE id > since ORDER BY id
          ASC`, so the next page belongs after what is on screen, not before
          it. Shown only when the container has said there is somewhere to
          continue to. */}
      {hasMore && onLoadMore && (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.loadMore}
            disabled={loadingMore}
            onClick={onLoadMore}
            data-loading-more={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load newer entries"}
          </button>
        </div>
      )}
    </section>
  );
}
