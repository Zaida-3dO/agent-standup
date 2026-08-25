// One boundary's form — MILESTONES.md #87, SCHEMA.md §17.4.
//
// Hook-free and prop-driven, like every presentational component on this
// page: it can be called as a function and its tree walked, which is what
// proves these branches in an environment with no DOM.
//
// ── Why three forms rather than one ─────────────────────────────────────
//
// The three kinds are not three renderings of one shape. A constant is a
// number; a linear is a rate, a starting point and a unit; a schedule is a
// list of steps each carrying one of the other two. A single "value" box
// with a kind dropdown beside it would be a JSON editor with extra steps —
// so each kind gets the fields it actually has, and switching kind keeps
// what you typed into the others (see `withKind`).
import type { BandKey } from "@/lib/settings/budget-windows";
import {
  BOUNDARY_KINDS,
  withEntry,
  withEntryAdded,
  withEntryRemoved,
  withKind,
  type BoundaryDraft,
  type BoundaryKind,
  type EntryDraft,
  type PerUnit,
} from "@/lib/budget-page/edit";
import { KIND_HELP } from "@/lib/budget-page/describe";
import styles from "./Budget.module.css";

export interface BoundaryFieldsProps {
  /** The window this boundary belongs to — part of every field's id. */
  readonly windowName: string;
  readonly band: BandKey;
  readonly label: string;
  readonly draft: BoundaryDraft;
  /** True when a crossing implicates this boundary — see `bandsInProblem`. */
  readonly implicated: boolean;
  readonly onChange: (next: BoundaryDraft) => void;
}

const PER_UNITS: readonly PerUnit[] = ["hour", "day"];

/** Field ids are stable and unique per window+band, so labels bind correctly. */
function fieldId(windowName: string, band: string, name: string): string {
  return `budget-${windowName}-${band}-${name}`.replace(/\s+/g, "-");
}

