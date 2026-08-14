// One settings field, drawn from its derived widget — MILESTONES.md #86's
// "widgets, per-field help and validation all rendered from the registry".
//
// **There is no per-key branch in this file.** Every decision it makes is a
// switch on `field.widget.kind`, which `widgetFor` derived from the key's own
// Zod schema — so a new registry key renders here without this component
// being touched, which is the property row #86 is actually about. A `switch`
// on the key would compile, pass today, and quietly omit the next key added.
//
// Hook-free and prop-driven, like `BoardView` and `AppShellView`: this repo's
// harness has no DOM (`vitest.config.ts`: `environment: "node"`), so a
// component that takes plain props can be called directly as a function and
// its returned tree inspected — which is what proves these branches rather
// than merely rendering them once.
import type { SettingsField } from "@/lib/settings-page/model";
import { valueToInput, type Widget } from "@/lib/settings-page/widget";
import styles from "./Settings.module.css";

export interface SettingFieldProps {
  readonly field: SettingsField;
  /** What is currently typed into this field's editor — `undefined` means "untouched, show the stored value". */
  readonly draft?: string;
  /** What is typed into this field's confirmation box, for a guarded key. */
  readonly confirmText?: string;
  /** A message from the last attempted write on this field, if it failed. */
  readonly error?: string;
  readonly onDraftChange: (key: string, raw: string) => void;
  readonly onConfirmChange: (key: string, raw: string) => void;
  readonly onSave: (key: string) => void;
  readonly onReset: (key: string) => void;
}

function badgeClass(badge: SettingsField["badge"]): string {
  const base = styles.badge ?? "";
  if (badge === "Overridden") return `${base} ${styles.badgeOverride ?? ""}`;
  if (badge === "Invalid override") return `${base} ${styles.badgeInvalid ?? ""}`;
  return base;
}

/** The editor for one widget kind. The `json` case is the fallback for any shape not reduced further. */
function editor(
  field: SettingsField,
  widget: Widget,
  draft: string,
  onDraftChange: SettingFieldProps["onDraftChange"],
) {
  const id = `setting-${field.key}`;
  switch (widget.kind) {
    case "boolean":
      return (
        <select
          id={id}
          className={styles.select}
          value={draft}
          onChange={(event) => onDraftChange(field.key, event.target.value)}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "enum":
      return (
        <select
          id={id}
          className={styles.select}
          value={draft}
          onChange={(event) => onDraftChange(field.key, event.target.value)}
        >
          {(widget.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <input
          id={id}
          className={styles.input}
          type="number"
          // The bounds come off the schema itself, so the input enforces
          // exactly what the server will accept — not a second copy of the
          // limits that could drift from it.
          {...(widget.bounds?.min === undefined ? {} : { min: widget.bounds.min })}
          {...(widget.bounds?.max === undefined ? {} : { max: widget.bounds.max })}
          {...(widget.bounds?.integer ? { step: 1 } : {})}
          value={draft}
          onChange={(event) => onDraftChange(field.key, event.target.value)}
        />
      );
    case "string-list":
      return (
        <textarea
          id={id}
          className={styles.textarea}
          value={draft}
          placeholder="One entry per line"
          onChange={(event) => onDraftChange(field.key, event.target.value)}
        />
      );
    case "json":
      return (
        <textarea
          id={id}
          className={styles.textarea}
          value={draft}
          placeholder="A JSON value"
          onChange={(event) => onDraftChange(field.key, event.target.value)}
        />
      );
    default:
      return (
        <input
          id={id}
          className={styles.input}
          type="text"
          value={draft}
          onChange={(event) => onDraftChange(field.key, event.target.value)}
        />
      );
  }
}

export function SettingField({
  field,
  draft,
  confirmText,
  error,
  onDraftChange,
  onConfirmChange,
  onSave,
  onReset,
}: SettingFieldProps) {
  const widget = field.widget;
  // A field whose widget could not be derived is shown read-only rather than
  // with an editor that cannot produce a valid value. It still carries its
  // label, help and badge, so it is visible and explained — the one thing it
  // does not offer is a write that would be guesswork.
  const stored = widget ? valueToInput(field.value, widget) : JSON.stringify(field.value);
  const current = draft ?? stored;
  const guarded = field.sensitive || field.irreversible;

  return (
    <li className={styles.field}>
      <div className={styles.fieldHead}>
        <label className={styles.label} htmlFor={`setting-${field.key}`}>
          {field.label}
        </label>
        <span className={badgeClass(field.badge)}>{field.badge}</span>
      </div>
      <span className={styles.key}>{field.key}</span>
      <p className={styles.help}>{field.help}</p>
      <span className={styles.appliesWhen}>Applies: {field.appliesWhen}</span>

      {field.invalidOverride && (
        <div className={styles.invalidOverride}>
          <p>The stored value does not satisfy this setting&rsquo;s schema, so the default is in use.</p>
          <p className={styles.storedValue}>Stored: {JSON.stringify(field.invalidOverride.storedValue)}</p>
          {field.invalidOverride.errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}

      {widget && (
        <div className={styles.control}>
          {editor(field, widget, current, onDraftChange)}
          <button type="button" className={styles.button} onClick={() => onSave(field.key)}>
            Save
          </button>
          {field.canReset && (
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              onClick={() => onReset(field.key)}
            >
              Reset to default
            </button>
          )}
        </div>
      )}

      {guarded && (
        <div className={styles.confirm}>
          <p className={styles.confirmPrompt}>
            {field.irreversible
              ? "This setting can destroy data that cannot be recreated."
              : "This setting relaxes something the system enforces."}{" "}
            Type <code>{field.key}</code> to confirm before saving or resetting.
          </p>
          <input
            className={styles.input}
            type="text"
            aria-label={`Type ${field.key} to confirm`}
            value={confirmText ?? ""}
            onChange={(event) => onConfirmChange(field.key, event.target.value)}
          />
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </li>
  );
}
