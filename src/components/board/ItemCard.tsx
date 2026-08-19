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
import { hasDistinctHeadline, primaryLine } from "@/lib/item-headline-display";
import { TrustBadge } from "@/components/chips/TrustBadge";
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
  // MILESTONES.md #131: an imported title is a work order written for an
  // agent, so the card leads with `headline` (a person-facing BLUF) where
  // one exists and falls back to `title` where it does not. `title` itself
  // is never rewritten — see `item-headline-display.ts`'s header — so when
  // a headline stands in, `title` still renders, just smaller, underneath.
  const distinctHeadline = hasDistinctHeadline(entry.item);
  const unverified = entry.trust?.unverifiedOrigin === true;

  return (
    <li
      className={`${styles.card} ${toneClass} ${pending ? styles.cardPending : ""} ${unverified ? styles.cardUnverified : ""}`
        .replace(/\s+/g, " ")
        .trim()}
      data-tone={tone ?? undefined}
      data-draggable={draggable}
      data-pending={pending ? true : undefined}
      data-unverified={unverified ? true : undefined}
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
        {/* The trust marker (#131) — a verified state and an unverifiable
            one must not render identically, the same rule #123 applies to
            an empty vs. withheld column. `entry.trust` is `null` for a
            project (DECISIONS.md §13c: no `state` of its own to distrust),
            so the badge is skipped outright rather than shown as "verified"
            by a default it never earned. */}
        {entry.trust && (
          <TrustBadge
            verified={entry.trust.verification !== null}
            checkedAt={entry.trust.verification?.checkedAt}
            checkedByType={entry.trust.verification?.checkedByType}
          />
        )}
      </div>
      {/* The title is the way into the detail view (#72). A real <Link>
          rather than a click handler on the card: it is a navigation, so it
          should be middle-clickable, openable in a new tab, and reachable
          by keyboard — all of which a div with an onClick silently is not. */}
      <Link className={styles.cardTitle} href={`/items/${entry.item.id}`}>
        {primaryLine(entry.item)}
      </Link>
      {/* `title` as a secondary line — ONLY when a headline is standing in
          for it above. Rendering it unconditionally would print every plain
          item's title twice; rendering it only here is what keeps the
          source title reachable (correlating a row with the PR or issue
          that produced it) without duplicating it where nothing was
          replaced. */}
      {distinctHeadline && <span className={styles.cardSourceTitle}>{entry.item.title}</span>}
      {reason && <span className={styles.cardReason}>{reason}</span>}
      <div className={styles.cardMeta}>
        <span className={styles.state}>{entry.item.state.replace(/_/g, " ")}</span>
        {entry.item.repo && <span className={styles.repo}>{entry.item.repo}</span>}
      </div>
    </li>
  );
}
