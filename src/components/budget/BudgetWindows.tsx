"use client";

// The thin container: fetches `budget.windows`, holds one scrubber position
// per window, and hands everything to `BudgetWindowsView` as plain props.
// Kept deliberately empty of branching and of policy — the conditionals
// live in the view, and the derivation (chart geometry, plain-words
// descriptions, scrubber transitions) lives in `@/lib/budget-page/`, all
// directly testable without a DOM.
//
// **No database access, and none possible.** Every call goes to the HTTP
// adapter, which is itself a thin shell over one `service.call` (CLAUDE.md:
// "Every adapter is a thin shell over a service call"). Nothing under
// `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
import { useCallback, useEffect, useMemo, useState } from "react";
import { findCrossings, type CrossingProblem } from "@/lib/settings/budget-windows";
import {
  budgetErrorMessageFrom,
  fetchWindows,
  type BudgetLoadState,
} from "@/lib/budget-page/state";
import { scrubbedTo } from "@/lib/budget-page/scrubber";
import { BudgetWindowsView } from "./BudgetWindowsView";

export function BudgetWindows() {
  const [loadState, setLoadState] = useState<BudgetLoadState>({ status: "loading" });
  const [scrubbed, setScrubbed] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    // Promise-chained rather than `await`ed, so every `setState` sits inside
    // an asynchronous callback — what `react-hooks/set-state-in-effect` is
    // asking for, since a `setState` reachable synchronously from an effect
    // body causes a cascading render.
    fetchWindows()
      .then((windows) => {
        if (cancelled) return;
        setLoadState({ status: "loaded", windows });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: budgetErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Crossings per window, recomputed only when the windows change.
   *
   * Derived here rather than stored, because a validation result held in
   * state is one that can disagree with the value it describes — and the
   * whole point of drawing the faults is that the picture matches the
   * configuration exactly.
   */
  const problems = useMemo<Record<string, readonly CrossingProblem[]>>(() => {
    if (loadState.status !== "loaded") return {};
    const found: Record<string, readonly CrossingProblem[]> = {};
    for (const [name, window] of Object.entries(loadState.windows)) {
      found[name] = findCrossings(window);
    }
    return found;
  }, [loadState]);

  const onScrub = useCallback(
    (name: string, atHours: number) => {
      if (loadState.status !== "loaded") return;
      const window = loadState.windows[name];
      if (window === undefined) return;
      setScrubbed((current) => {
        const next = scrubbedTo({ atHours: current[name] ?? 0 }, atHours, window.lengthHours);
        return { ...current, [name]: next.atHours };
      });
    },
    [loadState],
  );

  return (
    <BudgetWindowsView
      loadState={loadState}
      problems={problems}
      scrubbed={scrubbed}
      onScrub={onScrub}
    />
  );
}
