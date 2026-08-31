// The review card — MILESTONES.md #68, carrying #69's flagged-run question.
//
// Hook-free and prop-driven, like every other presentational component
// here, so a test calls it as a function and inspects the element tree it
// returns (`tests/helpers/react-element.ts`). See `TopBar.tsx` for the full
// reasoning; the short version is that with `environment: "node"` and no
// DOM, this is what actually proves the branches.
//
// ── The invariant this component exists to hold ────────────────────────
//
// **Seen never depends on the sliders.** The Seen button is rendered from
// `canMarkSeen(personId)` alone and is never given a `disabled` derived
// from any score. That is the row's stated constraint, and it is asserted
// directly in `tests/review-card-component.test.ts` — a card with untouched
// sliders, a card with no facets at all, and a card whose run is flagged
// must all still offer Seen.
//
// The scoring section is genuinely optional: with no facets in play it is
// absent entirely, and the card degrades to exactly the Seen action it
// would have had without this milestone.
import type { Facet } from "@/lib/scoring/run-scores";
import { RUN_SCALE_POINTS, RUN_SCORE_MEANINGS } from "@/lib/scoring/run-scores";
import type { ReviewRow } from "@/lib/review/card";
import { acceptedScores, canMarkSeen } from "@/lib/review/card";
import type { FlaggableRun } from "@/lib/review/flagged";
import { flagReasonFor, flaggedRunLabel, flaggedRunQuestion } from "@/lib/review/flagged";
import type { SubmittedScore } from "@/lib/review/card";
import styles from "./ReviewCard.module.css";

export interface ReviewCardViewProps {
  /** The item this card is about, for labelling the controls. */
  readonly itemTitle: string | null;
  /** One row per facet in play — already filtered by `reviewRows`. */
  readonly rows: readonly ReviewRow[];
  /** The active profile, or null. Decides whether any action is offered. */
  readonly personId: string | null;
  /** The run behind this card, when there is one — drives #69's question. */
  readonly run?: FlaggableRun | null;
  /** Confidence at or below which a run is flagged. From `model_picker.flag_below_strength`. */
  readonly flagBelowStrength?: number;
  /** A person moved a slider. */
  readonly onScore?: (facet: Facet, score: number) => void;
  /** A person pressed "these look right" — writes `user_score = agent_score`. */
  readonly onAccept?: (scores: readonly SubmittedScore[]) => void;
  /** A person marked the card seen. Never gated on a score. */
  readonly onMarkSeen?: () => void;
}

/**
 * What one row shows to the right of its slider.
 *
 * The person's score wins where they gave one, and is labelled as theirs —
 * "you" against "agent" is the distinction SCHEMA.md §12 exists to keep, so
 * the display keeps it too rather than showing one number and losing which
 * scale it came from.
 */
function valueLabel(row: ReviewRow): string {
  if (row.userScore !== null) return `you: ${row.userScore}`;
  if (row.agentScore !== null) return `agent: ${row.agentScore}`;
  return "unscored";
}

export function ReviewCardView({
  itemTitle,
  rows,
  personId,
  run = null,
  flagBelowStrength,
  onScore,
  onAccept,
  onMarkSeen,
}: ReviewCardViewProps) {
  // Seen is decided by the profile and nothing else. Deliberately computed
  // before and independently of anything about the rows — see the header.
  const mayMarkSeen = canMarkSeen(personId);

  const flagReason = run ? flagReasonFor(run, flagBelowStrength) : null;
  const question = run ? flaggedRunQuestion(run, flagBelowStrength) : null;

  // "These look right" only means something when the agent scored
  // something to agree with. With nothing scored there is no number to
  // copy, so the control is disabled rather than writing nothing and
  // looking broken.
  const acceptable = acceptedScores(rows);

  const cardClass = `${styles.card} ${flagReason !== null ? styles.flagged : ""}`.trim();

  return (
    <section
      className={cardClass}
      aria-label={itemTitle === null ? "Review this run" : `Review: ${itemTitle}`}
      data-flagged={flagReason !== null}
    >
      {flagReason !== null && (
        <span className={styles.flagLabel}>{flaggedRunLabel(flagReason)}</span>
      )}
      {question !== null && <p className={styles.question}>{question}</p>}

      {/* No facets in play means no sliders — the card asks about what
          happened and nothing else. This is an ordinary state, not an
          error, and it must not affect the Seen action below. */}
      {rows.length > 0 && (
        <ul className={styles.rows}>
          {rows.map((row) => (
            <li key={row.facet} className={styles.row} data-facet={row.facet}>
              <span className={styles.facet}>{row.facet}</span>
              <input
                type="range"
                className={styles.slider}
                min={RUN_SCALE_POINTS[RUN_SCALE_POINTS.length - 1]}
                max={RUN_SCALE_POINTS[0]}
                step={1}
                // An untouched slider shows the agent's score as its
                // position, but `userScore` stays null underneath — the
                // position is a starting point to drag from, never a
                // score this person gave. `data-user-scored` is what
                // distinguishes the two for a reader and a test.
                value={row.userScore ?? row.agentScore ?? 3}
                data-user-scored={row.userScore !== null}
                aria-label={`How the ${row.facet} of this run went`}
                aria-valuetext={
                  row.userScore === null
                    ? "not scored"
                    : (RUN_SCORE_MEANINGS[row.userScore] ?? String(row.userScore))
                }
                disabled={!mayMarkSeen || onScore === undefined}
                onChange={(e) => onScore?.(row.facet, Number(e.target.value))}
              />
              <span
                className={`${styles.value} ${row.userScore !== null ? styles.userValue : ""}`.trim()}
              >
                {valueLabel(row)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.actions}>
        {rows.length > 0 && onAccept && (
          <button
            type="button"
            className={styles.accept}
            disabled={!mayMarkSeen || acceptable.length === 0}
            onClick={() => onAccept(acceptable)}
          >
            These look right
          </button>
        )}
        {/* Seen. Rendered from `mayMarkSeen` alone — no score, no row
            count and no flag state is consulted. MILESTONES.md #68:
            scoring never blocks Seen. */}
        {mayMarkSeen && onMarkSeen && (
          <button type="button" className={styles.seen} onClick={onMarkSeen}>
            Mark seen
          </button>
        )}
      </div>

      {rows.length > 0 && (
        <p className={styles.hint}>Scoring is optional — you can mark this seen without it.</p>
      )}
    </section>
  );
}
