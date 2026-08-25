"use client";

// The thin container: fetches `GET /api/events` for the active profile and
// hands the result to `SinceLastVisitView` as plain props. Kept deliberately
// empty of branching — see `SinceLastVisitView.tsx`'s header for why the
// conditionals live there instead, where they're directly testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over one `service.call("get_events", …)`
// (CLAUDE.md: "Every adapter is a thin shell over a service call"). Nothing
// under `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useCallback, useEffect, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import {
  appendPage,
  applySeen,
  fetchFeed,
  markManySeen,
  markSeen,
  sinceErrorMessageFrom,
  type SinceLoadState,
} from "@/lib/since/state";
import { SinceLastVisitView } from "./SinceLastVisitView";

export function SinceLastVisit() {
  const { activeProfile } = useProfile();
  const personId = activeProfile?.id ?? null;
  // The state carries the profile it was loaded for, rather than the effect
  // resetting it to `loading` on the way past. That reset is genuinely
  // wanted — read state is per person (SCHEMA.md §8b), so a feed loaded for
  // one profile is *wrong* for the next one, and showing it while the new
  // fetch is in flight would show someone else's read state as yours. But
  // doing it with a synchronous `setState` inside the effect renders the
  // stale feed once before clearing it, which is both the flash of wrong
  // data and what `react-hooks/set-state-in-effect` is warning about.
  // Tagging the state and comparing during render makes staleness a derived
  // fact, so the wrong feed is never rendered at all.
  const [loaded, setLoaded] = useState<{ personId: string | null; state: SinceLoadState } | null>(
    null,
  );
  const loadState: SinceLoadState =
    loaded !== null && loaded.personId === personId ? loaded.state : { status: "loading" };

  // ── Paging (row 3c25e600) ─────────────────────────────────────────────
  //
  // `get_events` has paged correctly since it was written — keyset on
  // `Event.id`, a bigint cursor sent as a string, taken before the
  // `unseenOnly` filter — and nothing consumed it, so the view rendered one
  // bounded screenful and stopped. These two pieces of state are the whole
  // consumer.
  //
  // **Which direction "more" goes.** `readSinceBounded` is `WHERE id > since
  // ORDER BY id ASC`, and `cursor` is the *highest* id in the slice, so
  // continuing means walking **forward** into newer events — the opposite of
  // T24's item history, which walks back into the past. With `since` omitted
  // the first page starts at id 0, so a reader without a pager sees the
  // oldest screenful and nothing after it. Hence "Load newer entries", not
  // "older": the label has to match the direction or it is a lie.
  // **Both paging flags are tagged with the profile they describe, and
  // compared during render — exactly like `loaded` above, and for the same
  // reason.** A new profile means a new feed from the start of the ledger,
  // so paging done for the previous one is not merely stale but wrong. The
  // obvious way to express that is to reset the flags inside the effect that
  // refetches, but a synchronous `setState` in an effect is what
  // `react-hooks/set-state-in-effect` rejects, and it costs a cascading
  // render. Tagging makes "whose paging is this?" a derived fact instead.
  const [paging, setPaging] = useState<{
    personId: string | null;
    loadingMore: boolean;
    exhausted: boolean;
  }>({ personId: null, loadingMore: false, exhausted: false });
  const forThisProfile = paging.personId === personId;
  const loadingMore = forThisProfile && paging.loadingMore;
  // **An empty page is the only honest end-of-ledger signal this operation
  // offers.** Unlike `get_item_history`'s `nextCursor: null`, `get_events`
  // always returns a real cursor — it hands back the caller's own when the
  // slice was empty, specifically so a poller does not reset to 0. So
  // "exhausted" is something the client observes (a page with no events)
  // rather than something the server states.
  const exhausted = forThisProfile && paging.exhausted;

  // Re-fetches when the profile changes, not just on mount — switching
  // profiles in the top bar makes every `seen` flag on screen refer to the
  // wrong person until this runs again. `personId` in the dependency list is
  // the whole fix.
  useEffect(() => {
    let cancelled = false;
    fetchFeed({ personId })
      .then((feed) => {
        if (cancelled) return;
        setLoaded({ personId, state: { status: "loaded", feed } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({ personId, state: { status: "error", message: sinceErrorMessageFrom(err) } });
      });
    return () => {
      cancelled = true;
    };
  }, [personId]);

  // The cursor to continue from, derived during render from the feed on
  // screen.
  //
  // **This is the defect-avoidance the row called out.** The cursor the next
  // request needs lives inside `loaded`, and the tempting way to get it is
  // to read it *inside* a `setLoaded` updater, where the current state is
  // conveniently in hand, then use it to issue a fetch. That is precisely the
  // shape that has shipped three times in this repo (`Board.tsx` twice,
  // `UndoToastHost.tsx` once): React defers an updater whenever a lane is
  // already pending and StrictMode invokes it twice, so a value assigned in
  // there is not reliably set on the next line and the request fires twice or
  // from nothing. `scripts/check-updater-side-effects.mjs` rejects it
  // statically.
  //
  // A plain `const` computed during render is enough here and is preferable
  // to the ref that `UndoToastHost.onUndo` and `Board.onDrop` use: those two
  // need a ref because their handlers run from a *subscription* that closes
  // over an old render. This one runs from an `onClick` on the very tree this
  // value was computed for, so the value in the closure is by construction
  // the one the reader was looking at when they pressed. Every updater below
  // stays a pure function of its argument either way, which is the property
  // that actually matters.
  const cursor = loadState.status === "loaded" ? loadState.feed.cursor : null;

  // Both handlers apply the change locally after the write succeeds rather
  // than refetching the feed. A refetch would re-order and re-page the list
  // under the reader's cursor at the exact moment they are working through
  // it; `applySeen` recomputes the counts from the events in hand, so the
  // screen stays put and still tells the truth.
  //
  // The update is guarded on the profile the state was loaded for, so a
  // write that resolves *after* the reader switched profiles cannot paint
  // one profile's read state onto another's feed.
  const runMarkSeen = useCallback(
    (write: (personId: string) => Promise<void>, eventIds: readonly string[]) => {
      if (!personId) return;
      void write(personId)
        .then(() => {
          setLoaded((current) =>
            current !== null && current.personId === personId && current.state.status === "loaded"
              ? {
                  personId,
                  state: { status: "loaded", feed: applySeen(current.state.feed, eventIds) },
                }
              : current,
          );
        })
        .catch((err: unknown) => {
          setLoaded({
            personId,
            state: { status: "error", message: sinceErrorMessageFrom(err) },
          });
        });
    },
    [personId],
  );

  const handleMarkSeen = useCallback(
    (eventId: string) => {
      runMarkSeen((who) => markSeen(eventId, who), [eventId]);
    },
    [runMarkSeen],
  );

  const handleMarkAllSeen = useCallback(
    (eventIds: readonly string[]) => {
      runMarkSeen((who) => markManySeen(eventIds, who), eventIds);
    },
    [runMarkSeen],
  );

  /**
   * Fetches the next page from the server's cursor and appends it.
   *
   * Guarded against re-entry, because two in-flight reads from the same
   * cursor would append the same events twice. (`appendPage` de-duplicates
   * as a further line of defence, but not issuing the request is better than
   * absorbing its result.)
   *
   * **Honest note on what covers this `loadingMore` check.** Nothing in
   * `tests/since-react-wiring.test.ts` does, and deleting the line leaves
   * that suite green. That is not an untested branch so much as an
   * unreachable one *from the DOM*: the rendered control is `disabled` for
   * exactly the window in which this guard could fire, and a disabled button
   * swallows a synthetic click, so a test cannot press it twice. Clearing
   * the attribute by hand does not help either — React re-applies it before
   * the dispatch. The suite does assert the disabling itself, which is the
   * half a reader can actually reach.
   *
   * It is kept anyway, as the guard for a caller that does not come through
   * that button — a keyboard shortcut, a scroll-triggered fetch, or a future
   * container that forgets to thread `loadingMore` into `disabled`. Stating
   * this rather than writing a test that passes either way: a test that
   * cannot fail is worse than a named gap.
   *
   * Note what is *not* here: nothing reads or writes state inside a
   * `setLoaded` updater. The cursor is computed during render and closed
   * over, the page comes from the closure, and every updater is a pure
   * function of its argument — see `cursor`'s comment above.
   */
  const handleLoadMore = useCallback(() => {
    if (loadingMore) return;
    if (cursor === null) return;
    setPaging({ personId, loadingMore: true, exhausted: false });
    fetchFeed({ personId, since: cursor })
      .then((page) => {
        // An empty page means the ledger has nothing past this cursor — the
        // only end signal `get_events` gives. Stop offering the control
        // rather than leaving a button that can only ever do nothing.
        setPaging({ personId, loadingMore: false, exhausted: page.events.length === 0 });
        if (page.events.length === 0) {
          return;
        }
        setLoaded((current) =>
          current !== null && current.personId === personId && current.state.status === "loaded"
            ? {
                personId,
                state: { status: "loaded", feed: appendPage(current.state.feed, page) },
              }
            : // The reader switched profiles while this was in flight. Drop
              // it: appending one profile's events onto another's feed is
              // the same defect the mark-seen guard above prevents.
              current,
        );
      })
      .catch((err: unknown) => {
        setPaging({ personId, loadingMore: false, exhausted: false });
        setLoaded({
          personId,
          state: { status: "error", message: sinceErrorMessageFrom(err) },
        });
      });
  }, [loadingMore, cursor, personId]);

  // Offered only when there is a real position to continue from and the
  // ledger has not already answered "nothing past here". A feed with no
  // events at all has no cursor worth following.
  const hasMore = !exhausted && loadState.status === "loaded" && loadState.feed.events.length > 0;

  return (
    <SinceLastVisitView
      loadState={loadState}
      personId={personId}
      onMarkSeen={handleMarkSeen}
      onMarkAllSeen={handleMarkAllSeen}
      onLoadMore={handleLoadMore}
      loadingMore={loadingMore}
      hasMore={hasMore}
    />
  );
}
