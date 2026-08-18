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
import { useCallback, useEffect, useRef, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import {
  fetchBoard,
  fetchBoardColumn,
  boardErrorMessageFrom,
  type BoardLoadState,
} from "@/lib/board/state";
import { emptyBoard } from "@/lib/board/view";
import { boardWithPage } from "@/lib/board/paging";
import type { BoardColumnId } from "@/lib/board/types";
import { requestMove } from "@/lib/board/move";
import { handleDrop } from "@/lib/board/drop-handler";
import {
  boardReplaced,
  dragEnded,
  dragStarted,
  draggedOver,
  initialDragState,
  refusalDismissed,
  type DragState,
} from "@/lib/board/drag-state";
import { BoardView } from "./BoardView";

export function Board() {
  const { activeProfile } = useProfile();
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
  useEffect(() => {
    let cancelled = false;
    fetchBoard()
      .then((board) => {
        if (cancelled) return;
        applyDrag((current) => boardReplaced(current, board));
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
  }, [applyDrag, reloadNonce]);

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
      void fetchBoardColumn(column, cursor === undefined ? {} : { cursor })
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
    [applyDrag],
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
        },
        column,
      );
    },
    [applyDrag],
  );

  const loadState: BoardLoadState =
    status === "error"
      ? { status: "error", message: errorMessage }
      : status === "loading"
        ? { status: "loading" }
        : { status: "loaded", board: drag.board };

  return (
    <BoardView
      loadState={loadState}
      personId={activeProfile?.id ?? null}
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
      drag={{
        onCardDragStart: (itemId) => applyDrag((current) => dragStarted(current, itemId)),
        onCardDragEnd: () => applyDrag((current) => dragEnded(current)),
        onDragEnter: (column) => applyDrag((current) => draggedOver(current, column)),
        onDrop,
        overColumn: drag.overColumn,
        pendingItemId: drag.pendingItemId,
        refusal: drag.refusal,
        onDismissRefusal: () => applyDrag((current) => refusalDismissed(current)),
      }}
    />
  );
}
