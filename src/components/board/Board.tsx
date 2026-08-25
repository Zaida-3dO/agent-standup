"use client";

// The thin container: fetches `GET /api/board` once, reads who's active
// from the profile context, and hands both to `BoardView` as plain props.
// Kept deliberately empty of branching — see `BoardView.tsx`'s header for
// why the conditionals live there instead, where they're directly testable.
//
// **No database access, and none possible.** This calls the HTTP adapter,
// which is itself a thin shell over one `service.call("get_board", …)`
// (CLAUDE.md: "Every adapter is a thin shell over a service call"). Nothing
// under `src/components/` imports the service layer or the database client;
// `npm run check:db-imports` enforces that independently of lint.
// **The drag interaction's logic is NOT here** (#73). Every state
// transition it makes lives in `@/lib/board/drag-state` as a pure function
// over plain data, so a whole drag — pick up, drop, optimistic move,
// refusal, revert — is testable as a sequence of calls without a DOM. What
// is left in this component is the part that genuinely needs React: holding
// the state and making the request.
//
// **Paging follows the same split.** The merge rule a "show more" applies —
// append rather than replace, take the cursor and the total from the new
// page, never re-add an entry already shown — is `@/lib/board/paging`'s
// `boardWithPage`, so it is provable without a renderer. What is here is the
// request and the per-column in-flight/error bookkeeping.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useProfile } from "@/lib/profile/ProfileProvider";
import {
  fetchBoard,
  fetchBoardColumn,
  fetchSubtasks,
  boardErrorMessageFrom,
  type BoardLoadState,
} from "@/lib/board/state";
import { emptyBoard } from "@/lib/board/view";
import { boardWithPage } from "@/lib/board/paging";
import type { BoardColumnId, BoardEntry } from "@/lib/board/types";
import { requestMove } from "@/lib/board/move";
import { handleDrop } from "@/lib/board/drop-handler";
import { useUndo } from "@/components/toast";
import {
  boardReplaced,
  dragEnded,
  dragStarted,
  draggedOver,
  initialDragState,
  refusalDismissed,
  type DragState,
} from "@/lib/board/drag-state";
import { isFiltered, parseBoardQuery, withoutFilters, boardHref } from "@/lib/board/filters";
import {
  emptyFilterOptions,
  fetchFilterOptions,
  type FilterOptions,
} from "@/lib/board/filter-options";
import { fetchSavedViews } from "@/lib/board/saved-views-client";
import type { SavedViews } from "@/lib/board/saved-views";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { BoardView } from "./BoardView";
import { BoardFilterBar } from "./BoardFilterBar";
import { DragLayer } from "./DragLayer";

