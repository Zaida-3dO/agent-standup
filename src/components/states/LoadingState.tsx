// The first-load state: skeletons in the shape of the content, not a spinner.
//
// A spinner reports that something is happening somewhere and says nothing
// about what or how much. A skeleton occupies the space the content will
// occupy, so the layout does not jump when the data lands and the reader can
// already see how much is coming. It is also the honest answer to "is this
// region empty or still loading", which is the same family of confusion the
// empty states next door exist to prevent — a region that renders nothing
// while loading is indistinguishable from one that came back empty.
//
// Hook-free and prop-driven; see `EmptyState.tsx`'s header.
import styles from "./States.module.css";

export interface LoadingStateProps {
  /**
   * How many placeholder rows to draw.
   *
   * Defaults to three: enough that the region reads as a list rather than as
   * one stray box, few enough that it does not promise a screenful the read
   * may not deliver.
   */
  readonly rows?: number;
  /** What is being loaded, for the screen-reader label — "board column", "profiles". */
  readonly label?: string;
}

export function LoadingState({ rows = 3, label = "content" }: LoadingStateProps) {
  return (
    <ul
      className={styles.skeleton}
      data-state="loading"
      // `busy` rather than a live region: the skeleton itself is not worth
      // announcing, but the fact that this area is mid-update is, and it
      // stops a screen reader reading the placeholder boxes as content.
      aria-busy="true"
      aria-label={`Loading ${label}`}
    >
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className={styles.skeletonCard} />
      ))}
    </ul>
  );
}
