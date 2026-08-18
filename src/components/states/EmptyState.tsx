// The four "there is nothing to show" states, as one component the whole app
// shares — the generalisation of #123's "an empty state and a hidden state
// must not render identically".
//
// **Deliberately not board-shaped.** Every prop below is a caption or a
// count; nothing here knows what a column, an item or a card is, so the same
// component serves a board column, a people list, an event feed or a detail
// panel. That reuse is the point: the distinction between "nothing here" and
// "not fetched" is one a region gets wrong silently, and a per-region copy of
// it is a per-region opportunity to get it wrong.
//
// Hook-free and prop-driven, so a test calls it as a function and inspects
// the element tree it returns — this repo's harness runs `environment:
// "node"` with no DOM (see `tests/helpers/react-element.ts`).
import type { EmptyKind } from "@/lib/states/empty";
import styles from "./States.module.css";

export interface EmptyStateProps {
  /** Which of the three answers this is — see `emptinessOf`, which decides it. */
  readonly kind: EmptyKind;
  /**
   * What this region holds, singular and lower-case — "item", "profile",
   * "event". Used to build every caption, so one region reads "No items yet"
   * and another "No profiles yet" without either writing its own sentence.
   */
  readonly noun?: string;
  /**
   * How many rows exist but were not returned. Only meaningful for
   * `withheld` and `filtered`, where it is the number that makes the state
   * honest rather than vague — "175 here, not loaded" is a fact a reader can
   * act on; "not loaded" alone is very nearly as unhelpful as showing empty.
   */
  readonly total?: number;
  /** Loads the withheld rows. Given, `withheld` offers a control; absent, it only reports. */
  readonly onLoad?: () => void;
  /** Clears the filter. Given, `filtered` offers a control — the only one of the states the reader can fix. */
  readonly onClearFilter?: () => void;
  /** Overrides the generated caption where a region genuinely needs its own words. */
  readonly title?: string;
}

/** The plural of a noun for a caption — "item" → "items". */
function plural(noun: string): string {
  return noun.endsWith("s") ? noun : `${noun}s`;
}

export function EmptyState({
  kind,
  noun = "item",
  total,
  onLoad,
  onClearFilter,
  title,
}: EmptyStateProps) {
  // The withheld case is the one #123 is about, so it says the count out
  // loud. `total` is the region's real size, never the length of the page
  // that came back — the two differ on exactly this state.
  if (kind === "withheld") {
    return (
      <div className={`${styles.state} ${styles.withheld}`} data-state="withheld">
        <p className={styles.title}>
          {title ?? (total !== undefined ? `${total} ${plural(noun)}, not loaded` : "Not loaded")}
        </p>
        <p className={styles.detail}>
          This read did not fetch {plural(noun)} here — they exist, they were not returned.
        </p>
        {onLoad && (
          <button type="button" className={styles.action} onClick={onLoad}>
            Load {plural(noun)}
          </button>
        )}
      </div>
    );
  }

  // A filter the reader set excluded everything. The only state of the three
  // with something the reader can do about it, so it is the only one that
  // offers an action by default.
  if (kind === "filtered") {
    return (
      <div className={styles.state} data-state="filtered">
        <p className={styles.title}>{title ?? `No ${plural(noun)} match this filter`}</p>
        <p className={styles.detail}>
          {total !== undefined
            ? `${total} ${plural(noun)} here are hidden by the filter.`
            : `Everything here is hidden by the filter.`}
        </p>
        {onClearFilter && (
          <button type="button" className={styles.action} onClick={onClearFilter}>
            Clear filter
          </button>
        )}
      </div>
    );
  }

  // Genuinely nothing. No action, no count, no border — the only one of the
  // three that is safe to believe at a glance, and it should look like it.
  return (
    <div className={styles.state} data-state="empty">
      <p className={styles.title}>{title ?? `No ${plural(noun)} yet`}</p>
    </div>
  );
}
