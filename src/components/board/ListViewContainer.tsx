"use client";

// The list's thin container — the counterpart to `Board.tsx`, for the other
// layout.
//
// Fetches `GET /api/board` through the same `fetchBoard`/`fetchBoardColumn`
// the kanban uses, reads who's active from the profile context, and hands
// both to `ListView` as plain props. **This is the whole reason the two
// layouts show the same set**: there is one fetch path, one request encoder
// (`boardRequestParams`) and one `BoardQuery`, so a filter cannot be applied
// to one layout's request and not the other's. A second fetch written here
// is exactly how the two would come to disagree.
//
// **No database access, and none possible** — the same constraint
// `Board.tsx` states: nothing under `src/components/` imports the service
// layer or the database client, and `npm run check:db-imports` enforces it
// independently of lint.
//
// **Deliberately no drag wiring.** Reordering by dragging a row is not a
// gesture this layout offers, so none of `@/lib/board/drag-state` is
// imported. That keeps the container to the two things it genuinely needs
// React for — holding the loaded board and issuing the request.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useProfile } from "@/lib/profile/ProfileProvider";
import {
  fetchBoard,
  fetchBoardColumn,
  boardErrorMessageFrom,
  type BoardLoadState,
} from "@/lib/board/state";
import { emptyBoard } from "@/lib/board/view";
import { boardWithPage } from "@/lib/board/paging";
import type { Board, BoardColumnId } from "@/lib/board/types";
import { isFiltered, parseBoardQuery, withoutFilters, boardHref } from "@/lib/board/filters";
import {
  emptyFilterOptions,
  fetchFilterOptions,
  type FilterOptions,
} from "@/lib/board/filter-options";
import { fetchSavedViews } from "@/lib/board/saved-views-client";
import type { SavedViews } from "@/lib/board/saved-views";
import { listEntries } from "@/lib/board/list";
import {
  emptySelection,
  isSelected as isRowSelected,
  rangeFrom,
  reconcile,
  selectAll,
  selectableIds,
  selectedEntries,
  selectionSize,
  toggle,
  type Selection,
} from "@/lib/board/selection";
import { describeBulkOutcome, runBulkTransition, type BulkOutcome } from "@/lib/board/bulk";
import {
  applyOptimisticMove,
  findEntry,
  reconcile as reconcileMove,
  revertMove,
} from "@/lib/board/drag";
import { isStatusMove } from "@/lib/board/status-picker";
import { requestMove } from "@/lib/board/move";
import { isItemState } from "@/lib/service/state-machine/states";
import { useUndo } from "@/components/toast";
import { stateLabel } from "@/lib/undo";
import { BoardFilterBar } from "./BoardFilterBar";
import { ListView } from "./ListView";
import { BulkActionBar, type BulkAction, type BulkReport } from "./BulkActionBar";

