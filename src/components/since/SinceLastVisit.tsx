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

  return (
    <SinceLastVisitView
      loadState={loadState}
      personId={personId}
      onMarkSeen={handleMarkSeen}
      onMarkAllSeen={handleMarkAllSeen}
    />
  );
}
