// The presentational half of the interventions section — MILESTONES.md
// #128: the load/error/loaded branching, the per-entry control, and the
// badges that say where each entry's level came from.
//
// Prop-driven and hook-free — same reasoning as `SettingsView.tsx`: with
// `environment: "node"` and no DOM, a component that takes plain props can
// be called directly as a function and its returned tree inspected, which is
// what actually proves these branches. `Interventions.tsx` is the thin
// client container that fetches and hands this component its props.
import type { LevelChoice } from "@/lib/interventions/configurable";
import type { InterventionsLoadState } from "@/lib/interventions-page/state";
import { interventionsModel, type InterventionField } from "@/lib/interventions-page/model";
import styles from "./Interventions.module.css";

export interface InterventionsViewProps {
  readonly loadState: InterventionsLoadState;
  /** Per-id message from the last failed change. */
  readonly errors: Readonly<Record<string, string>>;
  /** Ids with a change in flight, so the control can refuse a second one. */
  readonly pending: Readonly<Record<string, true>>;
  readonly onChoose: (id: string, choice: LevelChoice) => void;
}

/**
 * Whether a string is one of the choices this control offers.
 *
 * A `select`'s value arrives as a bare string, and handing it on as a
 * `LevelChoice` because the markup only contains valid ones would be a cast
 * standing in for a check. It costs one comparison against the options the
 * field itself declares, which is also the list the server will validate
 * against — so a value that somehow arrives from outside the menu is
 * dropped here rather than sent.
 */
function choiceFromValue(field: InterventionField, raw: string): LevelChoice | null {
  const match = field.options.find((option) => option.value === raw);
  return match ? match.value : null;
}

export function InterventionsView(props: InterventionsViewProps) {
  const { loadState } = props;

  if (loadState.status === "error") {
    return (
      <div className={styles.page}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Interventions</h2>
          <p className={styles.error}>{loadState.message}</p>
        </section>
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className={styles.page}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Interventions</h2>
          <p className={styles.empty}>Loading interventions…</p>
        </section>
      </div>
    );
  }

  const model = interventionsModel(loadState.response);

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Interventions</h2>
        <p className={styles.sectionNote}>
          What this installation notices and what it does about it. Each entry ships with a level;
          setting one here overrides it, and that choice sticks — including across an upgrade that
          retunes the shipped level. Leaving an entry on its default means it follows this build.
          {model.overriddenCount > 0 && (
            <>
              {" "}
              {model.overriddenCount} of {model.fields.length}{" "}
              {model.overriddenCount === 1 ? "is" : "are"} set here.
            </>
          )}
        </p>

        {model.fields.length === 0 ? (
          <p className={styles.empty}>This build ships no interventions.</p>
        ) : (
          <ul className={styles.entries}>
            {model.fields.map((field) => {
              const selected = field.options.find((option) => option.value === field.choice);
              const busy = props.pending[field.id] === true;
              return (
                <li
                  key={field.id}
                  className={`${styles.entry} ${field.silent ? styles.entrySilent : ""}`}
                >
                  <div className={styles.entryHead}>
                    <span className={styles.id}>{field.id}</span>
                    <span className={styles.badges}>
                      <span className={styles.badge}>{field.phase}</span>
                      <span className={styles.badge}>{field.audience}</span>
                      {field.overridden && (
                        <span className={`${styles.badge} ${styles.badgeOverride}`}>Set here</span>
                      )}
                    </span>
                  </div>

                  <p className={styles.summary}>{field.summary}</p>

                  {field.silenceReason !== null && (
                    <p className={styles.silence}>{field.silenceReason}</p>
                  )}

                  <div className={styles.control}>
                    <label className={styles.consequence} htmlFor={`level-${field.id}`}>
                      Level
                    </label>
                    <select
                      id={`level-${field.id}`}
                      className={styles.select}
                      value={field.choice}
                      disabled={busy}
                      onChange={(event) => {
                        const choice = choiceFromValue(field, event.target.value);
                        if (choice !== null) props.onChoose(field.id, choice);
                      }}
                    >
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {selected && <span className={styles.consequence}>{selected.consequence}</span>}
                  </div>

                  {field.blockingUnavailable !== null && (
                    <p className={styles.unavailable}>{field.blockingUnavailable}</p>
                  )}

                  {props.errors[field.id] && (
                    <p className={styles.error}>{props.errors[field.id]}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
