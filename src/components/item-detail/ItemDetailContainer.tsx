"use client";

// The thin container: fetches `GET /api/items/{id}/detail` once, tracks
// which tab is showing, and hands both to `ItemDetailView` as plain props.
// Kept deliberately empty of branching — see `ItemDetailView.tsx`'s header
// for why the conditionals live there instead, where they're directly
// testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over one `service.call("get_item_detail", …)`
// (CLAUDE.md: "Every adapter is a thin shell over a service call"). Nothing
// under `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
//
// ── The tab lives in the URL hash ──────────────────────────────────────
//
// Both halves of that matter and they are separate:
//
// **Reading it** is what makes a link to a section work. Arriving at
// `/items/x#activity` must show Activity, so the initial tab is read from
// the hash rather than defaulting to Overview and waiting to be clicked.
//
// **Writing it** is what makes the section linkable once you are there —
// the reader who found the thing worth pointing at can copy the address
// bar. It uses `history.replaceState` rather than assigning
// `location.hash`, because assigning the hash makes the browser scroll to
// whatever element has that id, and here the ids belong to the panels; the
// page would jump on every tab click. `replaceState` also keeps a tab
// switch out of the back stack, so Back returns to wherever the reader came
// from rather than walking every tab they looked at.
//
// The rule that turns a hash into a tab is `tabFromHash`, a plain function
// in `@/lib/item-detail/tabs` so it is tested without a browser.
import { useCallback, useEffect, useState } from "react";
import {
  fetchItemDetail,
  detailErrorMessageFrom,
  type DetailLoadState,
} from "@/lib/item-detail/state";
import { DEFAULT_TAB, hashForTab, tabFromHash, type DetailTab } from "@/lib/item-detail/tabs";
import { fetchAgentView, agentViewErrorMessageFrom } from "@/lib/item-detail/orientation-state";
import { ItemDetailView } from "./ItemDetailView";
import type { AgentPanelState } from "./AgentPanel";

export interface ItemDetailContainerProps {
  readonly itemId: string;
}

// **Navigating to a different item remounts this rather than resetting it.**
// The page gives this component a `key` of the item id, so React discards
// the whole instance and its state — which is what actually guarantees one
// item's detail is never shown under a different item's id.
// Resetting state inside the effect would do the same thing one render
// later, showing stale content in between; it is also what
// `react-hooks/set-state-in-effect` warns about, and the warning is right.

export function ItemDetailContainer({ itemId }: ItemDetailContainerProps) {
  const [loadState, setLoadState] = useState<DetailLoadState>({ status: "loading" });

  // Starts at the default rather than reading `location.hash` in the
  // initialiser, because this component renders on the server first, where
  // there is no `location` — and a first client render that disagreed with
  // the server's HTML is a hydration mismatch. The effect below applies the
  // hash immediately after mount, which is the earliest point the hash is
  // knowable at all.
  const [activeTab, setActiveTab] = useState<DetailTab>(DEFAULT_TAB);

  // The agent view is a SECOND read, and deliberately not made on arrival.
  // `orientation` is the most expensive call this page can issue — it
  // embeds the whole item record and an unbounded event list — and the
  // panel that shows it is the one a reader opens rarely and on purpose.
  // Fetching it with the detail would put the page's largest cost on every
  // visit, including every visit that never opens the tab.
  const [agentState, setAgentState] = useState<AgentPanelState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    fetchItemDetail(itemId)
      .then((detail) => {
        if (cancelled) return;
        setLoadState({ status: "loaded", detail });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: detailErrorMessageFrom(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  useEffect(() => {
    // The hash as it is on arrival, then on every subsequent change.
    // `hashchange` covers the reader following a link to another tab on the
    // page they are already on, and the Back button moving between hashes —
    // neither of which remounts anything, so without this listener the URL
    // would say one tab and the page would show another.
    const applyHash = () => {
      setActiveTab(tabFromHash(window.location.hash));
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => {
      window.removeEventListener("hashchange", applyHash);
    };
  }, []);

  const onLoadAgentView = useCallback(() => {
    setAgentState({ status: "loading" });
    fetchAgentView(itemId)
      .then((view) => {
        setAgentState({ status: "loaded", view });
      })
      .catch((err: unknown) => {
        setAgentState({ status: "error", message: agentViewErrorMessageFrom(err) });
      });
  }, [itemId]);

  const onTabChange = useCallback((tab: DetailTab) => {
    setActiveTab(tab);
    // See the header: `replaceState` rather than `location.hash` so the
    // page does not scroll to the panel and the back stack stays clean.
    window.history.replaceState(null, "", hashForTab(tab));
  }, []);

  return (
    <ItemDetailView
      loadState={loadState}
      activeTab={activeTab}
      onTabChange={onTabChange}
      agentState={agentState}
      onLoadAgentView={onLoadAgentView}
    />
  );
}
