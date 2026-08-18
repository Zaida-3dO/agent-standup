// The Plan tab, as a timeline rather than a stack.
//
// ── Why a plan tab has to rank its contents ────────────────────────────
//
// An item accumulates plan snapshots: a plan is written, reviewed, revised,
// reviewed again. Render them all at full length in one column and two
// things go wrong, the second being the damaging one — the page has no upper
// bound on its height, and nothing on it is more prominent than anything
// else, so a plan agreed three rounds ago and revised twice since carries
// the same visual weight as the plan the work is actually being done
// against. It also comes first, because rounds ascend. A reader asking "what
// is the plan" reads a dead one.
//
// ── The shape ──────────────────────────────────────────────────────────
//
//   1. **A BLUF.** The bottom line of the live plan, in one line, before
//      anything else. A reader who wants only "what is the plan" is done
//      here.
//   2. **The latest snapshot, open.** It is the plan in force and it reads
//      as such: full width, expanded, under a heading that says it is
//      current.
//   3. **Superseded snapshots, collapsed.** Reachable in one click, most
//      recent first, each labelled with when it was written. The history is
//      what makes a plan review legible — a review's whole point is that a
//      plan changed in response to it, which is only checkable if both
//      versions are still reachable — so it is ranked, not removed.
//   4. **Plan reviews, their own section.** What was said ABOUT the plans is
//      a different kind of claim from the plans themselves, and interleaving
//      the two is half of what makes such a column read as undifferentiated.
//
// ── Why `<details>` rather than a toggle ───────────────────────────────
//
// A superseded snapshot is collapsed by default and expands on click, which
// is exactly `<details>`. Doing it with state would make this component
// stateful — and the DOM-free harness cannot call a component with hooks, so
// it would stop being directly testable, which is this repo's strongest
// convention. `<details>` also works with no JavaScript, is keyboard
// operable for free, and its contents are findable by the browser's own
// in-page search in current browsers.
//
// Hook-free and prop-driven — see `tests/helpers/react-element.ts`.
import type { DetailArtifact } from "@/lib/item-detail/types";
import { planBluf, planTimeline } from "@/lib/item-detail/plan";
import { VerdictBadge } from "./VerdictBadge";
import { FindingsList } from "./FindingsList";
import { Markdown } from "./Markdown";
import styles from "./ItemDetail.module.css";

export interface PlanPanelProps {
  readonly artifacts: readonly DetailArtifact[];
}

/**
 * A timestamp as a fixed, locale-free string — the same choice
 * `HistoryList` makes.
 *
 * Rendered from the ISO string by slicing rather than through
 * `toLocaleString`, because this component renders on the server and again
 * on the client, and a locale-dependent format produces two different
 * strings for the same instant — a hydration mismatch that is invisible in
 * development and appears as a warning, or a flicker, in production.
 */
function stamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** One plan snapshot's body, with its round and time. Shared by the live and superseded renderings. */
function snapshotBody(artifact: DetailArtifact) {
  return artifact.body === null || artifact.body.trim() === "" ? (
    <p className={styles.empty}>This plan snapshot has no body.</p>
  ) : (
    <Markdown source={artifact.body} />
  );
}

export function PlanPanel({ artifacts }: PlanPanelProps) {
  const { latest, superseded, reviews } = planTimeline(artifacts);
  const bluf = latest === null ? null : planBluf(latest.body);

  if (latest === null && reviews.length === 0) {
    return (
      <section className={styles.section} aria-label="Plan">
        <p className={styles.empty}>
          No plan recorded yet — a plan artifact appears here once one is written.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.section} aria-label="Plan">
      {/* The BLUF. Omitted rather than rendered empty when the plan's body
          has no prose to draw one from — an empty lead block reads as a
          rendering fault, where its absence reads as nothing to say. */}
      {bluf !== null && (
        <div className={styles.bluf} data-bluf="">
          <p className={styles.blufLabel}>Bottom line</p>
          <p className={styles.blufText}>{bluf}</p>
        </div>
      )}

      {latest !== null && (
        <div className={styles.planCurrent} data-plan="current">
          <div className={styles.planHead}>
            <h3 className={styles.planTitle}>Current plan</h3>
            <span className={styles.planMeta}>Round {latest.reviewRound}</span>
            <span className={styles.planMeta}>{stamp(latest.createdAt)}</span>
            {latest.verdict !== null && <VerdictBadge verdict={latest.verdict} />}
          </div>
          {snapshotBody(latest)}
        </div>
      )}

      {superseded.length > 0 && (
        <div className={styles.planHistory} data-plan="history">
          <h3 className={styles.planTitle}>
            Earlier snapshots
            <span className={styles.planCount}>{superseded.length}</span>
          </h3>
          {/* Each is its own `<details>` rather than one wrapping the whole
              list: a reader looking for what changed wants the version
              immediately before the current one, not all four at once. */}
          {superseded.map((snapshot) => (
            <details
              key={snapshot.id}
              className={styles.planSnapshot}
              data-snapshot={snapshot.id}
              data-superseded=""
            >
              <summary className={styles.disclosureSummary}>
                <span className={styles.planMeta}>Round {snapshot.reviewRound}</span>
                <span className={styles.planMeta}>{stamp(snapshot.createdAt)}</span>
                <span className={styles.planSuperseded}>superseded</span>
              </summary>
              {snapshotBody(snapshot)}
            </details>
          ))}
        </div>
      )}

      {reviews.length > 0 && (
        <div className={styles.planReviews} data-plan="reviews">
          <h3 className={styles.planTitle}>
            Plan reviews
            <span className={styles.planCount}>{reviews.length}</span>
          </h3>
          <ul className={styles.artifacts}>
            {reviews.map((review) => (
              <li key={review.id} className={styles.review} data-kind={review.kind}>
                <div className={styles.reviewHead}>
                  <span className={styles.planMeta}>Round {review.reviewRound}</span>
                  {review.verdict !== null && <VerdictBadge verdict={review.verdict} showMeaning />}
                </div>
                {/* A plan review grades findings exactly as a code review
                    does, and they were as unread here as they were there. */}
                <FindingsList findings={review.findings} />
                {review.body !== null && review.body.trim() !== "" && (
                  <Markdown source={review.body} density="compact" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
