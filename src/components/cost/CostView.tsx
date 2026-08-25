// The presentational half of `/cost` (T19): the load/error/loaded branching,
// the grouping picker, and the honesty notices.
//
// Deliberately prop-driven and hook-free rather than a `useCost()` caller —
// same reasoning as `SinceLastVisitView.tsx` and `BoardView.tsx`: with
// `environment: "node"` and no DOM, a component taking plain props can be
// called directly as a function and its returned tree inspected, which is
// what actually proves these branches. `Cost.tsx` is the thin client
// container that fetches and hands this component its props.
//
// ── What this screen is not allowed to imply ────────────────────────────
//
// The task brief is explicit, and it shapes most of the markup below: "Be
// honest about sparsity. M7 rows #51–#54 are unbuilt, so `Run` rows are
// sparse. Design the screen; scope it to what is actually populated, and
// render an honest empty state where it is not. A cost dashboard that
// implies completeness it does not have is worse than no cost dashboard."
//
// So three things are always visible when they are true, rather than being
// details a reader could miss:
//
//   - **An unpriced figure renders as an em dash, never as $0.00.** `$0.00`
//     asserts the work was free; the dash says we have no rate for the model
//     that served it. `formatCost` is where that decision lives.
//   - **A partial total says so, beside the number.** Truncation and unpriced
//     runs are separate facts with separate remedies, so they are reported
//     separately rather than as one "incomplete" flag.
//   - **An empty result names the likely reason.** "No runs recorded yet" for
//     an unpopulated corpus is a different message from "no spend in this
//     window", and a reader who sees the wrong one draws the wrong
//     conclusion about whether the system is working.
import type { CostLoadState } from "@/lib/cost/state";
import { COST_GROUPINGS, COST_GROUPING_LABELS, type CostGrouping } from "@/lib/cost/types";
import {
  completenessOf,
  formatCost,
  formatTokens,
  labelForKey,
  shareOf,
  totalOf,
} from "@/lib/cost/view";
import styles from "./Cost.module.css";

/** The windows the screen offers, as days back. `null` is all of history. */
export const COST_WINDOWS: readonly { readonly label: string; readonly days: number | null }[] = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "All time", days: null },
];

export interface CostViewProps {
  readonly loadState: CostLoadState;
  readonly groupBy: CostGrouping;
  readonly windowDays: number | null;
  readonly onGroupByChange?: (groupBy: CostGrouping) => void;
  readonly onWindowChange?: (days: number | null) => void;
}

