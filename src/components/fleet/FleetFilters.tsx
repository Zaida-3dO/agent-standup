// The fleet page's machine/agent filter controls — M10 T16.
//
// Hook-free and prop-driven; the filter STATE lives in the container
// (`Fleet.tsx`), same split every other filtered list in this repo draws.
import type { FleetFilters as FleetFiltersValue } from "@/lib/fleet/view";
import styles from "./Fleet.module.css";

export interface FleetFiltersProps {
  readonly filters: FleetFiltersValue;
  readonly machines: readonly string[];
  readonly agents: readonly string[];
  readonly onChange: (filters: FleetFiltersValue) => void;
}

export function FleetFiltersBar({ filters, machines, agents, onChange }: FleetFiltersProps) {
  return (
    <div className={styles.filters}>
      <label className={styles.filterLabel}>
        Machine
        <select
          className={styles.filterSelect}
          value={filters.machine ?? ""}
          onChange={(event) =>
            onChange({ ...filters, machine: event.target.value === "" ? null : event.target.value })
          }
        >
          <option value="">All machines</option>
          {machines.map((machine) => (
            <option key={machine} value={machine}>
              {machine}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.filterLabel}>
        Agent
        <select
          className={styles.filterSelect}
          value={filters.agent ?? ""}
          onChange={(event) =>
            onChange({ ...filters, agent: event.target.value === "" ? null : event.target.value })
          }
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
