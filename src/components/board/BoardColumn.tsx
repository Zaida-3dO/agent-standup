// One of the four columns — MILESTONES.md #37.
//
// Hook-free and prop-driven so it can be called directly in a test; see
// `TopBar.tsx`'s header.
import type { BoardColumnId, BoardEntry } from "@/lib/board/types";
import { columnTitle, needsYou, type WaitingSplit } from "@/lib/board/view";
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
}

export function BoardColumn({ column, entries, personId, split }: BoardColumnProps) {
  return (
    <section className={styles.column} aria-label={columnTitle(column)} data-column={column}>
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
            <ItemCard key={entry.item.id} entry={entry} needsYou={needsYou(entry, personId)} />
          ))}
        </ul>
      )}
    </section>
  );
}
