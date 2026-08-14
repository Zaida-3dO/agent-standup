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
import { useCallback, useEffect, useRef, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { fetchBoard, boardErrorMessageFrom, type BoardLoadState } from "@/lib/board/state";
import { emptyBoard } from "@/lib/board/view";
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
  }, [applyDrag]);

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
