// The presentational half of MILESTONES.md #37: the load/error/loaded
// branching and the four columns themselves.
//
// Deliberately prop-driven and hook-free rather than a `useBoard()` caller
// — same reasoning as `AppShellView.tsx`: with `environment: "node"` and no
// DOM, a component that takes plain props can be called directly as a
// function and its returned tree inspected, which is what actually proves
// these branches. `Board.tsx` is the thin client container that fetches and
// hands this component its props.
import type { BoardLoadState } from "@/lib/board/state";
import type { BoardColumnId } from "@/lib/board/types";
import { BOARD_COLUMNS, needsYouCount, waitingSplit } from "@/lib/board/view";
import { BoardColumn } from "./BoardColumn";
import { NeedsYouBadge } from "./NeedsYouBadge";
import styles from "./Board.module.css";

export interface BoardViewProps {
  readonly loadState: BoardLoadState;
  /** The active profile's id, or `null` — decides who the needs-you badge counts for. */
  readonly personId: string | null;
  /** The drag wiring (#73). Absent on a board rendered without it — every handler is optional. */
  readonly drag?: BoardDragProps;
}

/** Everything the drag interaction needs, grouped so `BoardView` threads one prop rather than seven. */
export interface BoardDragProps {
  readonly onCardDragStart: (itemId: string) => void;
  readonly onCardDragEnd: () => void;
  readonly onDrop: (column: BoardColumnId) => void;
  readonly onDragEnter: (column: BoardColumnId) => void;
  /** The column a dragged card is being held over, or `null`. */
  readonly overColumn: BoardColumnId | null;
  /** The item whose move is in flight, or `null`. */
  readonly pendingItemId: string | null;
  /**
   * Why the last move was refused, or `null`. Shown as a live region so the
   * revert is explained rather than looking like the interface broke — the
   * failure mode this row exists to avoid.
   */
  readonly refusal: string | null;
  readonly onDismissRefusal: () => void;
}

export function BoardView({ loadState, personId, drag }: BoardViewProps) {
  if (loadState.status === "error") {
    return (
      <div className={styles.centered}>
        <p>{loadState.message}</p>
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className={styles.centered}>
        <p>Loading the board…</p>
      </div>
    );
  }

  const board = loadState.board;
  const split = waitingSplit(board);

  return (
    <div className={styles.board}>
      <NeedsYouBadge count={needsYouCount(board, personId)} />
      {/* A refused move has already sprung the card back by the time this
          renders. Saying why is what separates "the server refused, here is
          its reason" from "the interface is broken" — `role="alert"` so it
          is announced, since the visual revert is not perceivable to
          everyone. */}
      {drag?.refusal != null && (
        <p className={styles.refusal} role="alert" data-refusal={drag.refusal}>
          <span className={styles.refusalText}>{drag.refusal}</span>
          <button type="button" className={styles.refusalDismiss} onClick={drag.onDismissRefusal}>
            Dismiss
          </button>
        </p>
      )}
      <div className={styles.columns}>
        {BOARD_COLUMNS.map((column) => (
          <BoardColumn
            key={column}
            column={column}
            section={board[column]}
            personId={personId}
            // Only Waiting gets the amber/red tally — it is the only column
            // that merges two states (SCHEMA.md §1.1).
            split={column === "waiting" ? split : undefined}
            onDrop={drag?.onDrop}
            onDragEnter={drag?.onDragEnter}
            isDropTarget={drag?.overColumn === column}
            onCardDragStart={drag?.onCardDragStart}
            onCardDragEnd={drag?.onCardDragEnd}
            pendingItemId={drag?.pendingItemId ?? null}
          />
        ))}
      </div>
    </div>
  );
}
