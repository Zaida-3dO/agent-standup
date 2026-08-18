// The tree-repair panel — MILESTONES.md #75.
//
// ── What this is for ────────────────────────────────────────────────────
//
// A bulk import from a store with no project/task distinction types every
// parentless item it loads as a project. Such an item is structurally
// stuck: a project's state derives from its children, so with none there is
// nothing to transition and no child whose completion would resolve it.
// `retype_to_task` and `reparent_item` fix that. They need a user interface
// because a grid that flags the condition while offering nothing to do about
// it teaches a reader to ignore the flag.
//
// ── The one thing this panel must not do ────────────────────────────────
//
// **It must not promise what the state machine will then refuse.**
//
// Repair makes an item *transitionable*. It does not make it *closeable*.
// An item whose work already shipped, once repaired, meets the merge gate:
// a recorded commit, and an approving code review at the current review
// round and tip commit. For work that finished before this installation
// existed there is no reviewer who could honestly write one. The product's
// answer is a `historical_verification` artifact — an inspection of merged
// code, recorded permanently as an inspection rather than as a review — and
// the merge gate accepts it **only while a deployment-level window is
// open** (`ENABLE_HISTORICAL_VERIFICATION`).
//
// So the outcome of a repair genuinely differs, and the difference is not
// something the browser can determine. The server sends
// `repair.historicalVerificationAvailable`, and this panel renders the
// limit sentence from `repairOfferFor` **above the controls, always, before
// the user can act** — not in a tooltip, not after the call, not in smaller
// type than the description. When a repair dead-ends for already-finished
// work the panel takes a heavier treatment (`repairDeadEnd`), because
// "needs attention" and "this route ends in a refusal you cannot clear"
// must not look the same.
//
// The alternative — offering the buttons and letting the user discover the
// wall — leaves them having changed live data for nothing and having to
// work out why a refusal happened. That is the specific failure this panel
// is shaped against.
//
// Hook-free and prop-driven: the input values and the busy flag are props,
// and the two actions are callbacks. The container owns the state.
import type { RepairOutcome } from "@/lib/project-detail/state";
import type { RepairAdvice } from "@/lib/project-detail/types";
import { repairOfferFor } from "@/lib/project-detail/view";
import styles from "./ProjectDetail.module.css";

export interface RepairPanelProps {
  readonly repair: RepairAdvice;
  /** The project id to file this item under — `retype_to_task`'s `projectId`. */
  readonly projectId: string;
  readonly onProjectIdChange: (value: string) => void;
  /** The parent to move to — `reparent_item`'s `parentId`. Empty means the top level (`null`). */
  readonly parentId: string;
  readonly onParentIdChange: (value: string) => void;
  readonly onRetype: () => void;
  readonly onReparent: () => void;
  /** True while a repair call is in flight, so neither control can be pressed twice. */
  readonly busy?: boolean;
  /** What the last repair did, once it returned. */
  readonly outcome?: RepairOutcome | null;
}

export function RepairPanel({
  repair,
  projectId,
  onProjectIdChange,
  parentId,
  onParentIdChange,
  onRetype,
  onReparent,
  busy = false,
  outcome = null,
}: RepairPanelProps) {
  const offer = repairOfferFor(repair);
  // A project with children is not broken, so there is nothing to offer.
  // Rendering the panel anyway with the controls disabled would suggest a
  // repair is pending rather than irrelevant.
  if (!offer.applicable) return null;

  return (
    <section
      className={`${styles.repair}${offer.deadEndsForFinishedWork ? ` ${styles.repairDeadEnd}` : ""}`}
      aria-label="Repair this project"
      data-repair-panel="true"
      // Read by the tests. The honest summary of what this panel is
      // claiming: whether the route it offers ends in a closed item.
      data-dead-end={offer.deadEndsForFinishedWork ? "true" : "false"}
    >
      <h2 className={styles.repairTitle}>This project has no work under it</h2>
      <p className={styles.repairText}>{offer.achieves}</p>

      {/* The limit, rendered BEFORE the controls and never conditionally on
          an interaction. See the module header — this is the whole point of
          the panel. */}
      {offer.limit !== null && (
        <p className={styles.repairLimit} data-repair-limit="true" role="note">
          {offer.limit}
        </p>
      )}

      <div className={styles.repairForm}>
        <label className={styles.repairField}>
          <span className={styles.repairLabel}>
            Retype to a task under this project (an id, or “inbox”)
          </span>
          <input
            className={styles.repairInput}
            type="text"
            value={projectId}
            placeholder="inbox"
            onChange={(event) => onProjectIdChange(event.target.value)}
            data-repair-input="projectId"
          />
        </label>
        <button
          type="button"
          className={styles.repairButton}
          onClick={onRetype}
          // Disabled on an empty value rather than defaulting to "inbox"
          // behind the user's back: where a repaired item lands is a
          // decision the operation deliberately refuses to make on its own,
          // and a UI that quietly picked one would be making it for them.
          disabled={busy || projectId.trim() === ""}
          data-repair-action="retype"
        >
          Retype to task
        </button>
      </div>

      <div className={styles.repairForm}>
        <label className={styles.repairField}>
          <span className={styles.repairLabel}>
            Or move it under a different parent (leave empty for the top level)
          </span>
          <input
            className={styles.repairInput}
            type="text"
            value={parentId}
            placeholder="a project id"
            onChange={(event) => onParentIdChange(event.target.value)}
            data-repair-input="parentId"
          />
        </label>
        <button
          type="button"
          className={styles.repairButton}
          onClick={onReparent}
          // NOT disabled on empty: empty means the top level, which is a
          // real and intended choice (`parentId: null`), unlike the retype
          // case where there is no meaningful default.
          disabled={busy}
          data-repair-action="reparent"
        >
          Reparent
        </button>
      </div>

      {outcome !== null && (
        <p
          className={`${styles.repairOutcome} ${
            outcome.status === "done" ? styles.repairDone : styles.repairRefused
          }`}
          role="status"
          data-repair-outcome={outcome.status}
        >
          {outcome.message}
        </p>
      )}
    </section>
  );
}