export function BoundaryFields(props: BoundaryFieldsProps) {
  const { windowName, band, label, draft, implicated, onChange } = props;
  const id = (name: string) => fieldId(windowName, band, name);

  return (
    <fieldset
      className={`${styles.boundaryFields} ${implicated ? styles.fieldsImplicated : ""}`.trim()}
      // The whole group is marked rather than one input, because a crossing
      // is a fault of this boundary against another — there is no single box
      // that is wrong.
      aria-invalid={implicated || undefined}
      data-band={band}
    >
      <legend className={styles.boundaryLegend}>{label}</legend>

      <label className={styles.fieldRow} htmlFor={id("kind")}>
        <span className={styles.fieldLabel}>Kind</span>
        <select
          id={id("kind")}
          className={styles.select}
          value={draft.kind}
          onChange={(event) => onChange(withKind(draft, event.target.value as BoundaryKind))}
        >
          {BOUNDARY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.kindHelp}>{KIND_HELP[draft.kind]}</p>

      {draft.kind === "constant" && (
        <label className={styles.fieldRow} htmlFor={id("value")}>
          <span className={styles.fieldLabel}>Percent</span>
          <input
            id={id("value")}
            className={styles.input}
            // `type="text"` with a numeric hint rather than `type="number"`:
            // a number input silently discards what it cannot parse, so a
            // half-typed "1e" vanishes from the model while still showing on
            // screen, and the draft and the box disagree about what was typed.
            type="text"
            inputMode="decimal"
            value={draft.constantValue}
            onChange={(event) => onChange({ ...draft, constantValue: event.target.value })}
          />
        </label>
      )}

      {draft.kind === "linear" && (
        <>
          <label className={styles.fieldRow} htmlFor={id("slope")}>
            <span className={styles.fieldLabel}>Rate</span>
            <input
              id={id("slope")}
              className={styles.input}
              type="text"
              inputMode="decimal"
              value={draft.slope}
              onChange={(event) => onChange({ ...draft, slope: event.target.value })}
            />
          </label>
          <label className={styles.fieldRow} htmlFor={id("offset")}>
            <span className={styles.fieldLabel}>Starting at</span>
            <input
              id={id("offset")}
              className={styles.input}
              type="text"
              inputMode="decimal"
              value={draft.offset}
              onChange={(event) => onChange({ ...draft, offset: event.target.value })}
            />
          </label>
          <label className={styles.fieldRow} htmlFor={id("per")}>
            <span className={styles.fieldLabel}>Per</span>
            <select
              id={id("per")}
              className={styles.select}
              value={draft.per}
              onChange={(event) => onChange({ ...draft, per: event.target.value as PerUnit })}
            >
              {PER_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {draft.kind === "schedule" && (
        <div className={styles.entries}>
          {draft.entries.map((entry, index) => (
            <EntryFields
              key={index}
              index={index}
              entry={entry}
              idFor={(name) => id(`entry-${index}-${name}`)}
              /* The last step cannot be removed — the schema requires at
                 least one, so offering the button would be a dead end. */
              removable={draft.entries.length > 1}
              onChange={(next) => onChange(withEntry(draft, index, next))}
              onRemove={() => onChange(withEntryRemoved(draft, index))}
            />
          ))}
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => onChange(withEntryAdded(draft))}
          >
            Add a step
          </button>
        </div>
      )}
    </fieldset>
  );
}

interface EntryFieldsProps {
  readonly index: number;
  readonly entry: EntryDraft;
  readonly idFor: (name: string) => string;
  readonly removable: boolean;
  readonly onChange: (next: EntryDraft) => void;
  readonly onRemove: () => void;
}

/**
 * One step of a schedule.
 *
 * The anchor's "from which end" is a control rather than something inferred
 * from the number, because "after 2 hours" and "in the final 2 hours" are
 * the same digits and different rules — §17.4 allows both deliberately, so
 * the form has to ask which was meant.
 */
function EntryFields({ index, entry, idFor, removable, onChange, onRemove }: EntryFieldsProps) {
  return (
    <div className={styles.entry}>
      <span className={styles.entryNumber}>{`Step ${index + 1}`}</span>

      <label className={styles.fieldRow} htmlFor={idFor("anchorFrom")}>
        <span className={styles.fieldLabel}>Starts</span>
        <select
          id={idFor("anchorFrom")}
          className={styles.select}
          value={entry.anchorFrom}
          onChange={(event) =>
            onChange({ ...entry, anchorFrom: event.target.value as "elapsed" | "remaining" })
          }
        >
          <option value="elapsed">after</option>
          <option value="remaining">in the final</option>
        </select>
      </label>

      <label className={styles.fieldRow} htmlFor={idFor("anchorAmount")}>
        <span className={styles.fieldLabel}>Amount</span>
        <input
          id={idFor("anchorAmount")}
          className={styles.input}
          type="text"
          inputMode="decimal"
          value={entry.anchorAmount}
          onChange={(event) => onChange({ ...entry, anchorAmount: event.target.value })}
        />
      </label>

      <label className={styles.fieldRow} htmlFor={idFor("anchorPer")}>
        <span className={styles.fieldLabel}>Unit</span>
        <select
          id={idFor("anchorPer")}
          className={styles.select}
          value={entry.anchorPer}
          onChange={(event) => onChange({ ...entry, anchorPer: event.target.value as PerUnit })}
        >
          {PER_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {`${unit}s`}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.fieldRow} htmlFor={idFor("valueKind")}>
        <span className={styles.fieldLabel}>Then</span>
        <select
          id={idFor("valueKind")}
          className={styles.select}
          value={entry.valueKind}
          onChange={(event) =>
            onChange({ ...entry, valueKind: event.target.value as "constant" | "linear" })
          }
        >
          <option value="constant">a fixed percent</option>
          <option value="linear">a moving rate</option>
        </select>
      </label>

      {entry.valueKind === "constant" ? (
        <label className={styles.fieldRow} htmlFor={idFor("constantValue")}>
          <span className={styles.fieldLabel}>Percent</span>
          <input
            id={idFor("constantValue")}
            className={styles.input}
            type="text"
            inputMode="decimal"
            value={entry.constantValue}
            onChange={(event) => onChange({ ...entry, constantValue: event.target.value })}
          />
        </label>
      ) : (
        <>
          <label className={styles.fieldRow} htmlFor={idFor("slope")}>
            <span className={styles.fieldLabel}>Rate</span>
            <input
              id={idFor("slope")}
              className={styles.input}
              type="text"
              inputMode="decimal"
              value={entry.slope}
              onChange={(event) => onChange({ ...entry, slope: event.target.value })}
            />
          </label>
          <label className={styles.fieldRow} htmlFor={idFor("offset")}>
            <span className={styles.fieldLabel}>Starting at</span>
            <input
              id={idFor("offset")}
              className={styles.input}
              type="text"
              inputMode="decimal"
              value={entry.offset}
              onChange={(event) => onChange({ ...entry, offset: event.target.value })}
            />
          </label>
          <label className={styles.fieldRow} htmlFor={idFor("per")}>
            <span className={styles.fieldLabel}>Per</span>
            <select
              id={idFor("per")}
              className={styles.select}
              value={entry.per}
              onChange={(event) => onChange({ ...entry, per: event.target.value as PerUnit })}
            >
              {PER_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {removable && (
        <button type="button" className={styles.removeButton} onClick={onRemove}>
          Remove step
        </button>
      )}
    </div>
  );
}
