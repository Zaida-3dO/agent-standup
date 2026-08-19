// One card on the board — MILESTONES.md #37.
//
// Hook-free and prop-driven, like every other component in this repo, so a
// test can call it as a function and inspect the element tree it returns
// (`tests/helpers/react-element.ts`); see `TopBar.tsx`'s header for the
// full reasoning.
import Link from "next/link";
import type { BoardEntry } from "@/lib/board/types";
import { waitingTone } from "@/lib/board/view";
import { isDraggable } from "@/lib/board/drag";
import { relativeTime } from "@/lib/projects/view";
import { AgentPresenceDot } from "@/components/chips/AgentPresenceDot";
import styles from "./Board.module.css";

export interface ItemCardProps {
  readonly entry: BoardEntry;
  /** True when this card is on the active profile's needs-you list — see `needsYou`. */
  readonly needsYou: boolean;
  /**
   * The clock — `Board.tsx` samples it once per load. Used only to render
   * each assignment's "last active" caption, so a card with nobody on it
   * never reads this at all.
   */
  readonly now: number;
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

export function ItemCard({ entry, needsYou, now, onDragStart, onDragEnd, pending }: ItemCardProps) {
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
      onDragStart={
        draggable
          ? (event) => {
              // **Claim the drag payload explicitly.** A card's title is a
              // link into the item's detail view, and an anchor is natively
              // draggable — so a drag begun on the title would otherwise be
              // the browser's own link-drag, carrying the URL, and dropping
              // it on a column would do nothing at all. Setting the data
              // and the effect here overrides that default, so a drag
              // started anywhere on the card is the same card drag.
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", entry.item.id);
              onDragStart(entry.item.id);
            }
          : undefined
      }
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
      {/* The title is the way into the detail view (#72). A real <Link>
          rather than a click handler on the card: it is a navigation, so it
          should be middle-clickable, openable in a new tab, and reachable
          by keyboard — all of which a div with an onClick silently is not. */}
      <Link className={styles.cardTitle} href={`/items/${entry.item.id}`}>
        {entry.item.title}
      </Link>
      {/* The BLUF (#107) — what this work is, without opening it. Absent on
          an item nobody has written one for, in which case the card shows
          nothing rather than an empty line, exactly like `reason` below.
          Deliberately outside the link: it describes the work rather than
          naming it, so folding it into the navigation target would make the
          link text a paragraph for anyone reading the page by keyboard or
          with a screen reader. */}
      {entry.item.headline && <span className={styles.cardHeadline}>{entry.item.headline}</span>}
      {reason && <span className={styles.cardReason}>{reason}</span>}
      {/* Presence — who holds this right now, and how long since they last
          reported. One row per live assignment (SCHEMA.md §2 allows more
          than one holder at once — an orchestrator plus a builder, say),
          rendered only when the card has any; an unheld card shows nothing
          here rather than an empty row. */}
      {entry.assignments.length > 0 && (
        <ul className={styles.cardPresence}>
          {entry.assignments.map((assignment) => (
            <li key={`${assignment.holderId}-${assignment.role}`} className={styles.presenceRow}>
              <AgentPresenceDot liveness={assignment.liveness} agentName={assignment.displayName} />
              <span className={styles.presenceName}>{assignment.displayName}</span>
              <span className={styles.presenceAge}>{relativeTime(assignment.lastActive, now)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.cardMeta}>
        <span className={styles.state}>{entry.item.state.replace(/_/g, " ")}</span>
        {entry.item.repo && <span className={styles.repo}>{entry.item.repo}</span>}
      </div>
    </li>
  );
}
