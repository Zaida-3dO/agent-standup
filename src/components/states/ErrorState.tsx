// A read that failed, reported so the reader knows WHICH read failed.
//
// **"Something went wrong" is not an error state, it is a shrug.** The
// standard this component is held to is one the app already meets in places
// — "Could not load profiles (GET /api/people returned 500)" — and the
// value in that sentence is entirely in the parenthesis: it names the call,
// so the failure can be repeated, reported, or recognised as the same one as
// last time. A message without it is indistinguishable from every other
// failure in the product.
//
// Hook-free and prop-driven; see `EmptyState.tsx`'s header.
import styles from "./States.module.css";

export interface ErrorStateProps {
  /**
   * What failed, in the reader's terms — "Could not load the board".
   *
   * The messages the state modules under `src/lib` throw already carry the
   * failing call inside this sentence, so passing one whole is correct and is
   * what the board does. `call` below is for a caller that holds the two
   * separately.
   */
  readonly message: string;
  /**
   * The failing call, when it is not already inside `message` — for example
   * a method and path. Rendered on its own line.
   */
  readonly call?: string;
  /** Retries the failed read. Absent when the caller has no way to retry — then this only reports. */
  readonly onRetry?: () => void;
  /** True while a retry is in flight, so the control cannot be pressed twice. */
  readonly retrying?: boolean;
  /** Centres the block, for an error that owns a whole panel rather than sitting in a column. */
  readonly centered?: boolean;
}

export function ErrorState({ message, call, onRetry, retrying, centered }: ErrorStateProps) {
  return (
    <div
      className={`${styles.state} ${styles.error} ${centered ? styles.centered : ""}`.trim()}
      data-state="error"
      // Announced, not merely displayed: a read that failed after the page
      // was already up changes nothing visible except this block, and a
      // reader not looking at it would otherwise be told nothing at all.
      role="alert"
    >
      <p className={styles.errorTitle}>{message}</p>
      {call !== undefined && <p className={styles.call}>{call}</p>}
      {onRetry && (
        <button
          type="button"
          className={styles.action}
          onClick={onRetry}
          disabled={retrying === true}
        >
          {retrying === true ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
