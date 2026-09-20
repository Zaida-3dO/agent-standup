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
import { Pencil } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { Priority } from "@/lib/design/tokens";
import { PRIORITIES } from "@/lib/design/tokens";
import type { EditableField, EditingField } from "@/lib/item-detail/edit-state";
import { AutoFocus } from "./AutoFocus";
import { EditTrigger } from "./EditTrigger";
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
  /**
   * Which field this one is, for the focus-return signal below. Only the
   * two editors that own BOTH branches (Headline, and any future one) pass
   * it; Title, Priority and Area render their own triggers in
   * `ItemDetailView`/`StatusBlock` and handle their own return there.
   */
  readonly field?: EditableField;
  /** The field whose edit just ended — see `ItemEditProps.returnFocusTo`. */
  readonly returnFocusTo?: EditingField;
  readonly onFocusReturned?: () => void;
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
  field,
  returnFocusTo,
  onFocusReturned,
}: InlineEditFieldProps) {
  if (!editing) {
    const isEmpty = value === null || value === "";
    const shown = isEmpty ? placeholderFor(kind, label) : value;

    // Not editable: plain text, with no control wrapped around it. A
    // button that does nothing is worse than no button.
    if (!onStartEdit) {
      return (
        <span className={styles.inlineEditView} data-field={label.toLowerCase()}>
          <span className={isEmpty ? styles.empty : undefined}>{shown}</span>
        </span>
      );
    }

    // ── The value IS the control ──────────────────────────────────────
    // A permanent `Edit` button beside every field is chrome competing
    // with the content it labels, and it scales badly: a header with four
    // editable fields grows four buttons that all say the same word. The
    // value is what the reader came for, so the value is what they act on.
    //
    // A real `<button>`, not a click handler on a span: that is what makes
    // it reachable by Tab, activated by BOTH Enter and Space, and
    // announced as something that can be operated. The affordance is drawn
    // on hover and on focus (never hover alone — see
    // docs/DESIGN-LANGUAGE.md §6), so a keyboard reader gets the same
    // signal a mouse reader does.
    //
    // The accessible name says what editing this will change, because the
    // value alone ("P2") does not say what it IS, and a screen-reader user
    // tabbing the header would otherwise hear a list of bare values.
    return (
      <span className={styles.inlineEditView} data-field={label.toLowerCase()}>
        <EditTrigger
          field={field ?? "title"}
          label={`${label}: ${isEmpty ? "empty" : value} — activate to edit`}
          onActivate={onStartEdit}
          variant="value"
          /* Only a caller that named its `field` can be matched against the
             return signal. One that did not is unambiguously not the field
             whose edit just ended, so it is passed nothing rather than
             being matched against a guessed name. */
          returnFocusTo={field === undefined ? null : returnFocusTo}
          onFocusReturned={onFocusReturned}
        >
          <span className={isEmpty ? styles.empty : undefined}>{shown}</span>
          {/* Decorative: the accessible name above already carries the
              affordance, so announcing a pencil as well would be the same
              fact twice. */}
          <Pencil className={styles.editableIcon} size={12} aria-hidden="true" />
        </EditTrigger>
      </span>
    );
  }

  // Attached to the `<select>` as well as the `<input>`. It was on the
  // text input alone, which left the Priority editor with no Escape at all:
  // its `<select>` had no key handler, so §6's "Escape cancels" was false
  // for that field even once focus reached it. One handler, both controls.
  //
  // Enter on a `<select>` is worth stating: the native behaviour submits
  // the enclosing form, and there is no form here, so nothing happened.
  // Saving on Enter is what the other three fields do and what §6 promises.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
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
        <AutoFocus>
          <select
            className={styles.inlineEditSelect}
            aria-label={label}
            value={draft}
            disabled={saving}
            onChange={onDraftChange ? (event) => onDraftChange(event.target.value) : undefined}
            onKeyDown={onKeyDown}
          >
            {PRIORITIES.map((priority: Priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </AutoFocus>
      ) : (
        <AutoFocus>
          <input
            type="text"
            className={styles.inlineEditInput}
            aria-label={label}
            value={draft}
            disabled={saving}
            onChange={onDraftChange ? (event) => onDraftChange(event.target.value) : undefined}
            onKeyDown={onKeyDown}
          />
        </AutoFocus>
      )}
      <button type="button" className={styles.inlineEditButton} disabled={saving} onClick={onSave}>
        Save
      </button>
      {/* "Discard edit", not "Cancel". This renders on the item detail page,
          the same view that carries "Cancel this work" — a recorded decision
          that work is not being done. Two controls a few hundred pixels
          apart, one of which throws away a half-typed title and the other of
          which stops the work, must not share a verb. See `ArchiveAction`'s
          header for the convention. */}
      <button
        type="button"
        className={styles.inlineEditButton}
        disabled={saving}
        onClick={onCancel}
      >
        Discard edit
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
