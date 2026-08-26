// The needs-you badge — MILESTONES.md #37, and the direct answer to
// SCHEMA.md §1.1's warning that merging `paused` and `blocked` into one
// column costs the "what needs me" list its readability: "the needs-you
// count wants a badge or filter of its own — otherwise the distinction
// survives in the data and disappears where you'd actually use it."
//
// **This banner and the sidebar/`/needs-you` badge count different things,
// on purpose, and say so.** This one is `needsYouCount()` from
// `@/lib/board/view` — strictly `state === "blocked"` on this person, computed
// client-side from the board already in memory, with no extra request. The
// sidebar's badge reads `get_needs_you`'s server-side `total`, a three-reason
// union (blocked-on-you, merges awaiting your approval, plans awaiting your
// review — see that operation's header). They used to share the words
// "needs you" while answering different questions, which is exactly the
// finding a visual review caught: the same two words showing 1 here and 25
// there with nothing to explain the gap. Fixing it by fetching the sidebar's
// total here too was rejected — this component is deliberately prop-driven
// off data the board already has, and duplicating that network round trip
// into every board load to save a label change was the wrong trade. So this
// banner keeps its narrower, cheaper count and says "blocked on you", the
// literal thing it counts; the sidebar keeps its existing "Needs you" label
// (`routes.ts`) for the broader union — "waiting on you" is a different
// component's wording (`NeedsYouInboxView.tsx`'s longer explanatory line),
// not the sidebar's. Neither number moved.
//
// Hook-free and prop-driven; see `TopBar.tsx`'s header.
import styles from "./Board.module.css";

export interface NeedsYouBadgeProps {
  readonly count: number;
}

/**
 * Renders nothing at zero. A badge reading "0 blocked on you" is worse than
 * no badge: it occupies the spot the eye checks for a number and answers a
 * question nobody asked, which trains you to stop looking there.
 */
export function NeedsYouBadge({ count }: NeedsYouBadgeProps) {
  if (count <= 0) return null;
  return (
    <p className={styles.needsYou} role="status">
      <span className={styles.needsYouCount}>{count}</span>
      {count === 1 ? " item blocked on you" : " items blocked on you"}
    </p>
  );
}
