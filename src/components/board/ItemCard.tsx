// One card on the board — MILESTONES.md #37.
//
// Hook-free and prop-driven, like every other component in this repo, so a
// test can call it as a function and inspect the element tree it returns
// (`tests/helpers/react-element.ts`); see `TopBar.tsx`'s header for the
// full reasoning.
import type { BoardEntry } from "@/lib/board/types";
import { waitingTone } from "@/lib/board/view";
import { isDraggable } from "@/lib/board/drag";
import styles from "./Board.module.css";

export interface ItemCardProps {
  readonly entry: BoardEntry;
  /** True when this card is on the active profile's needs-you list — see `needsYou`. */
  readonly needsYou: boolean;
  /**
   * Called when a drag of this card starts (#73). Absent on a board with no
   * drag wired up, which is why the handlers below are only attached when it
   * is given — a card that is `draggable` but tells nobody it moved would
   * drag to nowhere.
   */
  readonly onDragStart?: (itemId: string) => void;
  /** Called when the drag ends, whether or not it landed on a column. */
  readonly onDragEnd?: () => void;
  /** True while this card's move is in flight — see `Board.module.css`'s `.cardPending`. */
  readonly pending?: boolean;
}

/**
 * The one-line reason a Waiting card gives for being there. Paused and
 * blocked carry different fields (SCHEMA.md §1.1), and a card with neither
 * set shows nothing rather than an empty line.
 */
function waitingReason(entry: BoardEntry): string | null {
  if (entry.item.state === "paused") return entry.item.pauseReason;
  if (entry.item.state === "blocked") return entry.item.blockedReason;
  return null;
}

export function ItemCard({ entry, needsYou, onDragStart, onDragEnd, pending }: ItemCardProps) {
  const tone = waitingTone(entry);
  const reason = waitingReason(entry);
  const toneClass = tone === "amber" ? styles.toneAmber : tone === "red" ? styles.toneRed : "";
  // A project is never draggable: its column derives from its children and
  // it has no state of its own to transition (DECISIONS.md §13c). Offering
  // the gesture and refusing every time would teach the wrong model.
  const draggable = onDragStart !== undefined && isDraggable(entry);

  return (
    <li
      className={`${styles.card} ${toneClass} ${pending ? styles.cardPending : ""}`
        .replace(/\s+/g, " ")
        .trim()}
      data-tone={tone ?? undefined}
      data-draggable={draggable}
      data-pending={pending ? true : undefined}
      draggable={draggable}
      onDragStart={draggable ? () => onDragStart(entry.item.id) : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <div className={styles.cardHead}>
        <span className={styles.priority} data-priority={entry.item.priority}>
          {entry.item.priority}
        </span>
        {needsYou && (
          <span className={styles.needsYouFlag} title="Blocked on you">
            Needs you
          </span>
        )}
      </div>
      <span className={styles.cardTitle}>{entry.item.title}</span>
      {reason && <span className={styles.cardReason}>{reason}</span>}
      <div className={styles.cardMeta}>
        <span className={styles.state}>{entry.item.state.replace(/_/g, " ")}</span>
        {entry.item.repo && <span className={styles.repo}>{entry.item.repo}</span>}
      </div>
    </li>
  );
}