export function ListViewContainer() {
  const { activeProfile } = useProfile();
  const router = useRouter();
  const searchParams = useSearchParams();

  // **The URL is the state, not a mirror of it** — the same contract
  // `Board.tsx` keeps, and keeping it identically is what makes the toggle
  // between layouts lossless: both components read the SAME query string
  // through the SAME parser, so switching layout re-reads the filters that
  // were already in the address rather than re-deriving them from anything
  // held in memory. There is nothing held in memory to lose.
  const queryString = searchParams.toString();
  const boardQuery = useMemo(() => parseBoardQuery(queryString), [queryString]);
  const filtered = isFiltered(boardQuery.filters);

  // The bar's own data. Fetched here for the same reason `Board.tsx`
  // fetches it: the list renders the SAME filter bar, so it needs the same
  // vocabularies and the same pinned views. Both resolve to empty rather
  // than throwing — a failure to load the select options must not take the
  // list down with it.
  const [options, setOptions] = useState<FilterOptions>(() => emptyFilterOptions());
  const [savedViews, setSavedViews] = useState<SavedViews>([]);

  const [board, setBoard] = useState<Board>(() => emptyBoard());
  const [status, setStatus] = useState<"loading" | "error" | "loaded">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [loadingColumns, setLoadingColumns] = useState<Partial<Record<BoardColumnId, boolean>>>({});
  const [pageErrors, setPageErrors] = useState<Partial<Record<BoardColumnId, string>>>({});
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * The clock, sampled once per load — the same reasoning `Board.tsx`
   * gives: reading `Date.now()` during render would produce a different
   * tree on the server than on the client for the same data (a hydration
   * mismatch), and every row would disagree about "now".
   */
  const [now, setNow] = useState(0);

  // **The ref is the authoritative copy; `board` is what renders.**
  //
  // Both are written together and only ever through `applyBoard`, so they
  // cannot diverge. The ref exists because `onShowMore` has to read the
  // newest cursor synchronously — see the comment there for the defect that
  // costs. It is never read or written during render, which is what
  // `react-hooks/refs` protects: a ref read during render would not
  // re-render when it changed.
  const boardRef = useRef(board);

  /** The single write path — advances the ref synchronously and schedules the render. */
  const applyBoard = useCallback((next: Board) => {
    boardRef.current = next;
    setBoard(next);
  }, []);

  // ── Selection and bulk actions (T6-E) ──────────────────────────────
  //
  // **The ref is the authoritative copy; `selection` is what renders** —
  // the same arrangement `boardRef` above uses, and for a sharper reason.
  //
  // Every selection gesture is a function of the CURRENT selection: a
  // toggle needs to know whether the row is already in it, a shift-click
  // needs its anchor, and a bulk needs the whole set. The tempting way to
  // get that is to compute it inside a `setSelection` updater, which is the
  // defect that has shipped three times in this repo — React defers an
  // updater whenever a lane is already pending on the fiber (and this
  // component always has one: the mount-time `fetchBoard().then(...)`), and
  // StrictMode invokes it twice. A value assigned in there and read on the
  // next line is not reliably set, and `scripts/check-updater-side-effects.mjs`
  // exists because of it.
  //
  // So the handlers below read `selectionRef.current` **synchronously,
  // before** calling `setSelection`, compute the next value with the pure
  // functions in `@/lib/board/selection`, and pass a plain VALUE to the
  // setter rather than an updater. There is nothing left inside an updater
  // to be deferred, which is what makes the defect structurally absent here
  // rather than merely avoided.
  const [selection, setSelectionState] = useState<Selection>(() => emptySelection());
  const selectionRef = useRef<Selection>(selection);
  /** The single write path — advances the ref synchronously and schedules the render. */
  const applySelection = useCallback((next: Selection) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);

  /** The bulk in flight, or null. Drives the bar's progress and disables its buttons. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** What the last finished bulk did. Survives the selection being cleared. */
  const [report, setReport] = useState<BulkReport | null>(null);
  // Guards against a second bulk starting while one is running. Held as a
  // ref rather than derived from `progress`, because the check happens in
  // the same tick as the click and `progress` would still be the previous
  // render's value.
  const runningRef = useRef(false);

  const { offer } = useUndo();

  // **`boardQuery` is in the dependency list**, so changing a filter or the
  // sort re-reads the list — the whole of "the filter is applied", with no
  // separate apply step and nothing to keep in step.
  useEffect(() => {
    let cancelled = false;
    fetchBoard(fetch, boardQuery)
      .then((next) => {
        if (cancelled) return;
        applyBoard(next);
        setNow(Date.now());
        setStatus("loaded");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMessage(boardErrorMessageFrom(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [applyBoard, reloadNonce, boardQuery]);

  // Neither depends on the filters, so re-reading them on every filter
  // change would be two requests per keystroke for lists that did not move.
  useEffect(() => {
    let cancelled = false;
    void fetchFilterOptions().then((next) => {
      if (!cancelled) setOptions(next);
    });
    void fetchSavedViews().then((next) => {
      if (!cancelled) setSavedViews(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Fetch one section's next page and append it.
   *
   * The merge rule — append rather than replace, take the cursor and total
   * from the new page, never re-add an entry already shown — is
   * `@/lib/board/paging`'s `boardWithPage`, the same function the kanban
   * pages with. Reimplementing the merge here is how the two layouts would
   * come to page differently over identical data.
   */
  const onShowMore = useCallback(
    (column: BoardColumnId) => {
      setLoadingColumns((current) => ({ ...current, [column]: true }));
      // Cleared on the attempt, not on its success: leaving the previous
      // failure on screen while a retry is in flight reports a stale
      // failure as a current one.
      setPageErrors((current) => ({ ...current, [column]: undefined }));
      // **The cursor is read synchronously from the ref, never out of a
      // `setState` updater.** Two reasons, and the second is the one that
      // bites:
      //
      //   - a `setState` updater must be PURE. React invokes it eagerly or
      //     lazily at its own discretion, and twice in StrictMode — so a
      //     fetch issued from inside one is a fetch that fires twice in
      //     development and at an unpredictable moment in production.
      //   - a cursor read from the render-time `board` would be the
      //     previous page's on a second press before the first render had
      //     committed, which re-requests the page already shown and makes
      //     the control appear to do nothing.
      //
      // The ref is written wherever the board is (see `applyBoard`), so it
      // is always the newest value.
      const section = boardRef.current[column];
      // A withheld column has no cursor and has never been read, so its
      // "load" is a first page rather than a next one — `undefined` asks
      // for exactly that, and is why this is not guarded on `nextCursor`.
      const cursor = section.nextCursor ?? undefined;
      // **The same filters and the same sort as the first page.** A "show
      // more" that dropped them would page an unfiltered, differently
      // ordered sequence into a filtered section — and because the cursor
      // is keyset on the sort key, a page requested under a different sort
      // is drawn from a sequence the cursor does not belong to.
      void fetchBoardColumn(column, {
        query: boardQuery,
        ...(cursor === undefined ? {} : { cursor }),
      })
        .then((page) => {
          applyBoard(boardWithPage(boardRef.current, column, page));
        })
        .catch((err: unknown) => {
          setPageErrors((errors) => ({ ...errors, [column]: boardErrorMessageFrom(err) }));
        })
        .finally(() => {
          setLoadingColumns((columns) => ({ ...columns, [column]: false }));
        });
    },
    [applyBoard, boardQuery],
  );

  // ── The selection's handlers ───────────────────────────────────────

  /** Every row the list renders, flat, in the order the reader sees them. */
  const rows = useMemo(() => listEntries(board), [board]);
  /** The ids a reader may select — projects excluded (see `isSelectable`). */
  const selectable = useMemo(() => selectableIds(rows), [rows]);

  /**
   * Drop from the selection anything the board omits.
   *
   * **This is the "survives what it should, clears when it should" rule**,
   * and it lives in one effect so there is one answer rather than one per
   * path. A filter change, a page, a retry and a completed bulk all end in
   * a new `board`, and all of them go through here: a row still shown keeps
   * its tick, a row that has gone loses it. The alternative — clearing on
   * every load — would throw away a selection every time the reader pressed
   * "show more", which is precisely when a large selection is being built.
   *
   * `reconcile` returns the SAME object when nothing changed, so this
   * settles after one pass instead of re-triggering itself.
   */
  useEffect(() => {
    const next = reconcile(selectionRef.current, selectable);
    if (next !== selectionRef.current) applySelection(next);
  }, [selectable, applySelection]);

  /**
   * A click on a row's checkbox.
   *
   * The shift-modifier decides which pure function applies; both are
   * computed from the ref, synchronously, before the setter is called.
   */
  const onToggle = useCallback(
    (id: string, shiftKey: boolean) => {
      const current = selectionRef.current;
      applySelection(shiftKey ? rangeFrom(current, id, selectable) : toggle(current, id));
    },
    [applySelection, selectable],
  );

  const onSelectAll = useCallback(
    (select: boolean) => {
      applySelection(selectAll(selectable, select));
    },
    [applySelection, selectable],
  );

  const onClearSelection = useCallback(() => {
    applySelection(emptySelection());
    // The report goes with it: it describes a selection the reader has
    // just dismissed, and leaving it on screen next to an empty bar would
    // report a result with nothing to connect it to.
    setReport(null);
  }, [applySelection]);

  /**
   * Run a bulk action against the current selection.
   *
   * **The selection is resolved to entries here, once, from the ref** — not
   * inside an updater, and not from a render-time value that a click in the
   * same tick could have superseded. `selectedEntries` intersects it with
   * the board that is actually loaded, so a row that has left the view
   * cannot be acted on even if its id is still in the set.
   */
  const onBulkAction = useCallback(
    (action: BulkAction) => {
      if (runningRef.current) return;
      const chosen = selectedEntries(selectionRef.current, listEntries(boardRef.current));
      if (chosen.length === 0) return;

      const label = stateLabel(action.to);
      // **The confirm is a real gate, and it is only on the destructive
      // one.** `window.confirm` rather than a bespoke modal: this is one
      // yes/no question with no state of its own, and the palette's overlay
      // machinery would have to be taught about it for no gain the reader
      // can see. It names the count, because the count is the thing that
      // makes a mis-click expensive.
      if (action.confirm) {
        const noun = chosen.length === 1 ? "1 item" : `${chosen.length} items`;
        if (!window.confirm(`Move ${noun} to ${label}? You can undo this.`)) return;
      }

      runningRef.current = true;
      setReport(null);
      setProgress({ done: 0, total: chosen.length });

      void runBulkTransition(chosen, action.to, fetch, (done) => {
        setProgress({ done, total: chosen.length });
      })
        .then((outcome: BulkOutcome) => {
          // **The undo is offered for the items that actually moved, and
          // only those.** Handing the whole selection over would offer to
          // put back rows that were never moved — `inverseOf` filters
          // no-ops per item, and a refused row has no `from`/`to` pair to
          // filter, so including it would be inventing a move.
          //
          // Offered only when something moved: `inverseOf` returns an
          // unavailable plan for a bulk whose moves are all no-ops
          // (`tests/undo-actions.test.ts` asserts exactly that), and the
          // toast would then show a button that cannot work. Not offering
          // is the honest form of the same fact.
          if (outcome.moved.length > 0) {
            offer({
              kind: "bulk",
              at: Date.now(),
              to: action.to,
              moves: outcome.moved,
            });
          }

          setReport({
            message: describeBulkOutcome(outcome, label),
            refused: outcome.refused.map((refusal) => ({
              title: refusal.title,
              // The state the server said it is actually in, when it said
              // so — that is what makes the refusal checkable against the
              // row rather than a shrug.
              detail:
                refusal.currentState === null
                  ? refusal.message
                  : `now in ${stateLabel(refusal.currentState)}`,
            })),
          });

          // **The selection clears only for the rows that moved.** The
          // refused ones stay ticked, which is the useful behaviour: they
          // are exactly the rows the reader may want to retry or look at,
          // and clearing them would make the reader re-find them against a
          // report that names them by title.
          const movedIds = new Set(outcome.moved.map((move) => move.itemId));
          const current = selectionRef.current;
          const kept = new Set<string>();
          for (const id of current.ids) if (!movedIds.has(id)) kept.add(id);
          applySelection({
            ids: kept,
            anchor: current.anchor !== null && kept.has(current.anchor) ? current.anchor : null,
          });

          // Re-read the board so the moved rows appear where they now are.
          setReloadNonce((n) => n + 1);
        })
        .finally(() => {
          runningRef.current = false;
          setProgress(null);
        });
    },
    [applySelection, offer],
  );

  // ── The status picker (MILESTONES.md #76) ──────────────────────────
  //
  // The mobile stand-in for dragging a card between columns. It reuses the
  // drag's own machinery deliberately — `isStatusMove` delegates to
  // `isMove`, and the optimistic update, the revert and the reconcile are
  // the SAME three functions the kanban's drop handler calls. A second
  // implementation of "move an item to a column" is exactly how the two
  // surfaces would come to disagree about what a move means.
  const [statusPending, setStatusPending] = useState<Record<string, boolean>>({});
  // The picker's own refusal message. Deliberately NOT `BulkReport`: that
  // shape belongs to the bulk bar, describes a batch, and carries no tone —
  // borrowing it would put a single row's refusal in a component whose
  // whole subject is a multi-row operation.
  const [statusRefusal, setStatusRefusal] = useState<string | null>(null);

  const onStatusPick = useCallback(
    (itemId: string, column: BoardColumnId) => {
      const entry = findEntry(boardRef.current, itemId);
      // Gone from the board between render and tap, which a background
      // reload can do. Nothing truthful to move.
      if (entry === null) return;
      // Not a move: the item is already in that column, or it is a project.
      // The picker does not offer either, so reaching here means the board
      // changed underneath — dropping it is right, and issuing it would
      // write a state-change event recording that nothing happened.
      if (!isStatusMove(entry, column)) return;

      // **`expectedFrom` is captured BEFORE the optimistic move overwrites
      // it.** It must be the state the server last reported, not the column
      // the row is moving from — `move.ts` is explicit that a guard which
      // landed the item somewhere unrequested would otherwise make the UI
      // name a state the item was never in, turning an honest 409 into a
      // confidently wrong message.
      const expectedFrom = entry.item.state;

      setStatusRefusal(null);
      setStatusPending((pending) => ({ ...pending, [itemId]: true }));
      applyBoard(applyOptimisticMove(boardRef.current, itemId, column));

      void requestMove(itemId, column, expectedFrom, fetch)
        .then((result) => {
          if (result.ok) {
            // Settle on what the SERVER returned, never on the guess — a
            // guard may land the item somewhere other than the requested
            // state, and the response says where.
            applyBoard(reconcileMove(boardRef.current, result.entry));
            // **Narrowed, not cast** — the same reasoning `drop-handler.ts`
            // gives: a board item's `state` is typed `string` because it
            // arrives over the wire, while an undo's `ItemMove` becomes the
            // `to` and the `expectedFrom` of a real transition request. A
            // cast would let an unrecognised string through and produce an
            // undo the server refuses on press, after the person was told
            // it was available. No undo offered is the honest outcome.
            const to = result.entry.item.state;
            if (isItemState(expectedFrom) && isItemState(to)) {
              offer({
                kind: "state-change",
                at: Date.now(),
                move: { itemId, from: expectedFrom, to },
                itemTitle: entry.item.title,
              });
            }
            return;
          }
          // Refused. The row goes back exactly as it was — `revertMove`
          // takes the original entry rather than a column, so the state the
          // optimistic move guessed at is restored too.
          applyBoard(revertMove(boardRef.current, entry));
          setStatusRefusal(result.message);
        })
        .finally(() => {
          setStatusPending((pending) => {
            const next = { ...pending };
            delete next[itemId];
            return next;
          });
        });
    },
    [applyBoard, offer],
  );

  const loadState: BoardLoadState =
    status === "error"
      ? { status: "error", message: errorMessage }
      : status === "loading"
        ? { status: "loading" }
        : { status: "loaded", board };

  return (
    <>
      {/* The same bar the kanban renders, with the same props — which is
          what makes the layout toggle preserve the filters in the
          interface as well as in the URL. A list with its own reduced bar
          would be a second place for an axis to be forgotten. */}
      <BoardFilterBar
        query={boardQuery}
        options={options}
        views={savedViews}
        onViewsChange={setSavedViews}
      />
      <ListView
        loadState={loadState}
        personId={activeProfile?.id ?? null}
        now={now}
        filtered={filtered}
        onClearFilter={() =>
          // **`withoutFilters` keeps the layout**, because it spreads the
          // whole query. Clearing a filter must not also throw the reader
          // back to the kanban — that would be the interface undoing a
          // choice the reader did not ask it to undo.
          router.replace(boardHref(withoutFilters(boardQuery)), { scroll: false })
        }
        onRetry={() => {
          setStatus("loading");
          setErrorMessage("");
          setReloadNonce((n) => n + 1);
        }}
        paging={{ onShowMore, loadingColumns, errors: pageErrors }}
        statusPick={{
          onPick: onStatusPick,
          pending: statusPending,
          refusal: statusRefusal,
          onDismissRefusal: () => setStatusRefusal(null),
        }}
        selection={{
          isSelected: (id) => isRowSelected(selection, id),
          onToggle,
          onSelectAll,
          // **Both computed against the SELECTABLE rows, not every row.** A
          // list whose only unselected row is a project would otherwise
          // never show the header box as checked, because the project can
          // never be ticked — the box would sit permanently indeterminate
          // and "select all" would appear not to have worked.
          allSelected: selectable.length > 0 && selectionSize(selection) >= selectable.length,
          someSelected: selectionSize(selection) > 0,
        }}
      />
      {/* Below the list, so it does not push the rows the reader is
          selecting. It is `position: sticky; bottom: 0`, so it stays
          reachable without covering the top of the list. */}
      <BulkActionBar
        count={selectionSize(selection)}
        onAction={onBulkAction}
        onClear={onClearSelection}
        progress={progress}
        report={report}
      />
    </>
  );
}
