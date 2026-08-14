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
import { BOARD_COLUMNS, needsYouCount, waitingSplit } from "@/lib/board/view";
import { BoardColumn } from "./BoardColumn";
import { NeedsYouBadge } from "./NeedsYouBadge";
import styles from "./Board.module.css";

export interface BoardViewProps {
  readonly loadState: BoardLoadState;
  /** The active profile's id, or `null` — decides who the needs-you badge counts for. */
  readonly personId: string | null;
}

export function BoardView({ loadState, personId }: BoardViewProps) {
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
      <div className={styles.columns}>
        {BOARD_COLUMNS.map((column) => (
          <BoardColumn
            key={column}
            column={column}
            entries={board[column]}
            personId={personId}
            // Only Waiting gets the amber/red tally — it is the only column
            // that merges two states (SCHEMA.md §1.1).
            split={column === "waiting" ? split : undefined}
          />
        ))}
      </div>
    </div>
  );
}
