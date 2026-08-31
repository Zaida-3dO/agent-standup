// One window's editor — MILESTONES.md #87, SCHEMA.md §17.4.
//
// Hook-free and prop-driven, so its branches are provable by calling it.
//
// ── The collision is drawn, not announced ───────────────────────────────
//
// The acceptance criterion this component exists to meet is that a boundary
// collision is shown "in terms of which windows collide and when". A form
// that said only "invalid" would be strictly less useful than showing
// somebody the raw stored value, since at least a raw value tells them what
// they typed.
//
// So a collision is surfaced four ways at once, each doing a different job:
//
//   1. **On the chart**, as a vertical mark at the moment it happens, with
//      a dot at the height where the two lines swapped. That is what makes
//      the *shape* of the fault obvious.
//   2. **On the offending fields**, as a marked fieldset — so the reader is
//      sent to the boundary to change rather than left to work out which of
//      the three is at fault.
//   3. **In a sentence**, in the form's own labels: "Wind down rises to 82%
//      3 hours in, above Stop at 75%". Not the schema's `windDown` spelling
//      — the reader is looking at a field labelled "Wind down".
//   4. **As the two numbers**, read out at the moment of the first
//      collision, so the crossing is checkable rather than asserted.
//
// All four run off the *draft*, recomputed on every keystroke, so the fault
// appears as it is typed and clears as it is fixed — never only after a save.
import { gridStepHours } from "@/lib/settings/budget-windows";
import type { BudgetWindow, CrossingProblem } from "@/lib/settings/budget-windows";
import {
  BAND_FIELD_LABELS,
  EDIT_BAND_KEYS,
  PRESETS,
  PRESET_HELP,
  PRESET_LABELS,
  bandsInProblem,
  describeRun,
  groupProblemRuns,
  presetDraft,
  problemPercent,
  valuesAt,
  withBoundary,
  type PresetName,
  type WindowDraft,
} from "@/lib/budget-page/edit";
import { describeMoment, readingsAt } from "@/lib/budget-page/scrubber";
import { describeBoundary } from "@/lib/budget-page/describe";
import { BandChart } from "./BandChart";
import { BoundaryFields } from "./BoundaryFields";
import styles from "./Budget.module.css";

export interface WindowEditorProps {
  readonly name: string;
  readonly draft: WindowDraft;
  /**
   * The draft as a window, or `null` while it is incomplete. Passed in
   * rather than derived here so the container computes it once and the
   * chart, the problems and the save button all agree about it.
   */
  readonly parsed: BudgetWindow | null;
  /** Crossings found in `parsed`. Empty while the draft does not parse. */
  readonly problems: readonly CrossingProblem[];
  /** Why this window cannot be saved yet, or `null`. */
  readonly incompleteness: string | null;
  /**
   * Where the scrubber sits, in hours, or `null` to follow the first
   * collision.
   *
   * `null` rather than a number default because "the reader has not
   * touched it" and "the reader has dragged it to 0h" are different
   * states: the first should keep tracking the fault as the draft is
   * edited, the second must stay where it was put.
   */
  readonly atHours: number | null;
  readonly onChange: (next: WindowDraft) => void;
  readonly onRemove: () => void;
  readonly onScrub: (atHours: number) => void;
}

