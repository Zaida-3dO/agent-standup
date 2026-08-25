// The bar that appears when rows are selected — T6-E's affordance.
//
// **Hook-free and prop-driven**, the same way `ListView.tsx` and
// `BoardView.tsx` are, and for the same reason: with `environment: "node"`
// and no DOM, a component that takes plain props can be called directly as
// a function and its returned tree inspected, which is what actually proves
// these branches. `ListViewContainer.tsx` holds the state and hands this
// component its props.
//
// **It renders nothing when nothing is selected.** Not a hidden bar, not a
// disabled one — nothing in the tree at all. A permanently-present bar with
// greyed-out buttons is an invitation to click something that cannot work,
// and it costs vertical space on the one layout that exists because
// vertical space is scarce.
//
// ── What the actions are, and why these ────────────────────────────────
//
// The row asks for "bulk priority, area, state and cancel". This ships the
// **state** moves and **cancel**, and does not ship priority or area — see
// the note in `ListViewContainer`'s header for that decision and what it
// would take to add them. The three state targets are the same three the
// kanban's columns are reachable by (`TARGET_STATE`), so a bulk cannot
// reach a state a drag cannot: keeping the two vocabularies identical is
// what stops the bulk becoming a back door into states whose guards need
// fields nobody was asked for.
//
// **Cancel is the destructive-ish one**, and it is treated differently: it
// is styled as a danger action and it asks first. Everything else here is
// one click, because everything else is a move a reader can see and undo.
import type { ItemStateValue } from "@/lib/service/state-machine";
import styles from "./BulkActionBar.module.css";

/** One action the bar offers. */
export interface BulkAction {
  /** The state this moves the selection to. */
  readonly to: ItemStateValue;
  /** What the button says. */
  readonly label: string;
  /**
   * Whether this needs confirming before it runs.
   *
   * True for `cancelled`: it is the one action here that reads as ending
   * work rather than moving it, and applying it to twelve rows by a
   * mis-click is the mistake this bar could most plausibly cause. Undo
   * covers it — but a confirm is what stops the reader needing the undo,
   * and the two are not substitutes for each other at twelve rows.
   */
  readonly confirm?: boolean;
}

/**
 * The actions offered, in order.
 *
 * Exported so the container and its tests name the same list rather than
 * two lists that could drift — a bar offering an action the container
 * cannot run, or the reverse, is the defect this shape removes.
 */
export const BULK_ACTIONS: readonly BulkAction[] = [
  { to: "on_deck", label: "To backlog" },
  { to: "executing", label: "Start" },
  { to: "merged", label: "Complete" },
  { to: "cancelled", label: "Cancel", confirm: true },
];

export interface BulkActionBarProps {
  /** How many rows are selected. Zero renders nothing. */
  readonly count: number;
  /** Runs an action against the selection. */
  readonly onAction: (action: BulkAction) => void;
  readonly onClear: () => void;
  /**
   * The bulk in flight, if one is — `{ done, total }`.
   *
   * Present rather than a bare boolean because a bulk is sequential and a
   * reader watching six items move deserves to see which one it is on. It
   * is also what makes a slow bulk distinguishable from a hung one.
   */
  readonly progress?: { readonly done: number; readonly total: number } | null;
  /**
   * What the last bulk did, once it has finished — the honest report.
   *
   * Rendered in `role="status"` so it is announced rather than only shown.
   * A bulk's outcome is the one thing here a reader cannot get by looking
   * at the list, because a refused row looks exactly like a row that was
   * never selected.
   */
  readonly report?: BulkReport | null;
}

/** The finished bulk's outcome, as the bar shows it. */
export interface BulkReport {
  /** The leading sentence, from `describeBulkOutcome`. */
  readonly message: string;
  /**
   * The refused rows, named. Empty on a clean bulk.
   *
   * Listed individually rather than counted, because "2 refused" over a
   * 60-row list leaves the reader hunting. The state each one is actually
   * in is included when the server said so — that is what makes the
   * refusal checkable against the row in front of them.
   */
  readonly refused: readonly { readonly title: string; readonly detail: string }[];
}

export function BulkActionBar({ count, onAction, onClear, progress, report }: BulkActionBarProps) {
  // A finished report outlives the selection it came from — the container
  // clears the selection when a bulk succeeds, and the report is the only
  // remaining evidence of what happened, so it must survive `count === 0`.
  if (count === 0 && !report) return null;

  const running = progress != null;

  return (
    <div
      className={styles.bar}
      // `region` rather than `toolbar`: it holds a status message as well
      // as controls, and `toolbar` promises arrow-key navigation between
      // its children that this does not implement. Claiming a role whose
      // keyboard contract is not honoured is worse for a screen-reader user
      // than claiming none.
      role="region"
      aria-label="Bulk actions"
      data-testid="bulk-action-bar"
    >
      {count > 0 && (
        <>
          <span className={styles.count} data-testid="bulk-count">
            {/* Agreeing the noun, because the single-row selection is the
                one a reader hits first. */}
            {count === 1 ? "1 selected" : `${count} selected`}
          </span>
          <div className={styles.actions}>
            {BULK_ACTIONS.map((action) => (
              <button
                key={action.to}
                type="button"
                className={action.confirm ? styles.danger : styles.action}
                onClick={() => onAction(action)}
                // Disabled only while a bulk is actually running — a second
                // bulk fired into the first would interleave two sequences
                // of writes and produce one undo covering neither.
                disabled={running}
                data-testid={`bulk-${action.to}`}
              >
                {action.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.clear}
            onClick={onClear}
            disabled={running}
            data-testid="bulk-clear"
          >
            Clear
          </button>
        </>
      )}

      {/* **One live region for both the progress and the report**, so a
          screen reader hears a single running commentary rather than two
          that interrupt each other. `polite` because neither is urgent
          enough to cut off what is being read. */}
      <div className={styles.status} role="status" aria-live="polite">
        {running && (
          <span data-testid="bulk-progress">
            Moving {progress.done} of {progress.total}…
          </span>
        )}
        {!running && report && (
          <span data-testid="bulk-report">
            {report.message}
            {report.refused.length > 0 && (
              <ul className={styles.refusals} data-testid="bulk-refusals">
                {report.refused.map((row) => (
                  <li key={row.title + row.detail}>
                    <span className={styles.refusedTitle}>{row.title}</span>
                    <span className={styles.refusedDetail}>{row.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
