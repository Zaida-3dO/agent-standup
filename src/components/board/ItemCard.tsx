// One card on the board — MILESTONES.md #37.
//
// Hook-free and prop-driven, like every other component in this repo, so a
// test can call it as a function and inspect the element tree it returns
// (`tests/helpers/react-element.ts`); see `TopBar.tsx`'s header for the
// full reasoning.
import Link from "next/link";
import type { BoardEntry } from "@/lib/board/types";
import { waitingTone } from "@/lib/board/view";
import styles from "./Board.module.css";

export interface ItemCardProps {
  readonly entry: BoardEntry;
  /** True when this card is on the active profile's needs-you list — see `needsYou`. */
  readonly needsYou: boolean;
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

export function ItemCard({ entry, needsYou }: ItemCardProps) {
  const tone = waitingTone(entry);
  const reason = waitingReason(entry);
  const toneClass = tone === "amber" ? styles.toneAmber : tone === "red" ? styles.toneRed : "";

  return (
    <li className={`${styles.card} ${toneClass}`.trim()} data-tone={tone ?? undefined}>
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
      {reason && <span className={styles.cardReason}>{reason}</span>}
      <div className={styles.cardMeta}>
        <span className={styles.state}>{entry.item.state.replace(/_/g, " ")}</span>
        {entry.item.repo && <span className={styles.repo}>{entry.item.repo}</span>}
      </div>
    </li>
  );
}
