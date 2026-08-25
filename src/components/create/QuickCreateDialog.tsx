"use client";

// Quick create — T18's three-field dialog.
//
// The row's starkest complaint is that **there is no way to create an item
// from the UI at all**: every item in the product was minted by an agent,
// and `POST /api/items`, `/projects`, `/tasks` and `/subtasks` all existed
// with no form on any of them. This is that form.
//
// **Three fields — title, area, priority** — plus the kind being minted and,
// when the kind needs one, its parent. The kind is not a fourth question in
// disguise: it defaults to `task`, which is what a person capturing a
// thought almost always means, and a task with no project named files itself
// in the inbox. So the shortest path really is title, area, go.
//
// ── Hook-free and prop-driven, like every other view in this split ───────
//
// This repo's harness runs `environment: "node"` with no DOM
// (`vitest.config.ts`), so a component taking plain props is called directly
// as a function and its returned tree inspected
// (`tests/helpers/react-element.ts`). All the in-progress state — the draft,
// the pending flag, the error — lives in the thin container that renders
// this. Introducing `useState` here would make the component untestable in
// this harness, which is why the whole `src/components/` tree is written
// this way.
//
// ── What is deliberately NOT here ────────────────────────────────────────
//
// The `⌘K` palette and the `+` button that will open this both live in
// `AppShell`, which is another T18 piece's territory and is not touched.
// This component is complete and mountable on its own: a caller supplies
// `draft`, `onChange`, `onSubmit` and `onCancel`, and it renders.
import { CREATE_KINDS, CREATE_KIND_ORDER, CREATE_PRIORITIES } from "@/lib/create/kinds";
import type { CreateKind, CreatePriority } from "@/lib/create/kinds";
import { INBOX_PROJECT_ID } from "@/lib/create/inbox";
import {
  blockingIssues,
  isPristine,
  titlePreview,
  type QuickCreateDraft,
} from "@/lib/create/state";
import styles from "./QuickCreateDialog.module.css";

export interface QuickCreateDialogProps {
  readonly draft: QuickCreateDraft;
  /** Whether a create is in flight — disables submit and names the state. */
  readonly submitting: boolean;
  /** A failed create's message, shown as it came from the service. */
  readonly errorMessage: string | null;
  readonly onChange: (draft: QuickCreateDraft) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  /**
   * The areas that already exist, offered as suggestions while typing
   * (row 6b2fb637).
   *
   * **A `<datalist>`, deliberately — not a `<select>`.** Areas are free text
   * with find-or-create, and that is a property worth keeping: a person can
   * name a new area without an admin step, which SCHEMA.md §23.1 argues for
   * explicitly ("blocking that is friction on the most common operation in
   * the system"). A closed vocabulary would fix the duplicate problem by
   * removing the feature.
   *
   * What was missing is that nothing surfaced an existing near-match at the
   * moment of typing, so `website` got created beside `web` silently — and a
   * split vocabulary silently splits the board, projects, list and search
   * filters that all share `areaFilterCondition`. A datalist is the smallest
   * thing that fixes that: typing `web` shows `web` already exists, while
   * still accepting a genuinely new name.
   *
   * Optional and defaulted to empty, so a caller that has not loaded them
   * (or whose load failed) renders exactly what it rendered before rather
   * than breaking the create path over a suggestion list.
   */
  readonly areaSuggestions?: readonly string[];
}

/** The id each field's label and error are tied together by. */
const FIELD_IDS = {
  kind: "quick-create-kind",
  title: "quick-create-title",
  area: "quick-create-area",
  areaList: "quick-create-area-suggestions",
  priority: "quick-create-priority",
  parent: "quick-create-parent",
} as const;

/** How each priority reads to a person — the letter alone is not self-explaining. */
const PRIORITY_LABELS: Readonly<Record<CreatePriority, string>> = {
  P0: "P0 — drop everything",
  P1: "P1 — this week",
  P2: "P2 — normal",
  P3: "P3 — someday",
};

