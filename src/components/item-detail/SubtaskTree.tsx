// The subtask tree — MILESTONES.md #72's first piece.
//
// Hook-free and prop-driven so a test can call it as a function and inspect
// the element tree it returns (`tests/helpers/react-element.ts`); see
// `TopBar.tsx`'s header for the full reasoning.
//
// The tree arrives flat with a `depth` per node and is indented by that
// depth rather than re-nested into lists. Re-nesting would buy nothing the
// indent does not already show and would need a recursive component, which
// the direct-call test technique cannot walk as easily.
import type { DetailSubtask } from "@/lib/item-detail/types";
import { humanState, subtaskProgress } from "@/lib/item-detail/view";
import styles from "./ItemDetail.module.css";

export interface SubtaskTreeProps {
  readonly subtasks: readonly DetailSubtask[];
}

/** The states that render struck-through — the completed column's (SCHEMA.md §1.1). */
const DONE_STATES: ReadonlySet<string> = new Set([
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

export function SubtaskTree({ subtasks }: SubtaskTreeProps) {
  const progress = subtaskProgress(subtasks);

  return (
    <section className={styles.section} aria-label="Subtasks">
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Subtasks</h2>
        {progress.total > 0 && (
          <span className={styles.progress} data-progress={`${progress.done}/${progress.total}`}>
            {progress.done} of {progress.total} done
          </span>
        )}
      </header>
      {subtasks.length === 0 ? (
        <p className={styles.empty}>No subtasks.</p>
      ) : (
        <ul className={styles.tree}>
          {subtasks.map((subtask) => {
            const done = DONE_STATES.has(subtask.state);
            return (
              <li
                key={subtask.id}
                className={`${styles.treeNode} ${done ? styles.treeDone : ""}`.trim()}
                data-depth={subtask.depth}
                data-kind={subtask.kind}
                // The indent IS the nesting, so it is driven by the
                // server's depth rather than by a wrapper element per
                // level.
                style={{ paddingLeft: `${0.5 + (subtask.depth - 1) * 1.25}rem` }}
              >
                <span className={styles.priority} data-priority={subtask.priority}>
                  {subtask.priority}
                </span>
                <span className={styles.treeTitle}>{subtask.title}</span>
                {/* A project's own state is a creation leftover
                    (DECISIONS.md §13c), so it shows its kind rather than a
                    state that would read as fact. `column` is null for a
                    project for exactly that reason — the server said so;
                    this does not re-derive it. */}
                {subtask.column === null ? (
                  <span className={styles.kind}>project</span>
                ) : (
                  <span className={styles.state} data-state={subtask.state}>
                    {humanState(subtask.state)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
