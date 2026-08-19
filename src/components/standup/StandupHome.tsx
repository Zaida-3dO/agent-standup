"use client";

// The thin container for the Standup home (`/`): fetches the four blocks'
// data for the active profile and hands it to `StandupHomeView` as plain
// props — the same split `SinceLastVisit.tsx` follows and for the same
// reason (see that file's header).
import { useEffect, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import {
  fetchStandup,
  standupErrorMessageFrom,
  type StandupData,
  type StandupLoadState,
} from "@/lib/standup/state";
import { StandupHomeView } from "./StandupHomeView";

export function StandupHome() {
  const { activeProfile } = useProfile();
  const personId = activeProfile?.id ?? null;

  // Same staleness guard `SinceLastVisit`/`NeedsYouInbox` use: the loaded
  // state carries the profile id it was loaded for, so a profile switch
  // mid-flight cannot paint one person's digest as another's.
  const [loaded, setLoaded] = useState<{ personId: string | null; state: StandupLoadState } | null>(
    null,
  );
  const loadState: StandupLoadState =
    loaded !== null && loaded.personId === personId ? loaded.state : { status: "loading" };

  /**
   * The clock, sampled once per load rather than read at render time —
   * matching `Projects.tsx`'s own `now` state. Reading `Date.now()` during
   * render would produce a different tree on the server than on the client
   * for the same data (a hydration mismatch) and would make the overnight
   * cutoff and every "waiting Nh" label disagree with each other by however
   * long the render took.
   */
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const loadedAt = new Date();
    fetchStandup(personId, loadedAt)
      .then((data: StandupData) => {
        if (cancelled) return;
        setNow(loadedAt.getTime());
        setLoaded({ personId, state: { status: "loaded", data } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({ personId, state: { status: "error", message: standupErrorMessageFrom(err) } });
      });
    return () => {
      cancelled = true;
    };
  }, [personId]);

  return <StandupHomeView loadState={loadState} now={now} />;
}