export function QuickCreateDialog({
  draft,
  submitting,
  errorMessage,
  onChange,
  onSubmit,
  onCancel,
  areaSuggestions = [],
}: QuickCreateDialogProps) {
  const spec = CREATE_KINDS[draft.kind];
  const issues = blockingIssues(draft);
  const preview = titlePreview(draft.title);
  // Submit is disabled on a blocking issue, never on title advice. A finding
  // from `item-title.ts` is a matter of judgement — the module advises rather
  // than refuses precisely because "reads well to a person" has no predicate
  // that is right about every string — so the person keeps the last word.
  const blocked = issues.length > 0;
  // **Issues are shown once the form has been engaged, never on arrival.**
  // A dialog that opens already saying "A title is required." is scolding
  // the person for not having typed yet. `blocked` is deliberately NOT
  // gated on this: submit stays disabled on a pristine draft, the form just
  // does not shout about why until there is something to respond to.
  const pristine = isPristine(draft);
  const issueFor = (field: "title" | "area" | "parent") =>
    (pristine ? null : issues.find((issue) => issue.field === field)) ?? null;
  const titleIssue = issueFor("title");
  const areaIssue = issueFor("area");
  const parentIssue = issueFor("parent");

  return (
    <div
      className={styles.backdrop}
      // Escape closes from anywhere inside the dialog, including from a
      // field, which is why it is bound here rather than on the form.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Create an item">
        <form
          className={styles.form}
          onSubmit={(event) => {
            // The dialog lives inside an app shell, not on a page of its
            // own, so a real submit would navigate away from it.
            event.preventDefault();
            if (blocked || submitting) return;
            onSubmit();
          }}
        >
          <h2 className={styles.heading}>Create an item</h2>

          <label className={styles.label} htmlFor={FIELD_IDS.kind}>
            Kind
          </label>
          <select
            id={FIELD_IDS.kind}
            className={styles.select}
            value={draft.kind}
            onChange={(event) =>
              onChange({ ...draft, kind: event.target.value as CreateKind, parent: "" })
            }
          >
            {CREATE_KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {CREATE_KINDS[kind].kind}
              </option>
            ))}
          </select>

          <label className={styles.label} htmlFor={FIELD_IDS.title}>
            Title
          </label>
          <input
            id={FIELD_IDS.title}
            className={styles.input}
            value={draft.title}
            // The first field of a freshly-opened dialog. Focus starts where
            // the typing does, so the dialog is usable without reaching for
            // a mouse — the row asks for correct focus management, and this
            // is the half of it a hook-free component can own.
            autoFocus
            placeholder="What is the work?"
            aria-invalid={titleIssue !== null}
            aria-describedby={`${FIELD_IDS.title}-preview`}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />

          {/* The live card-title preview — the row calls this "the cheapest
              possible moment to prevent the next 200 agent-shaped titles".
              It shows the NORMALISED title (trimmed, em dashes folded), so
              it previews what will actually be stored rather than echoing
              the raw input. `aria-live` is polite so a screen reader hears
              the advice without being interrupted mid-word. */}
          <div id={`${FIELD_IDS.title}-preview`} className={styles.preview} aria-live="polite">
            {preview.text === null ? (
              <p className={styles.previewEmpty}>The card title will appear here as you type.</p>
            ) : (
              <>
                <p className={styles.previewLabel}>On the board this reads:</p>
                <p className={styles.previewCard}>{preview.text}</p>
                {preview.findings.map((finding) => (
                  <p key={finding.rule} className={styles.previewAdvice} data-rule={finding.rule}>
                    {finding.message}
                  </p>
                ))}
              </>
            )}
          </div>

          {titleIssue !== null && (
            <p className={styles.fieldError} role="alert">
              {titleIssue.message}
            </p>
          )}

          <label className={styles.label} htmlFor={FIELD_IDS.area}>
            Area
          </label>
          <input
            id={FIELD_IDS.area}
            className={styles.input}
            value={draft.area}
            placeholder="web, api, infra…"
            aria-invalid={areaIssue !== null}
            // Suggests without constraining: a datalist offers what exists
            // and still accepts anything typed, which is what keeps
            // find-or-create working. See `areaSuggestions`.
            list={areaSuggestions.length > 0 ? FIELD_IDS.areaList : undefined}
            onChange={(event) => onChange({ ...draft, area: event.target.value })}
          />
          {/* Rendered only when there is something to suggest — an empty
              datalist is a dropdown arrow that opens onto nothing. */}
          {areaSuggestions.length > 0 && (
            <datalist id={FIELD_IDS.areaList} data-region="area-suggestions">
              {areaSuggestions.map((area) => (
                <option key={area} value={area} />
              ))}
            </datalist>
          )}
          {areaIssue !== null && (
            <p className={styles.fieldError} role="alert">
              {areaIssue.message}
            </p>
          )}

          <label className={styles.label} htmlFor={FIELD_IDS.priority}>
            Priority
          </label>
          <select
            id={FIELD_IDS.priority}
            className={styles.select}
            value={draft.priority}
            onChange={(event) =>
              onChange({ ...draft, priority: event.target.value as CreatePriority })
            }
          >
            {CREATE_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>

          {/* Only the kinds that have a parent ask for one, and each asks
              using its own word — "Project" for a task, "Task" for a
              subtask — because that is the question the person can answer.
              A project renders no parent field at all: its schema is
              `.strict()` and refuses a parent key outright. */}
          {spec.parentField !== null && (
            <>
              <label className={styles.label} htmlFor={FIELD_IDS.parent}>
                {spec.parentLabel}
              </label>
              <input
                id={FIELD_IDS.parent}
                className={styles.input}
                value={draft.parent}
                placeholder={
                  spec.parentFallback === INBOX_PROJECT_ID
                    ? `Project id — leave empty to file in the ${INBOX_PROJECT_ID}`
                    : "Task id"
                }
                aria-invalid={parentIssue !== null}
                onChange={(event) => onChange({ ...draft, parent: event.target.value })}
              />
              {/* Stated up front, not discovered. An empty project field is
                  a legal, named choice — the `"inbox"` sentinel — and a
                  person who does not know that will go and create a project
                  they did not need. */}
              {spec.parentFallback === INBOX_PROJECT_ID && parentIssue === null && (
                <p className={styles.hint}>
                  Leave this empty and the task is filed in the inbox project.
                </p>
              )}
              {parentIssue !== null && (
                <p className={styles.fieldError} role="alert">
                  {parentIssue.message}
                </p>
              )}
            </>
          )}

          {errorMessage !== null && (
            <p className={styles.error} role="alert">
              {errorMessage}
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.submitButton}
              disabled={blocked || submitting}
              // A disabled button says nothing about *why*. The reason is
              // the first unmet requirement, which is also the field the
              // person's attention should go to.
              title={blocked ? issues[0]?.message : undefined}
            >
              {submitting ? "Creating…" : `Create ${spec.kind}`}
            </button>
            {/* Names the outcome rather than borrowing "Cancel" — the house
                convention set in `ArchiveAction`'s header. Nothing has been
                minted yet, so the honest description of dismissing this form
                is that the draft is discarded. */}
            <button type="button" className={styles.cancelButton} onClick={onCancel}>
              Discard draft
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
