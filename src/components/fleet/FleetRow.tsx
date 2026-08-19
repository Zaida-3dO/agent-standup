// One row on the fleet table (M10 T16) — agent, item, role, state, machine,
// branch, model, last active, session, plus the per-row takeover control.
//
// Hook-free and prop-driven, so a test calls it as a function and inspects
// the element tree it returns (`tests/helpers/react-element.ts`).
import Link from "next/link";
import type { FleetAssignment } from "@/lib/fleet/types";
import { relativeTime } from "@/lib/fleet/view";
import { AgentPresenceDot } from "@/components/chips/AgentPresenceDot";
import styles from "./Fleet.module.css";

export interface FleetRowProps {
  readonly assignment: FleetAssignment;
  readonly now: number;
  /**
   * True when this assignment's `lastActive` is already past the dead
   * threshold but the ladder has not moved it — a dead-but-unswept claim.
   * See `isOverdueForSweep` — this is what makes such a row visible AS
   * such rather than reading like ordinary live work (the task's own
   * "done when" bullet).
   */
  readonly overdueForSweep: boolean;
  /** Opens the takeover control for this row. Absent hides the control entirely. */
  readonly onTakeover?: (assignment: FleetAssignment) => void;
}

export function FleetRow({ assignment, now, overdueForSweep, onTakeover }: FleetRowProps) {
  return (
    <tr className={styles.row} data-liveness={assignment.liveness} data-overdue={overdueForSweep}>
      <td className={styles.cell}>
        <span className={styles.agentCell}>
          <AgentPresenceDot liveness={assignment.liveness} agentName={assignment.displayName} />
          {assignment.displayName}
        </span>
      </td>
      <td className={styles.cell}>
        <Link href={`/items/${assignment.itemId}`} className={styles.itemLink}>
          {assignment.itemTitle}
        </Link>
      </td>
      <td className={styles.cell}>{assignment.roleCustom ?? assignment.role.replace(/_/g, " ")}</td>
      <td className={styles.cell}>{assignment.itemState.replace(/_/g, " ")}</td>
      <td className={styles.cell}>{assignment.machine}</td>
      <td className={styles.cell}>{assignment.branch ?? "—"}</td>
      <td className={styles.cell}>{assignment.model ?? "—"}</td>
      <td className={styles.cell}>
        {relativeTime(assignment.lastActive, now)}
        {/* The dead-but-unswept flag — the exact failure mode the task names:
            "visible as such, rather than looking like live work". */}
        {overdueForSweep && (
          <span className={styles.overdueFlag} title="Past the dead threshold; not yet swept">
            overdue for sweep
          </span>
        )}
      </td>
      <td className={styles.cell}>
        <span className={styles.sessionId} title={assignment.sessionId}>
          {assignment.sessionId.slice(0, 8)}
        </span>
      </td>
      <td className={styles.cell}>
        {onTakeover && (
          <button
            type="button"
            className={styles.takeoverButton}
            onClick={() => onTakeover(assignment)}
          >
            Take over
          </button>
        )}
      </td>
    </tr>
  );
}
