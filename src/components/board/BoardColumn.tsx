// One of the four columns — MILESTONES.md #37.
//
// Hook-free and prop-driven so it can be called directly in a test; see
// `TopBar.tsx`'s header.
import type { BoardColumnId, BoardEntry } from "@/lib/board/types";
import { columnTitle, needsYou, type WaitingSplit } from "@/lib/board/view";
import { acceptsDrop } from "@/lib/board/drag";
import { ItemCard } from "./ItemCard";
import styles from "./Board.module.css";

export interface BoardColumnProps {
  readonly column: BoardColumnId;
  readonly entries: readonly BoardEntry[];
  /** The active profile's id, or `null` when none is chosen — decides which cards are flagged. */
  readonly personId: string | null;
  /**
   * The amber/red tally, passed only for the Waiting column. Rendering it
   * under the heading is what keeps the shared column readable at a glance
   * — SCHEMA.md §1.1's "sharing a column loses that".
   */
  readonly split?: WaitingSplit;
  /** Called when a card is dropped on this column (#73). Absent on a board with no drag wired up. */
  readonly onDrop?: (column: BoardColumnId) => void;
  /** Called when a dragged card enters or leaves this column, so it can show itself as the target. */
  readonly onDragEnter?: (column: BoardColumnId) => void;
  /** True while a dragged card is over this column. */
  readonly isDropTarget?: boolean;
  /** Passed to each card — see `ItemCardProps`. */
  readonly onCardDragStart?: (itemId: string) => void;
  readonly onCardDragEnd?: () => void;
  /** The item whose move is in flight, if it is in this column. */
  readonly pendingItemId?: string | null;
}

export function BoardColumn({
  column,
  entries,
  personId,
  split,
  onDrop,
  onDragEnter,
  isDropTarget,
  onCardDragStart,
  onCardDragEnd,
  pendingItemId,
}: BoardColumnProps) {
  // Waiting accepts no drops at all — both its states need fields a drag
  // cannot supply, so every drop would be refused (see `TARGET_STATE`). A
  // column that always refuses teaches that the interface is unreliable, so
  // it simply is not a target.
  const droppable = onDrop !== undefined && acceptsDrop(column);
  // Never highlight a column that cannot be dropped on — the highlight is a
  // promise that letting go here will do something.
  const highlighted = droppable && isDropTarget === true;

  return (
    <section
      className={`${styles.column} ${highlighted ? styles.columnDropTarget : ""}`.trim()}
      aria-label={columnTitle(column)}
      data-column={column}
      data-drop-target={highlighted ? true : undefined}
      // `preventDefault` on dragOver is what makes an element a drop target
      // at all — the HTML drag-and-drop default is to refuse the drop, so
      // without it `onDrop` never fires and a card silently springs back
      // with no request ever having been made.
      onDragOver={
        droppable
          ? (event) => {
              event.preventDefault();
            }
          : undefined
      }
      onDragEnter={droppable && onDragEnter ? () => onDragEnter(column) : undefined}
      onDrop={
        droppable
          ? (event) => {
              event.preventDefault();
              onDrop(column);
            }
          : undefined
      }
    >
      <header className={styles.columnHead}>
        <h2 className={styles.columnTitle}>{columnTitle(column)}</h2>
        <span className={styles.count}>{entries.length}</span>
      </header>
      {split && (
        <p className={styles.split}>
          <span className={styles.splitAmber}>{split.amber} paused</span>
          <span className={styles.splitRed}>{split.red} blocked</span>
          {/* `waitingSplit` counts a third bucket — a project in Waiting,
              or a state that should not be in this column — and rendering
              only the first two let a card exist in the header count while
              appearing in neither tallied number, which is the exact
              "silently goes missing from the count" failure `waitingSplit`
              says it exists to prevent. Shown only when non-zero: a
              permanent "0 other" would be noise on the common board. */}
          {split.other > 0 && <span className={styles.splitOther}>{split.other} other</span>}
        </p>
      )}
      {entries.length === 0 ? (
        <p className={styles.empty}>Nothing here.</p>
      ) : (
        <ul className={styles.cards}>
          {entries.map((entry) => (
            <ItemCard
              key={entry.item.id}
              entry={entry}
              needsYou={needsYou(entry, personId)}
              onDragStart={onCardDragStart}
              onDragEnd={onCardDragEnd}
              pending={pendingItemId === entry.item.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
