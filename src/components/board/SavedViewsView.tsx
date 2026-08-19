// Saved views, as the board renders them — MILESTONES.md #75.
//
// A row of chips for the views that exist, plus the name box that makes a
// new one. It sits directly under the filter bar rather than in a menu,
// because naming the board you are looking at and choosing a board you named
// earlier are the same act from the reader's side, and separating them makes
// the second one hard to find.
//
// The sidebar renders the same views as links (`SavedViewLinks`), which is
// the "pin to the sidebar" half. That component takes hrefs and nothing
// else, so a view is reachable from every screen without the sidebar knowing
// what a filter is.
//
// Hook-free and prop-driven; see `BoardFilterBarView.tsx`'s header.
import { Bookmark, X } from "lucide-react";
import { boardHref, parseBoardQuery } from "@/lib/board/filters";
import { type SavedView } from "@/lib/board/saved-views";
import styles from "./BoardFilterBar.module.css";

export interface SavedViewsViewProps {
  readonly views: readonly SavedView[];
  /** The board's current query string, so the chip matching it can mark itself active. */
  readonly currentQuery: string;
  /** Applies a view — the container navigates to its query. */
  readonly onApply: (view: SavedView) => void;
  readonly onDelete: (name: string) => void;
  /** What the name box shows. Held by the container so this stays hook-free. */
  readonly nameDraft: string;
  readonly onNameDraftChange: (value: string) => void;
  readonly onSave: () => void;
  /**
   * Why saving is not possible right now, or `null`. Rendered as a sentence
   * beside the control rather than expressed as a disabled button alone: a
   * control that is inert with no reason given is one a reader clicks twice
   * and then reports as broken.
   */
  readonly saveProblem: string | null;
}

export function SavedViewsView({
  views,
  currentQuery,
  onApply,
  onDelete,
  nameDraft,
  onNameDraftChange,
  onSave,
  saveProblem,
}: SavedViewsViewProps) {
  return (
    <div className={styles.views}>
      {views.map((view) => {
        const active = view.query === currentQuery;
        return (
          // A `<span>` wrapper rather than nesting the delete control inside
          // the apply button: a button inside a button is invalid HTML and
          // browsers resolve it by dropping one of them, so the delete would
          // silently stop working in some of them and not others.
          <span key={view.name} className={styles.viewChip} data-active={active ? "true" : "false"}>
            <button
              type="button"
              className={styles.viewChip}
              onClick={() => onApply(view)}
              // `aria-current` rather than the visual accent alone — the
              // accent is a border colour, which is not available to a
              // screen reader and is the thing WCAG 1.4.1 is about.
              aria-current={active ? "true" : undefined}
              title={boardHref(parseBoardQuery(view.query))}
            >
              <Bookmark size={11} aria-hidden="true" />
              <span>{view.name}</span>
            </button>
            <button
              type="button"
              className={styles.viewDelete}
              onClick={() => onDelete(view.name)}
              aria-label={`Delete the saved view "${view.name}"`}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        );
      })}

      <input
        type="text"
        className={styles.viewName}
        value={nameDraft}
        onChange={(event) => onNameDraftChange(event.target.value)}
        placeholder="Name this view"
        aria-label="Name for a new saved view"
      />
      <button
        type="button"
        className={styles.clear}
        onClick={onSave}
        disabled={saveProblem !== null}
        aria-label="Save the current filters and sort as a view"
      >
        Save view
      </button>
      {saveProblem !== null && (
        <span className={styles.viewHint} role="status">
          {saveProblem}
        </span>
      )}
    </div>
  );
}
