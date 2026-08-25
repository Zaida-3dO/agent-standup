// What follows the cursor during a drag — T6-A.
//
// The whole deliverable of this row is "the card visibly moves with the
// pointer", and this is the element that does it. It renders inside
// `DragOverlay`, which is portalled out of the board's own scroll
// containers — the reason a plain absolutely-positioned clone would not
// work is that every column is a bounded `overflow` trough (`BoardColumn`),
// so a card dragged out of one would be clipped at its edge.
//
// Hook-free and prop-driven like every other component here, so a test can
// call it as a function and inspect what it returns; the hooks that supply
// its props live in `DragLayer`.
import type { BoardEntry } from "@/lib/board/types";
import { primaryLine } from "@/lib/item-headline-display";
import styles from "./Board.module.css";

export interface DragCardPreviewProps {
  /** The card being dragged, or `null` when nothing is. */
  readonly entry: BoardEntry | null;
  /** True when the reader asked for reduced motion — drops the tilt and the lift. */
  readonly reducedMotion?: boolean;
}

/**
 * A deliberately reduced rendering of the card — its priority and its
 * primary line, not the whole card.
 *
 * A full clone (presence rows, trust badge, meta) would be a heavier thing
 * to drag around and would obscure more of the board underneath it at the
 * exact moment the reader is trying to judge where it lands. What has to
 * survive is enough to be sure *which* card is in hand, which is the title
 * and the priority.
 */
export function DragCardPreview({ entry, reducedMotion }: DragCardPreviewProps) {
  if (entry === null) return null;
  return (
    <div
      className={`${styles.dragPreview} ${reducedMotion ? styles.dragPreviewPlain : ""}`.trim()}
      data-drag-preview
      data-reduced-motion={reducedMotion === true ? true : undefined}
      // Presentation only: the authoritative announcement of a keyboard
      // move is `DragLayer`'s live region, and a screen reader reading this
      // clone as well would say the same card's name twice per move.
      aria-hidden="true"
    >
      <span className={styles.priority} data-priority={entry.item.priority}>
        {entry.item.priority}
      </span>
      <span className={styles.dragPreviewTitle}>{primaryLine(entry.item)}</span>
    </div>
  );
}
