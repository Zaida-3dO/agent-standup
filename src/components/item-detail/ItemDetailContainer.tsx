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
import {
  fieldForEdit,
  submitItemEdit,
  titleDraftIsValid,
  type EditableField,
} from "@/lib/item-detail/edit-state";
import { titleAdviceFor } from "@/lib/item-title";
import type { EventType } from "@/lib/events";
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

  // What the status block measures the item's age against.
  //
  // **Zero until the load lands, then the clock read once.** Starting at
  // `Date.now()` would read the clock during the server render and again on
  // the client, producing two different ages for the same HTML — a
  // hydration mismatch, and the same trap the tab-from-hash state above
  // avoids. Set alongside the loaded detail rather than in its own effect,
  // so the age and the data it describes are the same render: an age
  // applied one render later would show every item as zero seconds old for
  // a frame.
  //
  // A `now` of 0 is safe rather than merely unused: `ageMsOf` floors at
  // zero, so an epoch "now" against any real `updatedAt` yields age 0 —
  // which is the `fresh` band, and `StalenessDot` renders nothing there.
  // The pre-load value therefore under-reports staleness for the one render
  // before the fetch resolves, rather than painting every item as
  // abandoned. Under-reporting is the correct direction for a default:
  // a spurious "abandoned" flag on every fresh load would train a reader to
  // ignore the flag.
  const [now, setNow] = useState(0);

  // The agent view is a SECOND read, and deliberately not made on arrival.
  // `orientation` is the most expensive call this page can issue — it
  // embeds the whole item record and an unbounded event list — and the
  // panel that shows it is the one a reader opens rarely and on purpose.
  // Fetching it with the detail would put the page's largest cost on every
  // visit, including every visit that never opens the tab.
  const [agentState, setAgentState] = useState<AgentPanelState>({ status: "idle" });

  // Activity tab state — the type filter and the page, kept here rather
  // than inside `HistoryList` because that component is hook-free by
  // convention (see its own header) and the filter has to reset the page
  // to zero the moment it changes, which is a cross-field rule a single
  // component's own state cannot express without a hook.
  const [historyTypeFilter, setHistoryTypeFilter] = useState<EventType | null>(null);
  const [historyPage, setHistoryPage] = useState(0);

  const onHistoryTypeFilterChange = useCallback((type: EventType | null) => {
    setHistoryTypeFilter(type);
    // A filter change can leave a page number past the end of the now
    // narrower list — see `pageOf`'s own header on why a stale page must
    // not render as empty beneath a filter that has matches.
    setHistoryPage(0);
  }, []);

  // ── Inline edit — title, headline, priority, area (M10 T10) ───────────
  //
  // One field at a time, per `EditingField`'s own reasoning: at most one of
  // the four is ever mid-edit, so this is one `editingField` plus one
  // `draft` rather than four independent pairs.
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const onStartEdit = useCallback(
    (field: EditableField) => {
      if (loadState.status !== "loaded") return;
      const { item } = loadState.detail;
      const current =
        field === "title"
          ? item.title
          : field === "headline"
            ? (item.headline ?? "")
            : field === "priority"
              ? item.priority
              : item.area;
      setEditingField(field);
      setDraft(current);
      setEditError(null);
    },
    [loadState],
  );

  const onCancelEdit = useCallback(() => {
    setEditingField(null);
    setDraft("");
    setEditError(null);
  }, []);

  const onSaveEdit = useCallback(() => {
    if (editingField === null || loadState.status !== "loaded") return;
    if (editingField === "title" && !titleDraftIsValid(draft)) return;
    setSaving(true);
    setEditError(null);
    const itemId = loadState.detail.item.id;
    submitItemEdit(itemId, fieldForEdit(editingField, draft))
      .then((outcome) => {
        setSaving(false);
        if (!outcome.ok) {
          setEditError(outcome.message);
          return;
        }
        setEditingField(null);
        setDraft("");
        // Re-fetches the whole detail rather than patching the saved field
        // into local state, so the edit is reflected the same way any
        // other change to the item would be — one source of truth for
        // "what does the server say now" — and so a field that changed the
        // item's derived `column` (an edit to `priority` never does, but
        // the same path handles every field uniformly) is not shown stale.
        fetchItemDetail(itemId)
          .then((detail) => setLoadState({ status: "loaded", detail }))
          .catch(() => {
            // The save already succeeded; a failed re-fetch leaves the
            // page showing the pre-edit value until the next natural
            // reload rather than surfacing a scary error for a write that
            // worked.
          });
      })
      .catch((err: unknown) => {
        setSaving(false);
        setEditError(err instanceof Error ? err.message : "Could not save this edit.");
      });
  }, [editingField, draft, loadState]);

  const titleAdvice = editingField === "title" ? titleAdviceFor(draft) : null;

  useEffect(() => {
    let cancelled = false;
    fetchItemDetail(itemId)
      .then((detail) => {
        if (cancelled) return;
        setNow(Date.now());
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
      now={now}
      agentState={agentState}
      onLoadAgentView={onLoadAgentView}
      historyTypeFilter={historyTypeFilter}
      onHistoryTypeFilterChange={onHistoryTypeFilterChange}
      historyPage={historyPage}
      onHistoryPageChange={setHistoryPage}
      edit={{
        editingField,
        draft,
        onDraftChange: setDraft,
        onStartEdit,
        onSaveEdit,
        onCancelEdit,
        saving,
        editError,
        titleAdvice,
      }}
    />
  );
}
