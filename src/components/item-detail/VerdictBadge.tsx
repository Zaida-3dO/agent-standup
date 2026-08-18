// A review verdict, shown as the tier it actually is.
//
// The detail view rendered a verdict by stripping its underscores, which
// put `lgtm_with_nits` and `lgtm_with_followups` on screen as two strings
// differing by one word — and painted both, along with a plain `lgtm`, in
// one identical "pass" colour. The tier is the substance of what a reviewer
// said: whether the change merges on its own, merges once something is
// addressed against it, or merges while separate work is owed elsewhere.
// All three of those were flattened into "this passed".
//
// So the badge carries the label, and — where the caller asks for it — the
// one-sentence meaning beside it. The meaning is not a tooltip: a tooltip is
// invisible to a reader who is not hovering, on a touch screen, or reading
// the page as a screenshot in a review, and the obligation attached to a
// verdict is not optional detail.
//
// Hook-free and prop-driven so the DOM-free harness can call it directly —
// see `tests/helpers/react-element.ts`.
import { verdictDisplay, type VerdictTone } from "@/lib/item-detail/verdicts-display";
import styles from "./ItemDetail.module.css";

export interface VerdictBadgeProps {
  readonly verdict: string;
  /**
   * Shows the tier's meaning beside the label. On by default in a review
   * header, off where the badge is one chip among several in a metadata row
   * and a sentence would not fit.
   */
  readonly showMeaning?: boolean;
}

/** Tone → the class that paints it. Module scope: a constant, not per-render state. */
const TONE_CLASS: Record<VerdictTone, string | undefined> = {
  pass: styles.verdictPass,
  pass_with_work: styles.verdictPassWithWork,
  blocked: styles.verdictBlocked,
  neutral: styles.verdictNeutral,
};

export function VerdictBadge({ verdict, showMeaning = false }: VerdictBadgeProps) {
  const display = verdictDisplay(verdict);
  return (
    <span className={styles.verdictGroup} data-verdict={display.verdict} data-tone={display.tone}>
      <span
        className={`${styles.verdict} ${TONE_CLASS[display.tone] ?? ""}`.trim()}
        // The tone is on the badge as data as well as in its colour, so a
        // reader who cannot separate the two greens has the tier available
        // to a page search and to a screen reader, not only to the eye.
        data-verdict-label={display.label}
      >
        {display.label}
      </span>
      {showMeaning && <span className={styles.verdictMeaning}>{display.meaning}</span>}
    </span>
  );
}
