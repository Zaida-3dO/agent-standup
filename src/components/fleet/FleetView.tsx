// The presentational half of the fleet page (M10 T16) — the load/error/
// loaded branching, the grouped table, the filters, sweep and takeover.
//
// Deliberately prop-driven and hook-free rather than a `useFleet()` caller
// — same reasoning as `BoardView.tsx` and `ProjectsView.tsx`: with
// `environment: "node"` and no DOM, a component that takes plain props can
// be called directly as a function and its returned tree inspected, which
// is what actually proves these branches. `Fleet.tsx` is the thin client
// container that fetches and hands this component its props.
import type { FleetAssignment } from "@/lib/fleet/types";
import {
  agentsOf,
  filterFleet,
  groupByLiveness,
  isOverdueForSweep,
  machinesOf,
  NO_FLEET_FILTERS,
  type FleetFilters as FleetFiltersValue,
} from "@/lib/fleet/view";
import type { SweepResult } from "@/lib/fleet/state";
import { EmptyState } from "@/components/states/EmptyState";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";
import { FleetFiltersBar } from "./FleetFilters";
import { FleetRow } from "./FleetRow";
import { SweepControl } from "./SweepControl";
import { TakeoverDialog } from "./TakeoverDialog";
import styles from "./Fleet.module.css";

export type FleetLoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "loaded"; readonly assignments: readonly FleetAssignment[] };

export interface TakeoverState {
  readonly assignment: FleetAssignment;
  readonly reason: string;
  readonly submitting: boolean;
  readonly errorMessage: string | null;
}

export interface FleetViewProps {
  readonly loadState: FleetLoadState;
  readonly now: number;
  /** How many seconds of quiet the ladder needs before a claim is dead — feeds the overdue-for-sweep flag. */
  readonly deadAfterSeconds: number;
  readonly filters: FleetFiltersValue;
  readonly onFiltersChange: (filters: FleetFiltersValue) => void;
  readonly onRetry?: () => void;

  readonly sweepConfirming: boolean;
  readonly sweepRunning: boolean;
  readonly sweepLastResult: SweepResult | null;
  readonly sweepErrorMessage: string | null;
  readonly onOpenSweepConfirm: () => void;
  readonly onCancelSweepConfirm: () => void;
  readonly onConfirmSweep: () => void;

  /** The row the open takeover dialog targets, or `null` when none is open. */
  readonly takeover: TakeoverState | null;
  readonly onStartTakeover: (assignment: FleetAssignment) => void;
  readonly onTakeoverReasonChange: (reason: string) => void;
  readonly onCancelTakeover: () => void;
  readonly onConfirmTakeover: () => void;
}

export function FleetView({
  loadState,
  now,
  deadAfterSeconds,
  filters,
  onFiltersChange,
  onRetry,
  sweepConfirming,
  sweepRunning,
  sweepLastResult,
  sweepErrorMessage,
  onOpenSweepConfirm,
  onCancelSweepConfirm,
  onConfirmSweep,
  takeover,
  onStartTakeover,
  onTakeoverReasonChange,
  onCancelTakeover,
  onConfirmTakeover,
}: FleetViewProps) {
  if (loadState.status === "error") {
    return (
      <div className={styles.page}>
        <ErrorState message={loadState.message} onRetry={onRetry} centered />
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className={styles.page}>
        <LoadingState rows={6} label="the fleet" />
      </div>
    );
  }

  const all = loadState.assignments;
  const filtered = filterFleet(all, filters);
  const groups = groupByLiveness(filtered);
  const hasFilter = filters.machine !== null || filters.agent !== null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.heading}>Fleet</h1>
        <span className={styles.count} data-fleet-count={filtered.length}>
          {filtered.length} live {filtered.length === 1 ? "assignment" : "assignments"}
        </span>
      </header>

      <FleetFiltersBar
        filters={filters}
        machines={machinesOf(all)}
        agents={agentsOf(all)}
        onChange={onFiltersChange}
      />

      <SweepControl
        liveCount={all.length}
        confirming={sweepConfirming}
        running={sweepRunning}
        lastResult={sweepLastResult}
        errorMessage={sweepErrorMessage}
        onOpenConfirm={onOpenSweepConfirm}
        onCancelConfirm={onCancelSweepConfirm}
        onConfirmSweep={onConfirmSweep}
      />

      {takeover !== null && (
        <TakeoverDialog
          assignment={takeover.assignment}
          reason={takeover.reason}
          submitting={takeover.submitting}
          errorMessage={takeover.errorMessage}
          onReasonChange={onTakeoverReasonChange}
          onCancel={onCancelTakeover}
          onConfirm={onConfirmTakeover}
        />
      )}

      {filtered.length === 0 ? (
        <EmptyState
          kind={hasFilter ? "filtered" : "empty"}
          noun="assignment"
          total={all.length}
          onClearFilter={hasFilter ? () => onFiltersChange(NO_FLEET_FILTERS) : undefined}
          title={hasFilter ? undefined : "Nothing is live right now"}
        />
      ) : (
        <div className={styles.groups}>
          {groups.map((group) => (
            <section
              key={group.liveness}
              className={styles.group}
              data-liveness-group={group.liveness}
            >
              <h2 className={styles.groupHeading}>
                {group.label}{" "}
                <span className={styles.groupCount}>({group.assignments.length})</span>
              </h2>
              {group.assignments.length === 0 ? (
                <p className={styles.groupEmpty}>None.</p>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.th}>Agent</th>
                      <th className={styles.th}>Item</th>
                      <th className={styles.th}>Role</th>
                      <th className={styles.th}>State</th>
                      <th className={styles.th}>Machine</th>
                      <th className={styles.th}>Branch</th>
                      <th className={styles.th}>Model</th>
                      <th className={styles.th}>Last active</th>
                      <th className={styles.th}>Session</th>
                      <th className={styles.th} />
                    </tr>
                  </thead>
                  <tbody>
                    {group.assignments.map((assignment) => (
                      <FleetRow
                        key={assignment.id}
                        assignment={assignment}
                        now={now}
                        overdueForSweep={isOverdueForSweep(assignment, now, deadAfterSeconds)}
                        onTakeover={onStartTakeover}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
