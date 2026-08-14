// One row on the administration surface — MILESTONES.md #93.
//
// Collapsed it is a summary line; expanded it is the editor. Which fields
// exist, and how each is drawn, comes entirely from the kind descriptor, so
// this component knows nothing about repositories or accounts specifically.
//
// Hook-free and prop-driven — see `AdminField.tsx`'s header.
import type { AdminKind } from "@/lib/admin/kinds";
import { editableFields } from "@/lib/admin/kinds";
import { isArchived, isOverridden, overrideLabel, type AdminRow as Row } from "@/lib/admin/state";
import { toCell, toInput } from "@/lib/admin/values";
import { AdminField } from "./AdminField";
import styles from "./Admin.module.css";

export interface AdminRowProps {
  readonly kind: AdminKind;
  readonly row: Row;
  readonly expanded: boolean;
  readonly drafts: Readonly<Record<string, string>>;
  /** Which override fields are set to inherit, by field name. */
  readonly inheriting: Readonly<Record<string, boolean>>;
  readonly error?: string;
  readonly onToggle: (id: string) => void;
  readonly onDraftChange: (id: string, name: string, raw: string) => void;
  readonly onInheritChange: (id: string, name: string, inheriting: boolean) => void;
  readonly onSave: (id: string) => void;
  readonly onArchive: (id: string, archived: boolean) => void;
}

export function AdminRow(props: AdminRowProps) {
  const { kind, row } = props;
  const id = String(row[kind.idField] ?? "");
  const archived = isArchived(row);
  const overrideFields = kind.fields.filter((field) => field.overridesSetting);

  return (
    <li className={archived ? `${styles.row} ${styles.rowArchived}` : styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.rowId}>{id}</span>
        {archived && <span className={`${styles.badge} ${styles.badgeArchived}`}>Archived</span>}
        {overrideFields.map((field) => (
          // SCHEMA.md §23.2: "Each row shows whether it carries an override
          // or is inheriting the setting."
          <span
            key={field.name}
            className={
              isOverridden(row, field) ? `${styles.badge} ${styles.badgeOverride}` : styles.badge
            }
          >
            {field.label}: {overrideLabel(row, field)}
          </span>
        ))}
      </div>

      <div className={styles.cells}>
        {kind.fields
          .filter((field) => field.name !== kind.idField)
          .map((field) => (
            <span key={field.name}>
              <span className={styles.cellLabel}>{field.label}: </span>
              <span className={styles.cellValue}>{toCell(row[field.name], field)}</span>
            </span>
          ))}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={() => props.onToggle(id)}>
          {props.expanded ? "Close" : "Edit"}
        </button>
        {kind.canArchive && (
          <button
            type="button"
            className={`${styles.button} ${styles.buttonWarn}`}
            onClick={() => props.onArchive(id, !archived)}
          >
            {archived ? "Un-archive" : "Archive"}
          </button>
        )}
      </div>

      {props.expanded && (
        <>
          <ul className={styles.fields}>
            {editableFields(kind).map((field) => (
              <AdminField
                key={field.name}
                field={field}
                stored={toInput(row[field.name], field)}
                draft={props.drafts[field.name]}
                inheriting={
                  // An untouched override field starts in whichever state
                  // the row is actually in, so opening the editor and saving
                  // without changing anything cannot flip an override off.
                  props.inheriting[field.name] ??
                  (field.overridesSetting ? !isOverridden(row, field) : false)
                }
                onChange={(name, raw) => props.onDraftChange(id, name, raw)}
                onInheritChange={(name, value) => props.onInheritChange(id, name, value)}
              />
            ))}
          </ul>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => props.onSave(id)}
            >
              Save
            </button>
          </div>
        </>
      )}

      {props.error && <p className={styles.error}>{props.error}</p>}
    </li>
  );
}
