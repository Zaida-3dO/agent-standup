// How long an item has sat untouched — four bands, and the first one
// renders NOTHING.
//
// That is the design decision worth defending. An indicator on every card
// is an indicator on no card: if a fresh item carries a dot too, the eye
// cannot pick out the stale ones, which is the entire job. So under 4h this
// component returns `null` — not a transparent dot, which would still take
// up layout and quietly cost every card the width of an indicator it does
// not have.
//
// Past three days the dot grows a text label, because at that point the
// NUMBER is the message: "5d" tells you something a red dot cannot.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts`.
import { stalenessOf, stalenessToken, type StalenessLevel } from "@/lib/design/tokens";
import styles from "./Chips.module.css";

export interface StalenessDotProps {
  /**
   * How long since the item was last touched, in milliseconds.
   *
   * A duration rather than a timestamp deliberately: a component that read
   * `Date.now()` would be non-deterministic, unrenderable on the server
   * without a hydration mismatch, and untestable without freezing the
   * clock. The caller — which already knows what "now" means for its
   * screen — does the subtraction.
   */
  readonly ageMs: number;
}

/**
 * Renders the dot, or `null` when the item is fresh.
 *
 * Exported separately from the band logic so a caller that needs the band
 * for something else (a filter, a sort) uses `stalenessOf` rather than
 * inferring it from whether this returned an element.
 */
export function StalenessDot({ ageMs }: StalenessDotProps) {
  const level = stalenessOf(ageMs);
  const colour = stalenessToken(level);
  // `fresh` — see the header. Nothing at all, not an invisible something.
  if (colour === null) return null;

  const label = `Last touched ${formatAge(ageMs)} ago`;

  return (
    <span className={styles.staleRow} data-staleness={level} title={label}>
      {/* `role="img"` + a label, because a bare styled span is invisible to
          a screen reader — and staleness is exactly the kind of thing a
          non-visual reader most needs told, since they cannot scan a column
          for coloured dots. */}
      <span
        className={styles.staleDot}
        style={{ background: colour }}
        role="img"
        aria-label={label}
      />
      {/* Only in the worst band. See the header. */}
      {level === "abandoned" && (
        <span className={styles.staleAge} aria-hidden="true">
          {formatAge(ageMs)}
        </span>
      )}
    </span>
  );
}

/**
 * A duration as the shortest honest string: `7h`, `3d`, `21d`.
 *
 * Floors rather than rounds. "2d" for something 2.9 days old understates
 * it, but rounding to "3d" would claim it crossed the three-day boundary
 * that turns the dot red — so the text would contradict the colour beside
 * it. Understating by less than a unit is the cheaper error.
 */
export function formatAge(ageMs: number): string {
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 24) return `${Math.max(hours, 0)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Re-exported so a caller filtering by band does not import two modules. */
export type { StalenessLevel };
