// The presentational half of MILESTONES.md #87: the load/error/loaded
// branching, and one card per window.
//
// Prop-driven and hook-free — same reasoning as `SettingsView.tsx`. The
// container (`BudgetWindows.tsx`) fetches and holds the scrubber positions;
// everything conditional lives here, where it can be proved by calling this
// function and walking what comes back.
import type { CrossingProblem } from "@/lib/settings/budget-windows";
import type { BudgetLoadState } from "@/lib/budget-page/state";
import { WindowCard } from "./WindowCard";
import styles from "./Budget.module.css";

export interface BudgetWindowsViewProps {
  readonly loadState: BudgetLoadState;
  /** Per-window crossing problems, keyed by window name. */
  readonly problems: Readonly<Record<string, readonly CrossingProblem[]>>;
  /** Per-window scrubber position, in hours. Absent means the window's start. */
  readonly scrubbed: Readonly<Record<string, number>>;
  readonly onScrub: (name: string, atHours: number) => void;
}

export function BudgetWindowsView(props: BudgetWindowsViewProps) {
  const { loadState } = props;

  if (loadState.status === "error") {
    return (
      <div className={styles.centered}>
        <p>{loadState.message}</p>
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className={styles.centered}>
        <p>Loading budget windows…</p>
      </div>
    );
  }

  const names = Object.keys(loadState.windows).sort();

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Budget windows</h1>
      <p className={styles.subheading}>
        Each window carries four bands — free, selective, wind down, stop — separated by three
        boundaries, in percentage points of that window&rsquo;s budget. A boundary may hold still,
        move at a steady rate, or step through a schedule; the chart is the boundaries alone until
        usage readings exist to plot a position against.
      </p>

      {/* An installation with no windows configured is a valid state, not a
          failure — every setting has a default and this one's is empty — so
          it is said plainly rather than rendered as an error. */}
      {names.length === 0 ? (
        <p className={styles.empty}>
          No budget windows are configured. Add them from the settings page under Budget.
        </p>
      ) : (
        names.map((name) => {
          const window = loadState.windows[name];
          if (window === undefined) return null;
          return (
            <WindowCard
              key={name}
              name={name}
              window={window}
              problems={props.problems[name] ?? []}
              atHours={props.scrubbed[name] ?? 0}
              onScrub={props.onScrub}
            />
          );
        })
      )}
    </div>
  );
}
