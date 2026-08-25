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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchItemDetail,
  fetchItemHistory,
  detailErrorMessageFrom,
  type DetailLoadState,
} from "@/lib/item-detail/state";
import { DEFAULT_TAB, hashForTab, tabFromHash, type DetailTab } from "@/lib/item-detail/tabs";
import type { DetailHistoryEntry } from "@/lib/item-detail/types";
import { fetchAgentView, agentViewErrorMessageFrom } from "@/lib/item-detail/orientation-state";
import {
  fieldForEdit,
  submitItemEdit,
  titleDraftIsValid,
  type EditableField,
} from "@/lib/item-detail/edit-state";
import { titleAdviceFor } from "@/lib/item-title";
import type { EventType } from "@/lib/events";
import { verifyState } from "@/lib/item-detail/verify-state";
import { currentTipCommitSha } from "@/lib/item-detail/view";
import { bodyFor, type VerifyStateStatus } from "./VerifyStateAction";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { ItemDetailView } from "./ItemDetailView";
import type { AgentPanelState } from "./AgentPanel";
import type { ArchiveActionState } from "./ArchiveAction";
import {
  submitArchive,
  submitRestore,
  archiveReasonIsValid,
  ARCHIVE_REFERENCES_GUARD,
  RESTORE_SUPERSEDED_GUARD,
} from "@/lib/item-detail/archive-state";
import { useUndo } from "@/components/toast";

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

  // ── Older history, fetched from the server on demand (T24) ───────────
  //
  // The detail response carries the newest window of the ledger. Entries
  // older than that window are reached by asking the server for them:
  // `get_item_history` pages the same table with a keyset cursor, so a
  // timeline of any depth is walkable from this screen.
  //
  // These hold the pages fetched *beyond* that window, appended in order,
  // plus the cursor to continue from. They are deliberately separate from
  // `loadState`: the detail payload is one coherent snapshot of the whole
  // screen (see `get_item_detail`'s header) and folding later pages into it
  // would quietly make it a mixture of snapshots while still looking like
  // one. Kept apart, the older pages are plainly what they are — a
  // continuation read, appended to the end of a list that is already
  // ordered newest-first.
  const [olderHistory, setOlderHistory] = useState<readonly DetailHistoryEntry[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  // Set only when a continuation page has come back reporting no next
  // cursor. Distinct from `historyCursor === null`, which is also the
  // *initial* value — conflating the two would render "no more history"
  // before a single older page had been asked for.
  const [exhaustedHistory, setExhaustedHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  const onHistoryTypeFilterChange = useCallback((type: EventType | null) => {
    setHistoryTypeFilter(type);
    // A filter change can leave a page number past the end of the now
    // narrower list — see `pageOf`'s own header on why a stale page must
    // not render as empty beneath a filter that has matches.
    setHistoryPage(0);
  }, []);

  /**
   * Fetches the next page of older history and appends it.
   *
   * The cursor starts as the id of the **oldest entry already on screen**,
   * so the first continuation picks up exactly where the detail payload's
   * window ended — no gap and no repetition. Thereafter it is whatever the
   * previous page returned.
   *
   * Guarded against re-entry (`loadingOlder`) because the pager can be
   * clicked again before a page lands, and two in-flight reads from the
   * same cursor would append the same entries twice.
   */
  const onLoadOlderHistory = useCallback(() => {
    if (loadingOlder) return;
    if (loadState.status !== "loaded") return;
    const loadedHistory = loadState.detail.history;
    const cursor =
      historyCursor ??
      olderHistory[olderHistory.length - 1]?.id ??
      loadedHistory[loadedHistory.length - 1]?.id;
    if (cursor === undefined) return;
    setLoadingOlder(true);
    setOlderError(null);
    fetchItemHistory(itemId, { cursor })
      .then((page) => {
        setLoadingOlder(false);
        setOlderHistory((existing) => [...existing, ...page.entries]);
        setHistoryCursor(page.nextCursor);
        if (page.nextCursor === null) setExhaustedHistory(true);
      })
      .catch((err: unknown) => {
        setLoadingOlder(false);
        setOlderError(detailErrorMessageFrom(err));
      });
  }, [loadingOlder, loadState, historyCursor, olderHistory, itemId]);

  /**
   * Whether the ledger holds anything older than what is on screen.
   *
   * Before any continuation, the detail payload's `historyTruncated` is the
   * only evidence — it is exactly the "there is more" fact
   * `get_item_detail` reads one row past its cap to establish. Once a
   * continuation has come back, the server's `nextCursor` supersedes it.
   */
  const hasOlderHistory =
    !exhaustedHistory &&
    (olderHistory.length > 0 ||
      (loadState.status === "loaded" && loadState.detail.historyTruncated));

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
        // **`outcome.item` is deliberately discarded, and that is what makes
        // the narrow response safe.** `submitItemEdit` does not send
        // `full: true`, so what comes back is the slim write shape — five
        // fields, none of the four this tab can edit beyond `title` and
        // `headline`. Nothing here reads it. If this ever stops re-fetching
        // and starts patching local state from the response instead, the
        // request needs `full: true` first; `ItemEditResult` names exactly
        // what is available so that mistake fails to compile.
        //
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

  // The "confirm state" action's submit state (MILESTONES.md #131) — same
  // idle/loading/error shape as `agentState`, and reset per outcome click
  // rather than accumulated, so a second click after an error tries fresh
  // rather than compounding a stale one.
  const [verifyStateStatus, setVerifyStateStatus] = useState<VerifyStateStatus>({
    status: "idle",
  });
  const { activeProfile } = useProfile();

  // ── Archive and restore ──────────────────────────────────────
  //
  // The affordance `restore_item` was built for. See `ArchiveAction.tsx` for
  // why archiving is a reason form rather than a confirm dialog, and
  // `@/lib/item-detail/archive-state.ts` for why every refusal reaches the
  // person as the server's own sentence.
  const [archiveState, setArchiveState] = useState<ArchiveActionState>({ status: "idle" });
  const { offer } = useUndo();

  /**
   * The current archive state, readable synchronously by an event handler.
   *
   * **This is the discipline that stops a defect this repo has shipped three
   * times.** `onArchive` has to know what reason was typed, and `onAcknowledge`
   * which refusal it is acknowledging — both of which live in `archiveState`,
   * and both of which are needed *at the moment of the click*, not on the
   * render after. Deriving them inside a `setArchiveState` updater is exactly
   * the shape that failed in `Board.tsx` and again in `UndoToastHost.tsx`: an
   * updater is not a callback that runs when you call it. React evaluates one
   * eagerly only when no update is already pending on the fiber and defers it
   * otherwise, and StrictMode invokes it twice — so a value assigned inside it
   * is not reliably set on the next line, the early return fires, and no
   * request is ever sent.
   *
   * A ref is readable now. Every write to `archiveState` writes here too, so
   * this is the same value in a form a handler can read, not a second source
   * of truth. `scripts/check-updater-side-effects.mjs` keeps it that way
   * mechanically, and `tests/item-archive-react-wiring.test.ts` proves the
   * composition works under real React.
   */
  const latestArchiveState = useRef<ArchiveActionState>({ status: "idle" });

  /** Writes both, together, so the ref can never lag the state it mirrors. */
  const applyArchiveState = useCallback((next: ArchiveActionState) => {
    latestArchiveState.current = next;
    setArchiveState(next);
  }, []);

  const onBeginArchive = useCallback(() => {
    applyArchiveState({ status: "composing", reason: "" });
  }, [applyArchiveState]);

  const onCancelArchive = useCallback(() => {
    applyArchiveState({ status: "idle" });
  }, [applyArchiveState]);

  const onArchiveReasonChange = useCallback(
    (reason: string) => {
      applyArchiveState({ status: "composing", reason });
    },
    [applyArchiveState],
  );

  /**
   * Re-reads the item after an archive or restore landed.
   *
   * The page re-reads rather than patching `archivedAt` locally, because both
   * writes change what the row *is* — the archived notice depends on
   * `archivedReason` and `supersededById`, neither of which the client can
   * invent. Matches what `onSaveEdit` above already does after a successful
   * write, for the same reason: one source of truth for what the server says.
   */
  const reloadDetail = useCallback(() => {
    fetchItemDetail(itemId)
      .then((detail) => setLoadState({ status: "loaded", detail }))
      .catch(() => {
        // The write already succeeded. A failed re-read leaves the page
        // showing the pre-write value until the next natural reload rather
        // than surfacing an error for something that worked.
      });
  }, [itemId]);

  /**
   * Sends the archive, and — on success — **offers the undo**.
   *
   * That `offer` call is the point of this whole affordance. The undo spine is
   * complete and, without this caller, unreachable: `inverseOf` derives a real
   * `UndoRestoreStep` for `kind: "archive"`, `runUndo` posts it to
   * `/api/items/{id}/restore`, and `UndoToast` renders the button — but
   * nothing else in the product ever constructs an `archive` action, so none
   * of it can run. This is its only caller.
   *
   * Offered **after** the write is accepted, per `UndoApi.offer`'s contract,
   * so the toast never promises to undo something that did not happen.
   */
  const runArchive = useCallback(
    (reason: string, acknowledgeReferences: boolean) => {
      if (loadState.status !== "loaded") return;
      const { item } = loadState.detail;
      applyArchiveState({ status: "submitting" });
      submitArchive(item.id, {
        reason,
        ...(acknowledgeReferences ? { acknowledgeReferences: true } : {}),
      })
        .then((outcome) => {
          if (!outcome.ok) {
            applyArchiveState({
              status: "error",
              message: outcome.message,
              guard: outcome.guard,
              supersededById: outcome.supersededById,
              // The typed reason survives the refusal — see `ArchiveActionState`.
              reason,
            });
            return;
          }
          applyArchiveState({ status: "idle" });
          // `at` is stamped here so the undo window measures from the moment
          // the write landed.
          offer({
            kind: "archive",
            at: Date.now(),
            itemId: item.id,
            itemTitle: item.title,
          });
          reloadDetail();
        })
        .catch(() => {
          applyArchiveState({
            status: "error",
            message: "Could not archive this item. Try again.",
            guard: null,
            supersededById: null,
            reason,
          });
        });
    },
    [loadState, applyArchiveState, offer, reloadDetail],
  );

  const onArchive = useCallback(() => {
    // Read from the ref, synchronously — see `latestArchiveState`. The reason
    // submitted is the one on screen at the moment of the click.
    const current = latestArchiveState.current;
    if (current.status !== "composing" && current.status !== "error") return;
    if (!archiveReasonIsValid(current.reason)) return;
    runArchive(current.reason, false);
  }, [runArchive]);

  const runRestore = useCallback(
    (acknowledgeSuperseded: boolean) => {
      if (loadState.status !== "loaded") return;
      const { item } = loadState.detail;
      applyArchiveState({ status: "submitting" });
      submitRestore(item.id, acknowledgeSuperseded ? { acknowledgeSuperseded: true } : {})
        .then((outcome) => {
          if (!outcome.ok) {
            applyArchiveState({
              status: "error",
              message: outcome.message,
              guard: outcome.guard,
              supersededById: outcome.supersededById,
              // Nothing is composed for a restore; the field belongs to the
              // archive form and is empty here rather than absent, so the
              // state stays one shape.
              reason: "",
            });
            return;
          }
          applyArchiveState({ status: "idle" });
          reloadDetail();
        })
        .catch(() => {
          applyArchiveState({
            status: "error",
            message: "Could not restore this item. Try again.",
            guard: null,
            supersededById: null,
            reason: "",
          });
        });
    },
    [loadState, applyArchiveState, reloadDetail],
  );

  const onRestore = useCallback(() => {
    runRestore(false);
  }, [runRestore]);

  /**
   * Retries the refused call with the acknowledgement the person just read.
   *
   * Which call to retry is decided from the **refusing guard**, not from the
   * item's archived flag. The two normally agree, but the guard is the thing
   * that actually knows what was attempted: a superseded refusal can only have
   * come from a restore, and a references refusal only from an archive.
   * Reading the guard means this cannot send the wrong verb if the row's state
   * and the pending refusal ever disagree.
   */
  const onAcknowledge = useCallback(() => {
    const current = latestArchiveState.current;
    if (current.status !== "error") return;
    if (current.guard === RESTORE_SUPERSEDED_GUARD) {
      runRestore(true);
      return;
    }
    if (current.guard === ARCHIVE_REFERENCES_GUARD) {
      runArchive(current.reason, true);
    }
    // Any other guard is not acknowledgeable and the control is not rendered
    // for it (`isAcknowledgeable`), so there is nothing to do here.
  }, [runArchive, runRestore]);

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

  // Records a `historical_verification` for the outcome the reader picked.
  //
  // **Refuses to guess a person.** `record_artifact` will not accept
  // `createdByType: "person"` without a real id (`resolveCreator`'s own
  // reasoning: a default of `person` would let anything satisfy the clause
  // that exists to require a human). With nobody chosen in the profile
  // switcher, `activeProfile` is `null`, and this reports that rather than
  // sending a request the server would refuse anyway.
  //
  // `loadState.status === "loaded"` is required for the item's id and
  // current `state` — the outcome's recorded `body` names which state was
  // checked (`bodyFor`), so a stale or absent load has nothing honest to
  // write.
  const onVerifyState = useCallback(
    (outcome: "agrees" | "disagrees") => {
      if (loadState.status !== "loaded") return;
      if (activeProfile === null) {
        setVerifyStateStatus({
          status: "error",
          message: "Choose who you are (top right) before recording a verification.",
        });
        return;
      }
      const { item, artifacts } = loadState.detail;
      // The exact same derivation `ItemDetailView` used to decide the
      // button could be offered — reused rather than re-derived, so the
      // commit this records against can never disagree with the one shown.
      const tipCommitSha = currentTipCommitSha(artifacts);
      if (tipCommitSha === null) return;

      setVerifyStateStatus({ status: "submitting" });
      verifyState({
        itemId: item.id,
        commitSha: tipCommitSha,
        body: bodyFor(outcome, item.state),
        createdByType: "person",
        createdById: activeProfile.id,
      })
        .then((result) => {
          if (result.ok) {
            setVerifyStateStatus({ status: "done" });
          } else {
            setVerifyStateStatus({ status: "error", message: result.message });
          }
        })
        .catch(() => {
          setVerifyStateStatus({
            status: "error",
            message: "Could not record the verification. Try again.",
          });
        });
    },
    [loadState, activeProfile],
  );

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
      olderHistory={olderHistory}
      onLoadOlderHistory={onLoadOlderHistory}
      loadingOlderHistory={loadingOlder}
      olderHistoryError={olderError}
      /* Whether anything older than what is on screen remains.
         BEFORE the first continuation, the only evidence is the detail
         payload's own `historyTruncated`. AFTER one, the server's
         `nextCursor` is authoritative and `historyCursor` holds it — null
         means the ledger is exhausted. The two cases are distinguished by
         `exhaustedHistory`, which is set only once a page has come back,
         so an unfetched `historyCursor` of null is never mistaken for
         "there is no more". */
      hasOlderHistory={hasOlderHistory}
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
      verifyStateStatus={verifyStateStatus}
      onVerifyState={onVerifyState}
      archive={{
        state: archiveState,
        onBeginArchive,
        onCancel: onCancelArchive,
        onReasonChange: onArchiveReasonChange,
        onArchive,
        onRestore,
        onAcknowledge,
      }}
    />
  );
}
