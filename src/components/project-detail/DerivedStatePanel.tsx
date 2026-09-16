// The derived-state panel — MILESTONES.md #75, and the reason this page
// exists in the shape it does.
//
// A project has no state of its own. Its column is computed from its
// children (DECISIONS.md §13c), and Ope's rule states the computation
// plainly: *"if any of my contents is in progress then this project is
// considered in progress… if all of my contents are merged then it's
// considered merged"*.
//
// The server computes that correctly. **What nothing decided was what it
// should look like** — and a panel reading only `In progress` throws away
// the thing that makes a derived state worth deriving in the first place:
// the distribution underneath it, and which child produced the reading.
//
// So three things are rendered together, never one:
//
//   1. the rollup column,
//   2. the spread — finished against in-flight against not-started, as
//      one bar AND as text,
//   3. the one child causing the current reading, as a link.
//
// The test of whether this panel works is that *"why is this project
// blocked"* is answerable without opening the child. That is why the
// causing child carries its blocked reason inline rather than only a link:
// a link is an invitation to go and find out, and the point is not having
// to.
//
// Hook-free and prop-driven, so a test calls it as a function and inspects
// the element tree it returns (`tests/helpers/react-element.ts`).
import Link from "next/link";
import type { DerivedStateReading } from "@/lib/project-detail/types";
import {
  COLUMN_LABELS,
  bandsOf,
  countsOf,
  distributionOf,
  explainDerivedState,
  humanState,
} from "@/lib/project-detail/view";
import styles from "./ProjectDetail.module.css";

export interface DerivedStatePanelProps {
  readonly derived: DerivedStateReading;
  /** Total descendants — what the bar's bands are taken over. */
  readonly total: number;
  /** The progress reading, already decided by `progressOf` — see its three cases. */
  readonly progress:
    | { readonly kind: "ratio"; readonly value: number; readonly percent: number }
    | { readonly kind: "empty" }
    | { readonly kind: "none" };
}

export function DerivedStatePanel({ derived, total, progress }: DerivedStatePanelProps) {
  const segments = distributionOf(derived.counts, total);
  const bands = bandsOf(derived.counts, total);
  const tally = countsOf(derived.counts, total);
  const cause = derived.causingChild;

  return (
    <section
      className={styles.derived}
      aria-label="Project state"
      data-column={derived.column}
      // Read by the tests, and the honest summary of the panel's contract:
      // the reading is never shown without its evidence.
      data-has-distribution={segments.length > 0 ? "true" : "false"}
      data-has-cause={cause !== null ? "true" : "false"}
    >
      <div className={styles.derivedTop}>
        <span className={styles.derivedColumn} data-derived-column={derived.column}>
          {COLUMN_LABELS[derived.column]}
        </span>
        {/* Said out loud rather than assumed. A reader who does not know
            that a project's column is computed will otherwise read it as a
            state somebody set, and then be puzzled that it cannot be
            changed. */}
        <span className={styles.derivedNote}>
          derived from {total === 0 ? "no" : total} children
        </span>
      </div>

      {/* The whole reading as one sentence — the thing a reader would
          otherwise have to assemble from three separate regions. */}
      <p className={styles.derivedSentence} data-derived-sentence="true">
        {explainDerivedState(derived, total)}
      </p>

      {total > 0 && (
        <div className={styles.progressBlock}>
          <div className={styles.progressLabels}>
            {/* "Closed", not "merged" — the number counts every terminal
                state, and calling it merged invited exactly the misreading
                this panel is being fixed for. */}
            <span>
              {tally.done} of {total} closed
            </span>
            {progress.kind === "ratio" && (
              <span className={styles.progressPercent}>{progress.percent}%</span>
            )}
          </div>
          {/* One bar, three bands — see `bandsOf`. Finished and active are
              drawn as widths off the same total; whatever is left of the
              track is the not-started remainder. */}
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={tally.done}
            aria-label={`${tally.done} of ${total} children closed, ${tally.onDeck} on deck`}
          >
            <div
              className={styles.progressFill}
              data-band="finished"
              data-percent={progress.kind === "ratio" ? progress.percent : 0}
              style={{ width: `${bands.finished * 100}%` }}
            />
            <div
              className={styles.progressActive}
              data-band="active"
              style={{ width: `${bands.active * 100}%` }}
            />
          </div>

          {/* The bands as text, so nothing is lost to a reader who cannot
              see colour. Three numbers that sum to the total. */}
          <p className={styles.stripLegend} data-distribution-text="true">
            On deck {tally.onDeck} · Done {tally.done} · Not started {tally.notStarted}
          </p>
        </div>
      )}

      {cause !== null && (
        <p className={styles.cause} data-causing-child={cause.id}>
          <span className={styles.causeLabel}>{COLUMN_LABELS[derived.column]} because of</span>
          <Link href={`/items/${cause.id}`} className={styles.causeLink}>
            {cause.title}
          </Link>
          <span className={styles.causeLabel}>({humanState(cause.state)})</span>
          {/* Inline rather than behind the link: the point of naming the
              causing child is that the question is answered here. */}
          {cause.blockedReason !== null && cause.blockedReason.trim() !== "" && (
            <span className={styles.causeReason}>{cause.blockedReason}</span>
          )}
        </p>
      )}
    </section>
  );
}
