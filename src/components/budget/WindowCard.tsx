// One window's card — MILESTONES.md #87.
//
// Hook-free, for the same reason every presentational component here is:
// it can be called as a function and its tree walked, which is what proves
// the branches in an environment with no DOM.
//
// A card carries the three things a reader needs to judge one window: the
// boundaries said in plain words, the chart, and — when the window is
// incoherent — the crossings both drawn on the chart and listed underneath.
// The list is not a duplicate of the marks: it is what a screen reader
// reaches and what somebody copies into a bug report, while the marks are
// what makes the *shape* of the fault obvious.
import type { BudgetWindow, CrossingProblem } from "@/lib/settings/budget-windows";
import { BAND_KEYS, BAND_LABELS } from "@/lib/budget-page/chart";
import { describeBoundary, KIND_HELP } from "@/lib/budget-page/describe";
import { describeMoment, readingsAt } from "@/lib/budget-page/scrubber";
import { BandChart } from "./BandChart";
import styles from "./Budget.module.css";

export interface WindowCardProps {
  readonly name: string;
  readonly window: BudgetWindow;
  readonly problems: readonly CrossingProblem[];
  readonly atHours: number;
  readonly onScrub: (name: string, atHours: number) => void;
}

export function WindowCard({ name, window, problems, atHours, onScrub }: WindowCardProps) {
  const invalid = problems.length > 0;
  const readings = readingsAt(window, atHours);

  return (
    <section className={`${styles.card} ${invalid ? styles.cardInvalid : ""}`.trim()}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{name}</h2>
        <span className={styles.cardMeta}>{`${window.lengthHours}h window`}</span>
      </div>

      {/* An enabled flag that is off is worth saying, not worth hiding the
          window for: a disabled window is still configuration somebody
          wrote and will come back to. */}
      {!window.enabled && (
        <p className={styles.disabled}>Not enforced — this window is disabled.</p>
      )}

      <ul className={styles.boundaries}>
        {BAND_KEYS.map((key) => {
          const boundary = window.boundaries[key];
          return (
            <li key={key} className={styles.boundary}>
              <span className={styles.boundaryLabel}>{BAND_LABELS[key]}</span>
              <span className={styles.boundaryKind}>{boundary.kind}</span>
              <span>
                <span className={styles.boundaryWords}>{describeBoundary(boundary)}</span>
                <span className={styles.kindHelp}>{KIND_HELP[boundary.kind]}</span>
              </span>
            </li>
          );
        })}
      </ul>

      <BandChart window={window} problems={problems} atHours={atHours} />

      <div className={styles.scrubber}>
        <input
          className={styles.scrubberInput}
          type="range"
          min={0}
          max={window.lengthHours}
          step={window.lengthHours / 100}
          value={atHours}
          aria-label={`Time into the ${name} window`}
          onChange={(event) => onScrub(name, Number(event.target.value))}
        />
        <span className={styles.scrubberMoment}>{describeMoment(atHours)}</span>
      </div>

      <ul className={styles.readings}>
        {readings.map((reading) => (
          <li
            key={reading.key}
            className={`${styles.reading} ${reading.value === null ? styles.readingAbsent : ""}`.trim()}
          >
            {/* `null` is printed as "no value" rather than as 0%, because a
                schedule that starts later genuinely has nothing to say
                before it and a zero would be a claim it does not make. */}
            {`${reading.label}: ${reading.value === null ? "no value" : `${Math.round(reading.value * 10) / 10}%`}`}
          </li>
        ))}
      </ul>

      {invalid && (
        <div className={styles.problems}>
          <p className={styles.problemsTitle}>
            {problems.length === 1
              ? "One moment where these boundaries do not hold:"
              : `${problems.length} moments where these boundaries do not hold:`}
          </p>
          <ul className={styles.problemList}>
            {problems.map((problem, index) => (
              <li key={`${problem.atHours}-${index}`}>{problem.message}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
