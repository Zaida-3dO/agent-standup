// One editable field on the administration surface — MILESTONES.md #93.
//
// Switches on `field.kind`, never on the field's name or its entity kind, so
// the same component draws a repository's default branch and an account's
// budget windows. That is what makes "one page pattern per entity kind" true
// of the code rather than only of the description.
//
// Hook-free and prop-driven, like `BoardView` and `SettingsView`: the harness
// has no DOM (`vitest.config.ts`: `environment: "node"`), so a component
// taking plain props is called directly as a function and its returned tree
// inspected — which is what proves these branches.
import type { AdminField as FieldDescriptor } from "@/lib/admin/kinds";
import styles from "./Admin.module.css";

export interface AdminFieldProps {
  readonly field: FieldDescriptor;
  /** The row's stored value, rendered when nothing has been typed. */
  readonly stored: string;
  /** What is typed into this field — `undefined` means untouched. */
  readonly draft?: string;
  /**
   * Whether an override field is set to inherit. Only meaningful when the
   * field overrides a setting; `undefined` means "as stored".
   */
  readonly inheriting: boolean;
  readonly onChange: (name: string, raw: string) => void;
  readonly onInheritChange: (name: string, inheriting: boolean) => void;
}

export function AdminField({
  field,
  stored,
  draft,
  inheriting,
  onChange,
  onInheritChange,
}: AdminFieldProps) {
  const value = draft ?? stored;
  const id = `admin-${field.name}`;

  // A read-only field is shown, never offered for editing: it is either the
  // entity's own identifier or a value the API reports rather than accepts.
  if (field.readOnly) {
    return (
      <li className={styles.field}>
        <span className={styles.label}>{field.label}</span>
        <p className={styles.help}>{field.help}</p>
        <span className={styles.readOnlyValue}>{stored === "" ? "—" : stored}</span>
      </li>
    );
  }

  return (
    <li className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {field.label}
      </label>
      <p className={styles.help}>{field.help}</p>

      {field.overridesSetting && (
        // Inheriting is offered as its own choice rather than as an empty
        // box, because for a list `[]` and `null` are different
        // instructions: an empty override says "look nowhere", inheriting
        // says "use the global value". See SCHEMA.md §17.7, §23.2.
        <label className={styles.help}>
          <input
            type="checkbox"
            checked={inheriting}
            aria-label={`Inherit ${field.overridesSetting}`}
            onChange={(event) => onInheritChange(field.name, event.target.checked)}
          />{" "}
          Inherit {field.overridesSetting}
        </label>
      )}

      {!inheriting && editor(field, id, value, onChange)}
    </li>
  );
}

function editor(
  field: FieldDescriptor,
  id: string,
  value: string,
  onChange: AdminFieldProps["onChange"],
) {
  switch (field.kind) {
    case "boolean":
      return (
        <select
          id={id}
          className={styles.select}
          value={value === "true" ? "true" : "false"}
          onChange={(event) => onChange(field.name, event.target.value)}
        >
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      );
    case "enum":
      return (
        <select
          id={id}
          className={styles.select}
          value={value}
          onChange={(event) => onChange(field.name, event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "string-list":
      return (
        <textarea
          id={id}
          className={styles.textarea}
          value={value}
          placeholder="One entry per line"
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      );
    case "json":
      return (
        <textarea
          id={id}
          className={styles.textarea}
          value={value}
          placeholder="A JSON value"
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      );
    default:
      return (
        <input
          id={id}
          className={styles.input}
          type="text"
          value={value}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      );
  }
}
