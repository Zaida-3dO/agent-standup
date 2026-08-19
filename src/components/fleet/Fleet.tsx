"use client";

// The thin container: fetches `GET /api/fleet` (and the sweep threshold),
// reads who's acting from the profile context, and hands both plus the
// sweep/takeover wiring to `FleetView` as plain props. Kept deliberately
// empty of branching — see `FleetView.tsx`'s header for why the
// conditionals live there instead, where they're directly testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over `service.call` (CLAUDE.md: "Every
// adapter is a thin shell over a service call"). Nothing under
// `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useCallback, useEffect, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import {
  fetchDeadAfterSeconds,
  fetchFleet,
  fleetErrorMessageFrom,
  requestTakeover,
  runSweep,
  type SweepResult,
} from "@/lib/fleet/state";
import { NO_FLEET_FILTERS, type FleetFilters } from "@/lib/fleet/view";
import type { FleetAssignment } from "@/lib/fleet/types";
import { FleetView, type FleetLoadState, type TakeoverState } from "./FleetView";

export function Fleet() {
  const { activeProfile } = useProfile();
  const [loadState, setLoadState] = useState<FleetLoadState>({ status: "loading" });
  const [now, setNow] = useState(0);
  const [deadAfterSeconds, setDeadAfterSeconds] = useState(1800);
  const [filters, setFilters] = useState<FleetFilters>(NO_FLEET_FILTERS);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [sweepConfirming, setSweepConfirming] = useState(false);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepLastResult, setSweepLastResult] = useState<SweepResult | null>(null);
  const [sweepErrorMessage, setSweepErrorMessage] = useState<string | null>(null);

  const [takeover, setTakeover] = useState<TakeoverState | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    Promise.all([fetchFleet(), fetchDeadAfterSeconds()])
      .then(([assignments, dead]) => {
        if (cancelled) return;
        setNow(Date.now());
        setDeadAfterSeconds(dead);
        setLoadState({ status: "loaded", assignments });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: fleetErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load, reloadNonce]);

  const onConfirmSweep = useCallback(() => {
    setSweepRunning(true);
    setSweepErrorMessage(null);
    void runSweep().then((outcome) => {
      setSweepRunning(false);
      setSweepConfirming(false);
      if (outcome.ok) {
        setSweepLastResult(outcome.result);
        // Reload — a sweep just changed who is live, and the whole point of
        // reporting what it released is showing the fleet with those rows
        // gone rather than leaving the stale pre-sweep list on screen.
        setReloadNonce((n) => n + 1);
      } else {
        setSweepErrorMessage(outcome.message);
      }
    });
  }, []);

  const onStartTakeover = useCallback((assignment: FleetAssignment) => {
    setTakeover({ assignment, reason: "", submitting: false, errorMessage: null });
  }, []);

  const onConfirmTakeover = useCallback(() => {
    if (takeover === null || activeProfile === null) return;
    setTakeover({ ...takeover, submitting: true, errorMessage: null });
    void requestTakeover({
      itemId: takeover.assignment.itemId,
      fromSessionId: takeover.assignment.sessionId,
      // A browser session has no server-registered id of its own — the
      // fleet page is a person acting through the UI, not an agent with a
      // `register_session` call behind it — so a fresh id is minted per
      // takeover, the same generated-id pattern `profile/create.ts` uses
      // for exactly the same reason (nothing displays it, it only has to
      // be distinct from the session being displaced).
      bySessionId: `ui-${crypto.randomUUID()}`,
      holderType: "person",
      holderId: activeProfile.id,
      reason: takeover.reason.trim() === "" ? null : takeover.reason.trim(),
      force: true,
    }).then((outcome) => {
      if (outcome.ok) {
        setTakeover(null);
        setReloadNonce((n) => n + 1);
      } else {
        setTakeover((current) =>
          current === null
            ? null
            : { ...current, submitting: false, errorMessage: outcome.message },
        );
      }
    });
  }, [takeover, activeProfile]);

  return (
    <FleetView
      loadState={loadState}
      now={now}
      deadAfterSeconds={deadAfterSeconds}
      filters={filters}
      onFiltersChange={setFilters}
      onRetry={() => {
        setLoadState({ status: "loading" });
        setReloadNonce((n) => n + 1);
      }}
      sweepConfirming={sweepConfirming}
      sweepRunning={sweepRunning}
      sweepLastResult={sweepLastResult}
      sweepErrorMessage={sweepErrorMessage}
      onOpenSweepConfirm={() => {
        setSweepErrorMessage(null);
        setSweepConfirming(true);
      }}
      onCancelSweepConfirm={() => setSweepConfirming(false)}
      onConfirmSweep={onConfirmSweep}
      takeover={takeover}
      onStartTakeover={onStartTakeover}
      onTakeoverReasonChange={(reason) =>
        setTakeover((current) => (current === null ? null : { ...current, reason }))
      }
      onCancelTakeover={() => setTakeover(null)}
      onConfirmTakeover={onConfirmTakeover}
    />
  );
}
