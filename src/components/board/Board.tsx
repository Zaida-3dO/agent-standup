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
import { useCallback, useEffect, useState } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { fetchBoard, boardErrorMessageFrom, type BoardLoadState } from "@/lib/board/state";
import { emptyBoard } from "@/lib/board/view";
import type { BoardColumnId } from "@/lib/board/types";
import { requestMove } from "@/lib/board/move";
import {
  boardReplaced,
  dragEnded,
  dragStarted,
  draggedOver,
  dropped,
  initialDragState,
  moveRefused,
  moveSettled,
  refusalDismissed,
  type DragState,
} from "@/lib/board/drag-state";
import { BoardView } from "./BoardView";

export function Board() {
  const { activeProfile } = useProfile();
  const [status, setStatus] = useState<"loading" | "error" | "loaded">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [drag, setDrag] = useState<DragState>(() => initialDragState(emptyBoard()));

  useEffect(() => {
    let cancelled = false;
    fetchBoard()
      .then((board) => {
        if (cancelled) return;
        setDrag((current) => boardReplaced(current, board));
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
  }, []);

  const onDrop = useCallback((column: BoardColumnId) => {
    // The optimistic move is applied here, synchronously, before any
    // request goes out — that is what "the move showing immediately"
    // means. `dropped` also hands back the request to make, or `null` when
    // the drop was not a move at all.
    let request: ReturnType<typeof dropped>["request"] = null;
    setDrag((current) => {
      const outcome = dropped(current, column);
      request = outcome.request;
      return outcome.state;
    });
    if (request === null) return;

    const { itemId, column: target, sequence } = request;
    void requestMove(itemId, target).then((result) => {
      setDrag((current) =>
        result.ok
          ? moveSettled(current, sequence, result.entry)
          : moveRefused(current, sequence, result.message),
      );
    });
  }, []);

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
        onCardDragStart: (itemId) => setDrag((current) => dragStarted(current, itemId)),
        onCardDragEnd: () => setDrag((current) => dragEnded(current)),
        onDragEnter: (column) => setDrag((current) => draggedOver(current, column)),
        onDrop,
        overColumn: drag.overColumn,
        pendingItemId: drag.pendingItemId,
        refusal: drag.refusal,
        onDismissRefusal: () => setDrag((current) => refusalDismissed(current)),
      }}
    />
  );
}