export function CostView({
  loadState,
  groupBy,
  windowDays,
  onGroupByChange,
  onWindowChange,
}: CostViewProps) {
  return (
    <section className={styles.panel} aria-label="Cost">
      <div className={styles.head}>
        <h1 className={styles.title}>Cost</h1>
        <p className={styles.subtitle}>
          Token spend, recomputed at current rates rather than summed from stored figures.
        </p>
      </div>

      <div className={styles.controls}>
        <div className={styles.controlGroup} role="group" aria-label="Group by">
          {COST_GROUPINGS.map((option) => (
            <button
              key={option}
              type="button"
              className={option === groupBy ? styles.chipActive : styles.chip}
              aria-pressed={option === groupBy}
              onClick={() => onGroupByChange?.(option)}
            >
              {COST_GROUPING_LABELS[option]}
            </button>
          ))}
        </div>
        <div className={styles.controlGroup} role="group" aria-label="Time window">
          {COST_WINDOWS.map((option) => (
            <button
              key={option.label}
              type="button"
              className={option.days === windowDays ? styles.chipActive : styles.chip}
              aria-pressed={option.days === windowDays}
              onClick={() => onWindowChange?.(option.days)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <CostBody loadState={loadState} groupBy={groupBy} />
    </section>
  );
}

function CostBody({
  loadState,
  groupBy,
}: {
  readonly loadState: CostLoadState;
  readonly groupBy: CostGrouping;
}) {
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
        <p>Loading costs…</p>
      </div>
    );
  }

  const { costs } = loadState;
  const total = totalOf(costs.groups);
  const completeness = completenessOf(costs);

  if (costs.groups.length === 0) {
    // Two genuinely different situations, and telling them apart is the
    // point. A reader who takes "the telemetry is not wired up yet" for "we
    // spent nothing this week" has been misled by the screen.
    return (
      <div className={styles.centered}>
        <p>
          No spend recorded in this window. Cost is derived from runs, which the tool-call ingest
          writes — a window with no runs shows nothing here.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className={styles.summary}>
        <div className={styles.summaryFigure}>
          <span className={styles.summaryLabel}>Total</span>
          <span className={styles.summaryValue}>{formatCost(total.cost)}</span>
        </div>
        <div className={styles.summaryFigure}>
          <span className={styles.summaryLabel}>Runs</span>
          <span className={styles.summaryValue}>{total.runs}</span>
        </div>
        <div className={styles.summaryFigure}>
          <span className={styles.summaryLabel}>Tool calls</span>
          <span className={styles.summaryValue}>{total.toolCalls}</span>
        </div>
        <div className={styles.summaryFigure}>
          <span className={styles.summaryLabel}>Input</span>
          <span className={styles.summaryValue}>{formatTokens(total.inputTokens)}</span>
        </div>
        <div className={styles.summaryFigure}>
          <span className={styles.summaryLabel}>Output</span>
          <span className={styles.summaryValue}>{formatTokens(total.outputTokens)}</span>
        </div>
      </div>

      {!completeness.complete && (
        <div className={styles.notice} role="note">
          <strong className={styles.noticeTitle}>This total is a floor, not a total.</strong>
          <ul className={styles.noticeList}>
            {completeness.truncated && (
              <li>
                More groups exist than were returned — the rows below are the most expensive ones
                only.
              </li>
            )}
            {completeness.unpricedRuns > 0 && (
              <li>
                {completeness.unpricedRuns} run{completeness.unpricedRuns === 1 ? "" : "s"} could
                not be priced and contribute no cost.
              </li>
            )}
            {completeness.unpricedModels.length > 0 && (
              <li>
                No rate configured for: {completeness.unpricedModels.join(", ")}. Set one in
                settings under <code>pricing.model_prices</code>.
              </li>
            )}
          </ul>
        </div>
      )}

      <table className={styles.table}>
        <caption className={styles.caption}>
          Spend by {COST_GROUPING_LABELS[groupBy].toLowerCase()}, most expensive first
        </caption>
        <thead>
          <tr>
            <th scope="col">{COST_GROUPING_LABELS[groupBy]}</th>
            <th scope="col" className={styles.numeric}>
              Cost
            </th>
            <th scope="col" className={styles.numeric}>
              Runs
            </th>
            <th scope="col" className={styles.numeric}>
              Calls
            </th>
            <th scope="col" className={styles.numeric}>
              Input
            </th>
            <th scope="col" className={styles.numeric}>
              Output
            </th>
          </tr>
        </thead>
        <tbody>
          {costs.groups.map((group) => (
            <tr key={group.key ?? " null"}>
              <th scope="row" className={styles.keyCell}>
                <span className={group.key === null ? styles.keyMissing : styles.key}>
                  {labelForKey(group.key, groupBy)}
                </span>
                <span
                  className={styles.bar}
                  style={{ width: `${(shareOf(group, total.cost) * 100).toFixed(1)}%` }}
                  aria-hidden="true"
                />
              </th>
              <td className={styles.numeric}>
                {formatCost(group.cost)}
                {group.unpricedRuns > 0 && (
                  <span className={styles.partial} title={`${group.unpricedRuns} unpriced`}>
                    *
                  </span>
                )}
              </td>
              <td className={styles.numeric}>{group.runs}</td>
              <td className={styles.numeric}>{group.toolCalls}</td>
              <td className={styles.numeric}>{formatTokens(group.inputTokens)}</td>
              <td className={styles.numeric}>{formatTokens(group.outputTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
