"use client";

// The thin container for `/needs-you`: fetches the inbox for the active
// profile and wires the decide actions, handing everything else to
// `NeedsYouInboxView` as plain props — the same split `SinceLastVisit.tsx`
// follows and for the same reason (see that file's header).
import { useCallback, useEffect, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { approve, deny } from "@/lib/needs-you/decide";
import {
  fetchNeedsYou,
  needsYouErrorMessageFrom,
  type NeedsYouLoadState,
} from "@/lib/needs-you/state";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import { NeedsYouInboxView } from "./NeedsYouInboxView";

export function NeedsYouInbox() {
  const { activeProfile } = useProfile();
  const personId = activeProfile?.id ?? null;

  // Same staleness guard `SinceLastVisit` uses: the loaded state carries the
  // profile id it was loaded for, so switching profiles mid-flight cannot
  // paint one person's inbox as another's while the new fetch is still in
  // the air. See that component's header for the full reasoning.
  const [loaded, setLoaded] = useState<{
    personId: string | null;
    state: NeedsYouLoadState;
  } | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  // Sampled once per load rather than read at render time — see
  // `StandupHome.tsx`'s own note (and `Projects.tsx`, which this mirrors)
  // on why `Date.now()` cannot be called during render.
  const [now, setNow] = useState(0);

  const loadState: NeedsYouLoadState =
    loaded !== null && loaded.personId === personId ? loaded.state : { status: "loading" };

  const load = useCallback(() => {
    let cancelled = false;
    fetchNeedsYou(personId)
      .then(({ items, total }) => {
        if (cancelled) return;
        setNow(Date.now());
        setLoaded({ personId, state: { status: "loaded", items, total } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({ personId, state: { status: "error", message: needsYouErrorMessageFrom(err) } });
      });
    return () => {
      cancelled = true;
    };
  }, [personId]);

  useEffect(() => load(), [load]);

  const findItem = useCallback(
    (itemId: string): NeedsYouItem | null => {
      if (loaded === null || loaded.state.status !== "loaded") return null;
      return loaded.state.items.find((item) => item.id === itemId) ?? null;
    },
    [loaded],
  );

  const runDecide = useCallback(
    (itemId: string, action: typeof approve) => {
      if (personId === null) return;
      const item = findItem(itemId);
      if (item === null) return;
      setDecideError(null);
      setDecidingId(itemId);
      // `expectedFrom` is the row's own `state` as the last load reported it
      // — the server's value, not one derived from `reason` here. That makes
      // a decision taken against a list which has gone stale a 409 rather
      // than a silent overwrite; see `decide.ts`'s header.
      void action({ itemId, reason: item.reason, personId, expectedFrom: item.state })
        .then((result) => {
          setDecidingId(null);
          if (!result.ok) {
            setDecideError(result.message);
            return;
          }
          // Re-fetches rather than removing the row locally: an approval
          // moves the item to a new state (`executing`/`merged`), which is
          // exactly the condition that makes it stop qualifying for this
          // list under all three admission rules at once — refetching is
          // simpler than re-deriving that here, and since T24 it is a
          // single bounded read (`get_needs_you`) rather than three.
          load();
        })
        .catch(() => {
          setDecidingId(null);
          setDecideError("Something went wrong recording that decision.");
        });
    },
    [personId, findItem, load],
  );

  const handleApprove = useCallback((itemId: string) => runDecide(itemId, approve), [runDecide]);
  const handleDeny = useCallback((itemId: string) => runDecide(itemId, deny), [runDecide]);

  return (
    <NeedsYouInboxView
      loadState={loadState}
      now={now}
      decidingId={decidingId}
      onApprove={handleApprove}
      onDeny={handleDeny}
      decideError={decideError}
    />
  );
}
