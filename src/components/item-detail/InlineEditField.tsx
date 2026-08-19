// One inline-editable field on the item header — title, headline, priority
// or area. M10 T10: nothing else in the app can correct a stored field, so
// a badly-titled item stays badly titled unless this exists.
//
// Hook-free and prop-driven, matching every other detail-tab component —
// see `SubtaskTree.tsx`'s header for why. The edit/view toggle, the draft
// string and the in-flight/error state all live in `ItemDetailContainer`;
// this renders whichever of the two modes the caller says it is in and
// calls back on every keystroke, save and cancel.
//
// **Text input or a `<select>`, chosen by the caller, not inferred here.**
// Priority is a closed four-value vocabulary (`PRIORITIES`) and a free-text
// box for it would let a reader type `P9` and find out only from a failed
// PATCH; a `<select>` cannot express a value that is not one of the four.
// Title, headline and area stay free text — area is open-ended (an item's
// area is whichever string the caller used at creation, not a fixed list
// this component can enumerate) and a select would need to fetch one.
import type { KeyboardEvent } from "react";
import type { Priority } from "@/lib/design/tokens";
import { PRIORITIES } from "@/lib/design/tokens";
import styles from "./ItemDetail.module.css";

export type InlineEditKind = "text" | "priority";

export interface InlineEditFieldProps {
  /** What a screen reader and the edit button's label call this field. */
  readonly label: string;
  /** The stored value, shown in view mode. Null renders the empty-value placeholder rather than the literal string "null". */
  readonly value: string | null;
  readonly kind: InlineEditKind;
  readonly editing: boolean;
  /** The in-progress edit's text — only read while `editing` is true. */
  readonly draft: string;
  readonly onDraftChange?: (draft: string) => void;
  readonly onStartEdit?: () => void;
  readonly onSave?: () => void;
  readonly onCancel?: () => void;
  /** True while a save is in flight — disables the controls so a second click cannot fire a second PATCH. */
  readonly saving?: boolean;
  /** The service's own refusal message, shown alongside the field so the draft stays visible. */
  readonly error?: string | null;
  /**
   * Advisory text shown live under a title draft (MILESTONES.md #131's
   * convention) — never blocks Save, matching the convention's own rule
   * that it advises rather than refuses.
   */
  readonly advice?: string | null;
}

function placeholderFor(kind: InlineEditKind, label: string): string {
  return kind === "priority" ? `No ${label.toLowerCase()}` : `No ${label.toLowerCase()} set`;
}

export function InlineEditField({
  label,
  value,
  kind,
  editing,
  draft,
  onDraftChange,
  onStartEdit,
  onSave,
  onCancel,
  saving = false,
  error = null,
  advice = null,
}: InlineEditFieldProps) {
  if (!editing) {
    return (
      <span className={styles.inlineEditView} data-field={label.toLowerCase()}>
        <span className={value === null || value === "" ? styles.empty : undefined}>
          {value === null || value === "" ? placeholderFor(kind, label) : value}
        </span>
        {onStartEdit && (
          <button
            type="button"
            className={styles.inlineEditButton}
            aria-label={`Edit ${label.toLowerCase()}`}
            onClick={onStartEdit}
          >
            Edit
          </button>
        )}
      </span>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter saves, Escape cancels — the two shortcuts a reader mid-edit in
    // a single-line field expects; Enter does not insert a newline here
    // because none of the four fields this component serves is
    // multi-line.
    if (event.key === "Enter") {
      event.preventDefault();
      onSave?.();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
    }
  };

  return (
    <span className={styles.inlineEditForm} data-field={label.toLowerCase()} data-editing="true">
      {kind === "priority" ? (
        <select
          className={styles.inlineEditSelect}
          aria-label={label}
          value={draft}
          disabled={saving}
          onChange={onDraftChange ? (event) => onDraftChange(event.target.value) : undefined}
        >
          {PRIORITIES.map((priority: Priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          className={styles.inlineEditInput}
          aria-label={label}
          value={draft}
          disabled={saving}
          onChange={onDraftChange ? (event) => onDraftChange(event.target.value) : undefined}
          onKeyDown={onKeyDown}
        />
      )}
      <button type="button" className={styles.inlineEditButton} disabled={saving} onClick={onSave}>
        Save
      </button>
      <button
        type="button"
        className={styles.inlineEditButton}
        disabled={saving}
        onClick={onCancel}
      >
        Cancel
      </button>
      {advice !== null && <span className={styles.inlineEditAdvice}>{advice}</span>}
      {error !== null && (
        <span className={styles.inlineEditError} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
