// The presentational half of MILESTONES.md #37: the load/error/loaded
// branching and the four columns themselves.
//
// Deliberately prop-driven and hook-free rather than a `useBoard()` caller
// — same reasoning as `AppShellView.tsx`: with `environment: "node"` and no
// DOM, a component that takes plain props can be called directly as a
// function and its returned tree inspected, which is what actually proves
// these branches. `Board.tsx` is the thin client container that fetches and
// hands this component its props.
//
// The load, error and empty states come from `@/components/states` rather
// than being written here, so the board reports a failure in the same words
// and the same shape as every other region — see that directory's header.
import type { BoardLoadState } from "@/lib/board/state";
import type { BoardColumnId } from "@/lib/board/types";
import { BOARD_COLUMNS, needsYouCount, waitingSplit } from "@/lib/board/view";
import { ErrorState } from "@/components/states/ErrorState";
import { BoardColumn } from "./BoardColumn";
import { DroppableColumn } from "./DroppableColumn";
import { NeedsYouBadge } from "./NeedsYouBadge";
import styles from "./Board.module.css";

export interface BoardViewProps {
  readonly loadState: BoardLoadState;
  /** The active profile's id, or `null` — decides who the needs-you badge counts for. */
  readonly personId: string | null;
  /**
   * The clock, sampled once by `Board.tsx` on load — see that component's
   * header. Threaded down to every card so its presence "last active"
   * caption can be computed without each card reading `Date.now()` itself.
   */
  readonly now: number;
  /** The drag wiring (#73). Absent on a board rendered without it — every handler is optional. */
  readonly drag?: BoardDragProps;
  /** The per-column paging wiring. Absent leaves every column unpaged. */
  readonly paging?: BoardPagingProps;
  /** Retries the initial board load, offered by the error state. */
  readonly onRetry?: () => void;
  /** True when a filter is narrowing the board — lets an empty column say the filter did it. */
  readonly filtered?: boolean;
  /** Clears that filter. */
  readonly onClearFilter?: () => void;
  /**
   * True when the pointer-drag layer is mounted around this board (T6-A),
   * which is what decides whether the columns are the plain hook-free
   * component or the `dnd-kit`-registered wrapper.
   *
   * **A flag rather than the components themselves**, so `BoardView` stays
   * callable as a plain function in a test with no library and no DOM: left
   * absent, this renders exactly the tree it has always rendered.
   */
  readonly pointerDrag?: boolean;
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

/**
 * The paging wiring, grouped for the same reason as the drag props.
 *
 * Keyed by column rather than a single flag, because the columns page
 * independently: pressing "show more" on Backlog must not put Completed into
 * a loading state, and a page request that fails on one column says nothing
 * about the other three.
 */
export interface BoardPagingProps {
  /** Fetches one column's next page. */
  readonly onShowMore: (column: BoardColumnId) => void;
  /** Which columns have a page in flight. */
  readonly loadingColumns: Readonly<Partial<Record<BoardColumnId, boolean>>>;
  /** Why each column's last page request failed, where one did. */
  readonly errors: Readonly<Partial<Record<BoardColumnId, string>>>;
}

export function BoardView({
  loadState,
  personId,
  now,
  drag,
  paging,
  onRetry,
  filtered,
  onClearFilter,
  pointerDrag,
}: BoardViewProps) {
  if (loadState.status === "error") {
    return (
      <div className={styles.centered}>
        {/* The message already names the failing call — `fetchBoardColumn`
            throws "Could not load the board (GET /api/board returned 500)."
            — so it is passed whole rather than split, and the retry is
            offered rather than leaving a dead end. */}
        <ErrorState message={loadState.message} onRetry={onRetry} centered />
      </div>
    );
  }

  if (loadState.status === "loading") {
    // Skeleton columns, not a sentence: the board's shape is known before
    // its contents are, so the frame can be drawn immediately and the page
    // does not jump when the data lands.
    return (
      <div className={styles.board}>
        <div className={styles.columns}>
          {BOARD_COLUMNS.map((column) => (
            <BoardColumn
              key={column}
              column={column}
              section={{ entries: [], total: 0, nextCursor: null, withheld: false }}
              personId={personId}
              now={now}
              loading
            />
          ))}
        </div>
      </div>
    );
  }

  const board = loadState.board;
  const split = waitingSplit(board);
  // The plain column, or the one registered with the drag library. Chosen
  // once here rather than branched at each of the four call sites — and it
  // is the SAME component underneath either way, since `DroppableColumn`
  // renders `BoardColumn` with two extra props. A test that walks this tree
  // looking for `BoardColumn` still finds four of them when `pointerDrag`
  // is absent, which is every existing test.
  const Column = drag !== undefined && pointerDrag === true ? DroppableColumn : BoardColumn;

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
          <Column
            key={column}
            column={column}
            section={board[column]}
            personId={personId}
            now={now}
            // Only Waiting gets the amber/red tally — it is the only column
            // that merges two states (SCHEMA.md §1.1).
            split={column === "waiting" ? split : undefined}
            onDrop={drag?.onDrop}
            onDragEnter={drag?.onDragEnter}
            isDropTarget={drag?.overColumn === column}
            onCardDragStart={drag?.onCardDragStart}
            onCardDragEnd={drag?.onCardDragEnd}
            pendingItemId={drag?.pendingItemId ?? null}
            onShowMore={paging?.onShowMore}
            loadingMore={paging?.loadingColumns[column] === true}
            pageError={paging?.errors[column] ?? null}
            filtered={filtered}
            onClearFilter={onClearFilter}
          />
        ))}
      </div>
    </div>
  );
}
