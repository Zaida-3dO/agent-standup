// The editor's presentational half — MILESTONES.md #87.
//
// Prop-driven and hook-free, matching `BudgetWindowsView` and
// `SettingsView`: the container fetches and holds the draft, and everything
// conditional lives here where it can be proved by calling this function
// and walking what comes back.
import type { BudgetWindow, CrossingProblem } from "@/lib/settings/budget-windows";
import type { BudgetLoadState } from "@/lib/budget-page/state";
import type { WindowDraft, WindowsDraft } from "@/lib/budget-page/edit";
import type { SaveState } from "./BudgetEditor";
import { WindowEditor } from "./WindowEditor";
import styles from "./Budget.module.css";

export interface BudgetEditorViewProps {
  readonly loadState: BudgetLoadState;
  readonly draft: WindowsDraft | null;
  readonly parsed: Readonly<Record<string, BudgetWindow | null>>;
  readonly problems: Readonly<Record<string, readonly CrossingProblem[]>>;
  readonly incompleteness: Readonly<Record<string, string | null>>;
  /** Why Save is disabled, or `null` when it is not. */
  readonly blockedReason: string | null;
  readonly saveState: SaveState;
  readonly newName: string;
  readonly addError: string | null;
  readonly onNewNameChange: (name: string) => void;
  readonly onAddWindow: () => void;
  readonly onChangeWindow: (name: string, next: WindowDraft) => void;
  readonly onRemoveWindow: (name: string) => void;
  readonly onSave: () => void;
  readonly onTakeTheirs: () => void;
}

export function BudgetEditorView(props: BudgetEditorViewProps) {
  const { loadState, draft, saveState } = props;

  if (loadState.status === "error") {
    return (
      <div className={styles.centered}>
        <p>{loadState.message}</p>
      </div>
    );
  }

  if (loadState.status === "loading" || draft === null) {
    return (
      <div className={styles.centered}>
        <p>Loading budget windows…</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Budget windows</h1>
      <p className={styles.subheading}>
        Each window carries four bands — free, selective, wind down, stop — separated by three
        boundaries, in percentage points of that window&rsquo;s budget. A boundary may hold still,
        move at a steady rate, or step through a schedule. Boundaries must never cross: the chart
        marks any moment where they do, and a window that collides cannot be saved.
      </p>

      {draft.names.length === 0 ? (
        <p className={styles.empty}>No budget windows are configured. Add one below to start.</p>
      ) : (
        draft.names.map((name) => {
          const windowDraft = draft.windows[name];
          if (windowDraft === undefined) return null;
          return (
            <WindowEditor
              key={name}
              name={name}
              draft={windowDraft}
              parsed={props.parsed[name] ?? null}
              problems={props.problems[name] ?? []}
              incompleteness={props.incompleteness[name] ?? null}
              onChange={(next) => props.onChangeWindow(name, next)}
              onRemove={() => props.onRemoveWindow(name)}
            />
          );
        })
      )}

      <section className={styles.addWindow}>
        <label className={styles.fieldRow} htmlFor="budget-new-window">
          <span className={styles.fieldLabel}>New window name</span>
          <input
            id="budget-new-window"
            className={styles.input}
            type="text"
            value={props.newName}
            onChange={(event) => props.onNewNameChange(event.target.value)}
          />
        </label>
        <button type="button" className={styles.secondaryButton} onClick={props.onAddWindow}>
          Add window
        </button>
        {props.addError !== null && <p className={styles.fieldError}>{props.addError}</p>}
      </section>

      <div className={styles.saveBar}>
        <button
          type="button"
          className={styles.primaryButton}
          // Disabled on a collision as well as on an incomplete draft: the
          // schema would refuse the write anyway, and letting somebody press
          // Save to be told what the page is already showing them is a round
          // trip that teaches nothing.
          disabled={props.blockedReason !== null || saveState.status === "saving"}
          onClick={props.onSave}
        >
          {saveState.status === "saving" ? "Saving…" : "Save all windows"}
        </button>

        {/* The reason sits beside the button rather than in a tooltip: a
            disabled control whose reason is hidden is the thing that sends
            somebody back to editing raw JSON. */}
        {props.blockedReason !== null && (
          <span className={styles.saveBlocked}>{props.blockedReason}</span>
        )}
        {saveState.status === "saved" && <span className={styles.saveOk}>Saved.</span>}
        {saveState.status === "error" && (
          <span className={styles.saveError}>{saveState.message}</span>
        )}
      </div>

      {saveState.status === "conflict" && (
        <div className={styles.conflict} role="alert">
          <p className={styles.conflictTitle}>Not saved — somebody else changed this first</p>
          <p>{saveState.message}</p>
          <button type="button" className={styles.secondaryButton} onClick={props.onTakeTheirs}>
            Discard my changes and load theirs
          </button>
        </div>
      )}
    </div>
  );
}
