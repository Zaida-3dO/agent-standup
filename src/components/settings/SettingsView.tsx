// The presentational half of MILESTONES.md #86: the load/error/loaded
// branching, the category sections, the `sensitive` section, the
// unrecognised and invalid-override sections, and the two read-only panels.
//
// Prop-driven and hook-free — same reasoning as `BoardView.tsx` and
// `AppShellView.tsx`: with `environment: "node"` and no DOM, a component
// that takes plain props can be called directly as a function and its
// returned tree inspected, which is what actually proves these branches.
// `Settings.tsx` is the thin client container that fetches and hands this
// component its props.
import { Fragment } from "react";
import Link from "next/link";
import type { SettingsLoadState } from "@/lib/settings-page/state";
import { settingsPageModel } from "@/lib/settings-page/model";
import { SettingField } from "./SettingField";
import styles from "./Settings.module.css";

export interface SettingsViewProps {
  readonly loadState: SettingsLoadState;
  /** Per-key editor contents. Absent for a key nobody has touched. */
  readonly drafts: Readonly<Record<string, string>>;
  /** Per-key confirmation-box contents, for the guarded keys. */
  readonly confirmations: Readonly<Record<string, string>>;
  /** Per-key message from the last failed write. */
  readonly errors: Readonly<Record<string, string>>;
  readonly onDraftChange: (key: string, raw: string) => void;
  readonly onConfirmChange: (key: string, raw: string) => void;
  readonly onSave: (key: string) => void;
  readonly onReset: (key: string) => void;
  readonly onRemoveUnrecognised: (key: string) => void;
}

export function SettingsView(props: SettingsViewProps) {
  const { loadState } = props;

  if (loadState.status === "error") {
    return (
      <div className={styles.centered}>
        <p>{loadState.message}</p>
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className={styles.centered}>
        <p>Loading settings…</p>
      </div>
    );
  }

  const model = settingsPageModel(loadState.response);
  const fieldProps = {
    drafts: props.drafts,
    confirmations: props.confirmations,
    errors: props.errors,
    onDraftChange: props.onDraftChange,
    onConfirmChange: props.onConfirmChange,
    onSave: props.onSave,
    onReset: props.onReset,
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Settings</h1>
      <p className={styles.subheading}>
        Every setting this build reads, with its value and where that value came from. Revision{" "}
        {model.revision}.
      </p>

      {/* T13: the non-first-run entry to profile management — #86 already
          made this page reachable with zero profiles; this is where an
          EXISTING one is renamed, recoloured or archived once at least one
          exists. New profiles are created from the picker itself. */}
      <div className={styles.links}>
        <Link className={styles.link} href="/admin/people">
          Manage profiles
        </Link>
        {/* `budget.windows` is a nested map of boundaries whose legality is a
            question about every moment of a window, not about a single field
            — so it has its own editor, which the sidebar also reaches
            directly. This link is kept alongside that one deliberately:
            somebody who has found the raw JSON field below should be
            offered the editor right beside it rather than having to know
            to look elsewhere. It stays editable as raw JSON below, which
            remains the escape hatch. */}
        <Link className={styles.link} href="/budget">
          Edit budget windows
        </Link>
      </div>

      {model.sections.map((section) => (
        <section key={section.category} className={styles.section}>
          <h2 className={styles.sectionTitle}>{section.category}</h2>
          <ul className={styles.fields}>
            {section.fields.map((field) => (
              <SettingField
                key={field.key}
                field={field}
                draft={fieldProps.drafts[field.key]}
                confirmText={fieldProps.confirmations[field.key]}
                error={fieldProps.errors[field.key]}
                onDraftChange={fieldProps.onDraftChange}
                onConfirmChange={fieldProps.onConfirmChange}
                onSave={fieldProps.onSave}
                onReset={fieldProps.onReset}
              />
            ))}
          </ul>
        </section>
      ))}

      {model.guarded.length > 0 && (
        <section className={`${styles.section} ${styles.guardedSection}`}>
          <h2 className={styles.sectionTitle}>These change what the system enforces</h2>
          <p className={styles.sectionNote}>
            Each of these switches off, or widens, something the system does to protect itself.
            Changing one takes typing its key to confirm, and is recorded as its own kind of audit
            event.
          </p>
          <ul className={styles.fields}>
            {model.guarded.map((field) => (
              <SettingField
                key={field.key}
                field={field}
                draft={fieldProps.drafts[field.key]}
                confirmText={fieldProps.confirmations[field.key]}
                error={fieldProps.errors[field.key]}
                onDraftChange={fieldProps.onDraftChange}
                onConfirmChange={fieldProps.onConfirmChange}
                onSave={fieldProps.onSave}
                onReset={fieldProps.onReset}
              />
            ))}
          </ul>
        </section>
      )}

      {model.unrecognised.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Unrecognised</h2>
          <p className={styles.sectionNote}>
            Stored values for keys this build does not declare. They affect nothing — resolution
            starts from the registry — and they are kept rather than deleted, so the record of what
            someone configured survives an upgrade.
          </p>
          <ul className={styles.fields}>
            {model.unrecognised.map((row) => (
              <li key={row.key} className={styles.field}>
                <span className={styles.key}>{row.key}</span>
                <p className={styles.storedValue}>{JSON.stringify(row.storedValue)}</p>
                <div className={styles.control}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonDanger}`}
                    onClick={() => props.onRemoveUnrecognised(row.key)}
                  >
                    Remove
                  </button>
                </div>
                {props.errors[row.key] && <p className={styles.error}>{props.errors[row.key]}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Build constants</h2>
        <p className={styles.sectionNote}>
          Fixed by this version. They describe what this build implements, so the only way to change
          one is to ship a new version.
        </p>
        {model.constants.length === 0 ? (
          <p className={styles.empty}>None reported.</p>
        ) : (
          <div className={styles.readOnlyTable}>
            {model.constants.map((constant) => (
              // A keyed fragment, not a wrapping element: the panel is a
              // three-column grid, so each row must be three sibling grid
              // items — a `div` around them would become one item and
              // collapse the columns.
              <Fragment key={constant.name}>
                <span className={styles.readOnlyName}>{constant.name}</span>
                <span className={styles.readOnlyValue}>{constant.value}</span>
                <span className={styles.readOnlyMeaning}>{constant.meaning}</span>
              </Fragment>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Bootstrap</h2>
        <p className={styles.sectionNote}>
          Read from the environment before the database is reachable, and changed by editing the
          environment and restarting. Their values are deliberately not shown here — that tier
          exists precisely because some values must not be readable from the application.
        </p>
        {model.bootstrap.length === 0 ? (
          <p className={styles.empty}>None reported.</p>
        ) : (
          <div className={styles.readOnlyTable}>
            {model.bootstrap.map((variable) => (
              <Fragment key={variable.name}>
                <span className={styles.readOnlyName}>{variable.name}</span>
                <span className={variable.set ? styles.setYes : styles.setNo}>
                  {variable.set ? "set" : "not set"}
                </span>
                <span className={styles.readOnlyMeaning}>{variable.meaning}</span>
              </Fragment>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
