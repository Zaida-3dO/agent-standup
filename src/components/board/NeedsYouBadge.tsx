// The needs-you badge — MILESTONES.md #37, and the direct answer to
// SCHEMA.md §1.1's warning that merging `paused` and `blocked` into one
// column costs the "what needs me" list its readability: "the needs-you
// count wants a badge or filter of its own — otherwise the distinction
// survives in the data and disappears where you'd actually use it."
//
// Hook-free and prop-driven; see `TopBar.tsx`'s header.
import styles from "./Board.module.css";

export interface NeedsYouBadgeProps {
  readonly count: number;
}

/**
 * Renders nothing at zero. A badge reading "0 need you" is worse than no
 * badge: it occupies the spot the eye checks for a number and answers a
 * question nobody asked, which trains you to stop looking there.
 */
export function NeedsYouBadge({ count }: NeedsYouBadgeProps) {
  if (count <= 0) return null;
  return (
    <p className={styles.needsYou} role="status">
      <span className={styles.needsYouCount}>{count}</span>
      {count === 1 ? " item needs you" : " items need you"}
    </p>
  );
}