export function Board() {
  const { activeProfile } = useProfile();
  // Resolves to the host mounted in `AppShell`; outside a provider it is the
  // documented no-op, so a `Board` rendered in a fragment still drops.
  const { offer } = useUndo();
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const searchParams = useSearchParams();

  // **The URL is the filter state, not a mirror of it** (#75). There is no
  // `useState` holding the filters — `parseBoardQuery` reads them out of the
  // address on every render, so a pasted link and a select turned by hand
  // reach exactly the same board by exactly the same path. It is also what
  // makes the load effect below re-run when a filter changes: the query
  // string is in its dependency list, so there is no second mechanism that
  // could apply a filter to the address and not to the request.
  const queryString = searchParams.toString();
  const boardQuery = useMemo(() => parseBoardQuery(queryString), [queryString]);
  const filtered = isFiltered(boardQuery.filters);

  const [options, setOptions] = useState<FilterOptions>(() => emptyFilterOptions());
  const [savedViews, setSavedViews] = useState<SavedViews>([]);

  const [status, setStatus] = useState<"loading" | "error" | "loaded">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [drag, setDrag] = useState<DragState>(() => initialDragState(emptyBoard()));
  // Per column, not per board: the columns page independently, so one
  // column's request in flight must not disable another's control, and one
  // column's failure must not be reported on all four.
  const [loadingColumns, setLoadingColumns] = useState<Partial<Record<BoardColumnId, boolean>>>({});
  const [pageErrors, setPageErrors] = useState<Partial<Record<BoardColumnId, string>>>({});
  // Bumped to re-run the load effect — how the error state's retry works
  // without duplicating the fetch itself.
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * The clock, sampled once per load — the same reasoning `Projects.tsx`
   * gives: reading `Date.now()` during render would produce a different
   * tree on the server than on the client for the same data (a hydration
   * mismatch), and every card would disagree about "now" by however long
   * the render took. Feeds each card's presence "last active" caption.
   */
  const [now, setNow] = useState(0);

  // **The subtask disclosure state.** The board hides everything below level
  // 1 and each card states how much it holds; these four are what happens
  // when a reader opens one.
  //
  // Held here rather than in the card because `ItemCard` is hook-free by
  // design (see its header), and held as four collections keyed by id rather
  // than one object per card because that is the shape a column can hand
  // down without allocating a per-card object on every render.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  // The expansion set, readable synchronously by an event handler.
  //
  // Written together with `expandedIds` and never separately, so the two
  // cannot diverge — this is the same value in a form a handler can read
  // *before* the next render, not a second source of truth. `onToggleExpanded`
  // needs that: see its comment for the defect this removes.
  const expandedRef = useRef<ReadonlySet<string>>(expandedIds);
  const [subtasksByParent, setSubtasksByParent] = useState<
    ReadonlyMap<string, readonly BoardEntry[]>
  >(() => new Map());
  const [subtasksLoading, setSubtasksLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [subtaskErrors, setSubtaskErrors] = useState<ReadonlyMap<string, string>>(() => new Map());

  // **The ref is the authoritative copy; `drag` is what renders.**
  //
  // Both are written together, and only ever through `applyDrag` below, so
  // they cannot diverge. The ref exists because an event handler has to be
  // able to *read* the newest state synchronously — see `onDrop`'s comment
  // for the defect that costs. It is never read or written during render,
  // which is what `react-hooks/refs` is protecting and is a rule worth
  // keeping: a ref read during render would not re-render when it changed.
  const stateRef = useRef(drag);

  /** The single write path — advances the ref synchronously and schedules the render. */
  const applyDrag = useCallback((fn: (current: DragState) => DragState) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    setDrag(next);
  }, []);

  // **`status` is not reset here.** A retry sets it back to `loading` in the
  // handler that bumps `reloadNonce` (see `onRetry` below), rather than in
  // this effect body: a synchronous `setState` during an effect schedules a
  // second render pass for a value the event that triggered it already knew,
  // which is what `react-hooks/set-state-in-effect` is pointing at. Setting
  // it at the source also makes the transition atomic with the decision to
  // reload, so there is no render in between showing the stale error beside
  // a load that has already started.
  // **`boardQuery` is in the dependency list**, so changing a filter or the
  // sort re-reads the board. That is the whole of "the filter is applied" —
  // there is no separate apply step and nothing to keep in step, because the
  // address the reader can copy is the same value this effect reads.
  useEffect(() => {
    let cancelled = false;
    fetchBoard(fetch, boardQuery)
      .then((board) => {
        if (cancelled) return;
        applyDrag((current) => boardReplaced(current, board));
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
  }, [applyDrag, reloadNonce, boardQuery]);

  // The selects' vocabularies and the pinned views, fetched once on mount.
  // Neither depends on the filters, so re-reading them on every filter
  // change would be three requests per keystroke for lists that did not
  // move. Both resolve to empty rather than throwing — see their modules for
  // why a failure here must not take the board down with it.
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
   * Fetch one column's next page and append it.
   *
   * **The cursor is read synchronously from the ref, not from `drag`**, for
   * the same reason `onDrop` does: this is an event handler, and a cursor
   * read from a render-time copy would be the previous page's on a second
   * press before the first render had committed — which re-requests the page
   * already shown and makes the control appear to do nothing.
   */
  const onShowMore = useCallback(
    (column: BoardColumnId) => {
      const section = stateRef.current.board[column];
      // A withheld column has no cursor and has never been read, so its
      // "load" is a first page rather than a next one — `undefined` asks for
      // exactly that, and is why this is not guarded on `nextCursor`.
      const cursor = section.nextCursor ?? undefined;
      setLoadingColumns((current) => ({ ...current, [column]: true }));
      // Cleared on the attempt, not on its success: leaving the previous
      // failure on screen while a retry is in flight reports a stale failure
      // as a current one.
      setPageErrors((current) => ({ ...current, [column]: undefined }));
      // **The same filters and the same sort as the first page.** A "show
      // more" that dropped them would page an unfiltered, differently
      // ordered sequence into a filtered column — and because the cursor is
      // keyset on the sort key, a page requested under a different sort is
      // not merely unfiltered, it is drawn from a sequence the cursor does
      // not belong to.
      void fetchBoardColumn(column, {
        query: boardQuery,
        ...(cursor === undefined ? {} : { cursor }),
      })
        .then((page) => {
          applyDrag((current) =>
            boardReplaced(current, boardWithPage(current.board, column, page)),
          );
        })
        .catch((err: unknown) => {
          setPageErrors((current) => ({ ...current, [column]: boardErrorMessageFrom(err) }));
        })
        .finally(() => {
          setLoadingColumns((current) => ({ ...current, [column]: false }));
        });
    },
    [applyDrag, boardQuery],
  );

  /**
   * Opens or closes one card's subtasks, fetching them the first time.
   *
   * **Fetched once and kept.** A second open of the same card renders what
   * was already fetched rather than re-requesting it: the rollup badge is
   * the thing that has to be current on every board load, and the list
   * behind a disclosure the reader is toggling is not worth a request per
   * toggle. The cache lives for as long as this component is mounted: the
   * `boardQuery` effect loads a new board but does not reset the expansion
   * state, so a filter change leaves an open card's fetched list in place.
   * That is a stale-list window rather than a correctness problem — the
   * rollup badge above it is re-read on every load — but it is not the
   * "cleared on reload" this comment used to claim, and a reader relying on
   * that claim would look for a reset that is not there.
   *
   * **A failed fetch is retried on the next open**, which falls out of
   * caching only on success: nothing is written to `subtasksByParent` when
   * the request throws, so the `has` check below is false again next time.
   */
  const onToggleExpanded = useCallback(
    (itemId: string) => {
      // **Decided BEFORE `setExpandedIds`, from a ref — not inside the
      // updater.**
      //
      // This is the shape of #128, which has now shipped three times: a value
      // assigned inside a `setState` updater and read on the line after it.
      // An updater is not a callback that runs when you call it. React
      // evaluates one eagerly only when no update is already pending on the
      // fiber and defers it otherwise — and this component always has one
      // pending (the mount-time board load alone leaves a lane, and every
      // `onDragEnter` adds another). Under StrictMode it is additionally
      // invoked **twice**, so a second pass sees a `current` this handler has
      // already advanced and takes the opposite branch. Either way the outer
      // variable is still `false` on the next line, the early return fires,
      // and **no request is ever sent** — leaving the card on
      // "Loading subtasks…" with nothing in flight to end it.
      //
      // The ref is readable *now*, synchronously, so the decision to fetch is
      // made from a value the handler actually has rather than from one it
      // hopes an updater will have written by the time it looks. The updater
      // below becomes what an updater is required to be — a pure function of
      // its argument, safe to invoke any number of times.
      const opening = !expandedRef.current.has(itemId);
      const next = new Set(expandedRef.current);
      if (opening) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      // Both advance together, so a second toggle in the same tick sees the
      // first one's result instead of racing a re-render.
      expandedRef.current = next;
      setExpandedIds(next);

      // Closing costs nothing and fetches nothing; an already-fetched card
      // re-renders from what it has.
      if (!opening || subtasksByParent.has(itemId)) return;

      setSubtasksLoading((current) => new Set(current).add(itemId));
      // Cleared on the attempt rather than on its success, for the reason
      // `onShowMore` gives: a stale failure left on screen during a retry
      // reports itself as the current one.
      setSubtaskErrors((current) => {
        const next = new Map(current);
        next.delete(itemId);
        return next;
      });

      void fetchSubtasks(itemId, { query: boardQuery })
        .then((entries) => {
          setSubtasksByParent((current) => new Map(current).set(itemId, entries));
        })
        .catch((err: unknown) => {
          setSubtaskErrors((current) => new Map(current).set(itemId, boardErrorMessageFrom(err)));
        })
        .finally(() => {
          setSubtasksLoading((current) => {
            const next = new Set(current);
            next.delete(itemId);
            return next;
          });
        });
    },
    [boardQuery, subtasksByParent],
  );

  const onDrop = useCallback(
    (column: BoardColumnId) => {
      // The decision itself lives in `handleDrop` (`@/lib/board/drop-handler`)
      // so this seam is directly testable — it is where the one defect in
      // this row lived, and it was the only part of it no test covered.
      //
      // **The `void` is deliberate, and safe only because of an invariant.**
      // `handleDrop` folds every failure — a refusal, a non-2xx, a network
      // error — into a `MoveResult` it applies through `update`, so its
      // promise carries no error to handle and no unhandled rejection is
      // reachable. That holds only while `deps.move` cannot throw: if
      // `requestMove` ever gains a throwing path, this discard turns it into
      // a silent one and the card is left mid-move with nothing reverting it.
      // Attach a `.catch` here at that point.
      void handleDrop(
        {
          // **Read synchronously, never out of a `setState` updater.** A drop
          // has to do two things from one decision: apply the optimistic
          // move, and issue the request that decision produced. React
          // evaluates an updater eagerly only when no update is already
          // pending on the fiber, and on this component there always is one
          // (the mount-time board load alone leaves a lane, and every
          // `onDragEnter` adds another) — so reading the request out of an
          // updater yields nothing on essentially every drop, and the card
          // moves with no request ever sent. That is the exact "shows a move
          // that then quietly disappears" failure this row exists to
          // prevent, reached from the other side.
          read: () => stateRef.current,
          // Both go through the one write path, which advances the ref
          // synchronously as well as scheduling the render — so two drops in
          // the same tick each see the previous one's sequence number
          // instead of both minting the same one.
          write: (next) => applyDrag(() => next),
          update: applyDrag,
          move: requestMove,
          // **The undo offer — the reason a drag is reversible at all.**
          //
          // `offer` is the whole public surface of `@/lib/undo`, and until
          // this line nothing in the app called it: the toast was mounted at
          // the shell and every reference to `offer` outside its own module
          // was a comment, so no action could ever be undone. Handed to
          // `handleDrop` rather than called here because only that function
          // knows both ends of the move — the pre-drop entry and the state
          // the server confirmed.
          offerUndo: offer,
        },
        column,
      );
    },
    [applyDrag, offer],
  );

  const loadState: BoardLoadState =
    status === "error"
      ? { status: "error", message: errorMessage }
      : status === "loading"
        ? { status: "loading" }
        : { status: "loaded", board: drag.board };

  // The four callbacks the two transports share. Named here rather than
  // written inline twice so the pointer drag and the native drag cannot
  // drift into calling different things — they are literally the same
  // functions, folded into the same reducer in `@/lib/board/drag-state`.
  const onCardDragStart = useCallback(
    (itemId: string) => applyDrag((current) => dragStarted(current, itemId)),
    [applyDrag],
  );
  const onCardDragEnd = useCallback(() => applyDrag((current) => dragEnded(current)), [applyDrag]);
  const onDragEnter = useCallback(
    (column: BoardColumnId) => applyDrag((current) => draggedOver(current, column)),
    [applyDrag],
  );

  return (
    <>
      <BoardFilterBar
        query={boardQuery}
        options={options}
        views={savedViews}
        onViewsChange={setSavedViews}
      />
      {/* The pointer/keyboard transport wraps the board (T6-A, T6-B). It
          renders its children unchanged and adds the overlay that follows
          the cursor — the native HTML5 drag underneath is untouched. */}
      <DragLayer
        board={drag.board}
        onDragStart={onCardDragStart}
        onDragOver={onDragEnter}
        onDragCancel={onCardDragEnd}
        onDrop={onDrop}
        reducedMotion={reducedMotion}
      >
        <BoardView
          pointerDrag
          loadState={loadState}
          personId={activeProfile?.id ?? null}
          now={now}
          // The two props that make a filtered-to-nothing column say so. They
          // have existed on `BoardView` and `BoardColumn` since #123 built the
          // shared states, with nothing passing them — this is the caller they
          // were waiting for, and `emptinessOf` already decides when the
          // `filtered` kind applies. No new state component was written.
          filtered={filtered}
          onClearFilter={() =>
            router.replace(boardHref(withoutFilters(boardQuery)), { scroll: false })
          }
          onRetry={() => {
            // Both writes together: the board shows its loading state from this
            // press, and the nonce re-runs the load effect.
            setStatus("loading");
            setErrorMessage("");
            setReloadNonce((n) => n + 1);
          }}
          paging={{
            onShowMore,
            loadingColumns,
            errors: pageErrors,
          }}
          expansion={{
            expandedIds,
            onToggle: onToggleExpanded,
            childrenByParent: subtasksByParent,
            loadingIds: subtasksLoading,
            errorsByParent: subtaskErrors,
          }}
          drag={{
            onCardDragStart,
            onCardDragEnd,
            onDragEnter,
            onDrop,
            overColumn: drag.overColumn,
            pendingItemId: drag.pendingItemId,
            refusal: drag.refusal,
            onDismissRefusal: () => applyDrag((current) => refusalDismissed(current)),
          }}
        />
      </DragLayer>
    </>
  );
}
