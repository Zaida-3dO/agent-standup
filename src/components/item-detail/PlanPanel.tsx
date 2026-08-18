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

/**
 * The live plan's body with its opening paragraph removed, when the BLUF was
 * drawn from that paragraph.
 *
 * **Why this exists.** The BLUF is derived from the plan's first prose
 * paragraph, so on a plan that opens with its bottom line — which is the
 * shape a good plan has — the lead block and the first line of the card
 * below it are the same sentence, twice, a few centimetres apart. A summary
 * that only repeats the text immediately beneath it earns nothing for the
 * space it takes, and it makes the reader check whether they missed
 * something.
 *
 * So when the BLUF came from the body's own opening paragraph, that
 * paragraph is dropped from the card and the BLUF stands in for it. When the
 * BLUF came from somewhere the reader will not immediately re-read — a list
 * item, or a paragraph that was truncated — the body is left whole, because
 * then the lead is genuinely saying something the card does not.
 *
 * Matching is on the paragraph, not on the rendered BLUF: the BLUF has had
 * its markdown marks stripped and may be ellipsised, so comparing the two
 * strings directly would fail on exactly the plans where they *are* the same
 * sentence.
 */
function bodyWithoutLead(body: string | null, bluf: string | null): string | null {
  if (body === null || bluf === null) return body;
  // A truncated BLUF is a summary of a paragraph too long to be one, so the
  // paragraph still carries more than the lead does and stays.
  if (bluf.endsWith("…")) return body;

  const lines = body.split(/\r?\n/);
  let start = 0;
  // Skip the same leading non-prose the BLUF derivation skips: blank lines
  // and headings. Anything else means the BLUF came from further in, and the
  // opening of the body is not what it repeated.
  while (start < lines.length) {
    const line = lines[start]?.trim() ?? "";
    if (line === "" || /^#{1,6}\s/.test(line)) {
      start++;
      continue;
    }
    break;
  }
  let end = start;
  while (end < lines.length && (lines[end]?.trim() ?? "") !== "") end++;
  if (end === start) return body;

  const paragraph = lines.slice(start, end).join(" ").trim();
  // Compare through the same normalisation the BLUF went through, so
  // emphasis and inline code in the source do not defeat the match.
  if (planBluf(paragraph) !== bluf) return body;

  const remainder = lines.slice(end).join("\n").trim();
  return remainder === "" ? null : remainder;
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
          {/* The opening paragraph is dropped when the BLUF above already
              IS it — see `bodyWithoutLead`. The card keeps everything else,
              so nothing is lost, only un-repeated. */}
          {snapshotBody({ ...latest, body: bodyWithoutLead(latest.body, bluf) })}
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
              {/* A marker and the word "Show" carry the affordance. Without
                  them the row renders identically open and closed — the same
                  weight, the same layout, nothing on either edge — so it
                  reads as an inert metadata line and the history is
                  reachable only by a reader who clicks it on spec. The
                  marker rotates on open, and the label swaps to "Hide", so
                  the row names the action available rather than only
                  signalling that it has two states. */}
              <summary className={styles.disclosureSummary}>
                <span className={styles.disclosureMarker} aria-hidden="true">
                  ▶
                </span>
                <span className={styles.planMeta}>Round {snapshot.reviewRound}</span>
                <span className={styles.planMeta}>{stamp(snapshot.createdAt)}</span>
                <span className={styles.planSuperseded}>superseded</span>
                <span className={styles.disclosureHint}>Show</span>
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
