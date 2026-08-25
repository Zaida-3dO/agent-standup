"use client";

// The thin container: fetches `GET /api/costs` for the chosen grouping and
// window, and hands the result to `CostView` as plain props. Kept
// deliberately empty of branching — see `CostView.tsx`'s header for why the
// conditionals live there instead, where they are directly testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over one `service.call("get_costs", …)`.
// Nothing under `src/components/` imports the service layer or the database
// client; `npm run check:db-imports` enforces that independently of lint.
import { useEffect, useState } from "react";
import {
  fetchCosts,
  sinceForDays,
  costErrorMessageFrom,
  type CostLoadState,
} from "@/lib/cost/state";
import type { CostGrouping } from "@/lib/cost/types";
import { CostView } from "./CostView";

export interface CostProps {
  /** The grouping to open on. Defaults to `day` — spend over time is the question this screen is opened to answer. */
  readonly initialGroupBy?: CostGrouping;
  /** The window to open on, in days back. Defaults to 30. */
  readonly initialWindowDays?: number | null;
}

export function Cost({ initialGroupBy = "day", initialWindowDays = 30 }: CostProps) {
  const [groupBy, setGroupBy] = useState<CostGrouping>(initialGroupBy);
  const [windowDays, setWindowDays] = useState<number | null>(initialWindowDays);
  // The state carries the request it was loaded for, rather than the effect
  // resetting it to `loading` on the way past. That reset is genuinely
  // wanted — a total grouped by session is *wrong* under a `day` heading —
  // but doing it with a synchronous `setState` inside the effect renders the
  // stale table once before clearing it, which is both a flash of wrong data
  // and what `react-hooks/set-state-in-effect` warns about. Tagging the
  // state and comparing during render makes staleness a derived fact, so the
  // wrong totals are never rendered at all. Same shape as
  // `SinceLastVisit.tsx`, and for the same reason.
  const [loaded, setLoaded] = useState<{
    key: string;
    state: CostLoadState;
  } | null>(null);
  const requestKey = `${groupBy}:${windowDays ?? "all"}`;
  const loadState: CostLoadState =
    loaded !== null && loaded.key === requestKey ? loaded.state : { status: "loading" };

  useEffect(() => {
    let cancelled = false;
    // `new Date()` is read inside the effect rather than at module scope, so
    // the window boundary is computed per request. A boundary captured once
    // at import is frozen at the moment the module loaded, so a tab left open
    // across midnight would silently exclude the current day.
    const since = sinceForDays(windowDays, new Date());
    fetchCosts({ groupBy, ...(since !== null ? { since } : {}) })
      .then((costs) => {
        if (cancelled) return;
        setLoaded({ key: requestKey, state: { status: "loaded", costs } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({
          key: requestKey,
          state: { status: "error", message: costErrorMessageFrom(err) },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [groupBy, windowDays, requestKey]);

  return (
    <CostView
      loadState={loadState}
      groupBy={groupBy}
      windowDays={windowDays}
      onGroupByChange={setGroupBy}
      onWindowChange={setWindowDays}
    />
  );
}