export function WindowEditor(props: WindowEditorProps) {
  const { name, draft, parsed, problems, incompleteness, atHours, onChange, onRemove } = props;
  const invalid = problems.length > 0;

  // Every band any problem implicates, so a field can ask "am I one of them".
  const implicated = new Set(problems.flatMap((problem) => bandsInProblem(problem)));

  // The first collision is the one read out numerically. Sampling every
  // problem would be a wall of numbers; the earliest is the one to fix
  // first, and fixing it usually clears the rest.
  const firstProblem = problems[0];

  // The sentences to print: contiguous runs of the same fault, one line
  // each. Derived from `problems`, which stays intact alongside it, so the
  // chart and the save gate keep seeing every sampled moment.
  // The grid step comes from the parsed window, so a run breaks wherever
  // the window is genuinely healthy for a stretch rather than reading as
  // one long fault across it.
  const runs = parsed === null ? [] : groupProblemRuns(problems, gridStepHours(parsed.lengthHours));
  const readings =
    parsed !== null && firstProblem !== undefined ? valuesAt(parsed, firstProblem.atHours) : [];

  // Where the chart's marker and the scrubbed readout sit. Untouched, it
  // follows the first collision so the readout lines up with the numbers
  // printed beneath it; once dragged, it stays where it was put.
  //
  // Clamped to the window, because `lengthHours` is edited as free text in
  // the field above: shortening a window with the scrubber near its old end
  // would otherwise leave the marker off the right-hand edge of the chart.
  const scrubMax = parsed?.lengthHours ?? 0;
  const scrubAt =
    atHours === null ? (firstProblem?.atHours ?? 0) : Math.min(Math.max(atHours, 0), scrubMax);
  const scrubbedReadings = parsed === null ? [] : readingsAt(parsed, scrubAt);

  return (
    <section className={`${styles.card} ${invalid ? styles.cardInvalid : ""}`.trim()}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{name}</h2>
        <button type="button" className={styles.removeButton} onClick={onRemove}>
          Remove window
        </button>
      </div>

      <div className={styles.windowControls}>
        <label className={styles.fieldRow} htmlFor={`budget-${name}-enabled`}>
          <span className={styles.fieldLabel}>Enforced</span>
          <input
            id={`budget-${name}-enabled`}
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
        </label>

        <label className={styles.fieldRow} htmlFor={`budget-${name}-length`}>
          <span className={styles.fieldLabel}>Length in hours</span>
          <input
            id={`budget-${name}-length`}
            className={styles.input}
            type="text"
            inputMode="decimal"
            value={draft.lengthHours}
            onChange={(event) => onChange({ ...draft, lengthHours: event.target.value })}
          />
        </label>

        <label className={styles.fieldRow} htmlFor={`budget-${name}-preset`}>
          <span className={styles.fieldLabel}>Start from</span>
          <select
            id={`budget-${name}-preset`}
            className={styles.select}
            // Deliberately uncontrolled in value: a preset is an action, not
            // a property of the window. Showing one as "selected" would
            // claim the window still matches it after the first edit.
            value=""
            onChange={(event) => {
              const preset = event.target.value;
              if (preset === "") return;
              onChange(presetDraft(preset as PresetName));
            }}
          >
            <option value="">a preset…</option>
            {PRESETS.map((preset) => (
              <option key={preset} value={preset} title={PRESET_HELP[preset]}>
                {PRESET_LABELS[preset]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.boundaryForms}>
        {EDIT_BAND_KEYS.map((key) => (
          <BoundaryFields
            key={key}
            windowName={name}
            band={key}
            label={BAND_FIELD_LABELS[key]}
            draft={draft.boundaries[key]}
            implicated={implicated.has(key)}
            onChange={(next) => onChange(withBoundary(draft, key, next))}
          />
        ))}
      </div>

      {/* The chart needs a parsed window. While the draft is incomplete the
          reason is shown instead — a blank space where a chart was is a
          worse answer than the sentence saying what is missing. */}
      {parsed === null ? (
        <p className={styles.incomplete}>{incompleteness ?? "This window is not complete yet."}</p>
      ) : (
        <>
          {/* The window said out loud, one line per boundary.

              §17.4 tabulates each kind with how it "reads as", and
              `describeBoundary` is that column computed — a boundary a
              reader cannot say out loud is one they cannot check. Placed
              below the fields and above the chart, so the order reads: what
              you typed, what it means, what it looks like. */}
          <ul className={styles.boundaries}>
            {EDIT_BAND_KEYS.map((key) => (
              <li key={key} className={styles.boundary}>
                <span className={styles.boundaryLabel}>{BAND_FIELD_LABELS[key]}</span>
                <span className={styles.boundaryWords}>
                  {describeBoundary(parsed.boundaries[key])}
                </span>
              </li>
            ))}
          </ul>

          <BandChart window={parsed} problems={problems} atHours={scrubAt} />

          {/* The time scrubber, and every boundary read out at the moment it
              points to.

              The scrubber belongs on the editor rather than on a separate
              read-only page, for the reason `app/budget/page.tsx` gives:
              one surface answers both "what is configured" and "change it",
              so a reader never has to know which of two pages showing the
              same picture they wanted.

              It reads out at any moment, not only at a fault, because "what
              is the wind-down boundary 40 hours into a 168h window" is a
              question about a perfectly healthy window — and answering it
              from the chart is the thing that makes a schedule legible. */}
          <div className={styles.scrubber}>
            <input
              className={styles.scrubberInput}
              type="range"
              min={0}
              max={scrubMax}
              step={scrubMax / 100}
              value={scrubAt}
              aria-label={`Time into the ${name} window`}
              onChange={(event) => props.onScrub(Number(event.target.value))}
            />
            <span className={styles.scrubberMoment}>{describeMoment(scrubAt)}</span>
          </div>

          <ul className={styles.readings}>
            {scrubbedReadings.map((reading) => (
              <li
                key={reading.key}
                className={`${styles.reading} ${
                  reading.value === null ? styles.readingAbsent : ""
                }`.trim()}
              >
                {/* `null` prints as "no value" rather than 0%: a schedule
                    starting later genuinely has nothing to say before it,
                    and a zero would be a claim it does not make. */}
                {`${BAND_FIELD_LABELS[reading.key]}: ${
                  reading.value === null ? "no value" : `${Math.round(reading.value * 10) / 10}%`
                }`}
              </li>
            ))}
          </ul>
          {invalid && (
            /* `data-collision` marks this panel so a test can assert on it
               rather than on the whole page — the page's own subheading
               mentions collisions, so a page-wide text match would pass
               with this panel missing entirely. */
            <div className={styles.problems} data-collision={name}>
              <p className={styles.problemsTitle}>
                {/* Counted in faults, matching the lines below it. Counting
                    sampled moments instead would promise a hundred entries
                    above a list of one. */}
                {runs.length === 1
                  ? "These boundaries collide, and this window cannot be saved until they do not:"
                  : `These boundaries collide in ${runs.length} places, and this window cannot be saved until they do not:`}
              </p>
              {/* One entry per contiguous run of the same fault, not per
                  sampled moment. Two crossed constants are one statement
                  spanning the window, where this printed 101 near-identical
                  lines. The chart above still receives every problem, so
                  nothing is lost from the drawing — only from the prose. */}
              <ul className={styles.problemList}>
                {runs.map((run, index) => (
                  <li key={`${run.fromHours}-${run.toHours}-${index}`}>
                    {describeRun(run, parsed.lengthHours)}
                  </li>
                ))}
              </ul>

              {firstProblem !== undefined && (
                <div className={styles.collisionReadout}>
                  <p className={styles.collisionReadoutTitle}>
                    {`Every boundary ${describeMoment(firstProblem.atHours)}:`}
                  </p>
                  <ul className={styles.readings}>
                    {readings.map((reading) => (
                      <li
                        key={reading.key}
                        className={`${styles.reading} ${
                          implicated.has(reading.key) ? styles.readingImplicated : ""
                        }`.trim()}
                      >
                        {`${BAND_FIELD_LABELS[reading.key]}: ${
                          reading.value === null
                            ? "no value"
                            : `${Math.round(reading.value * 10) / 10}%`
                        }`}
                      </li>
                    ))}
                  </ul>
                  {/* Where on the y axis the fault sits, said as a number so
                      the mark on the chart is checkable rather than trusted. */}
                  {problemPercent(firstProblem) !== null && (
                    <p className={styles.collisionHeight}>
                      {`Marked on the chart at ${Math.round((problemPercent(firstProblem) ?? 0) * 10) / 10}%.`}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
