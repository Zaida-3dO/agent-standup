// The "Run sweep" control — M10 T16.
//
// **Sweep is GLOBAL — it acts on the whole board, not one item** (the task
// brief's own words, underlined because a recent live sweep released 174
// claims in one call). This component exists specifically to make that
// unmissable BEFORE the click and to report what it released AFTER —
// which is why it is not just a button wired straight to `runSweep`.
//
// Hook-free and prop-driven; the confirm/result STATE lives in the
// container (`Fleet.tsx`), same split the drag interaction draws in
// `Board.tsx` vs `BoardView.tsx`.
import type { SweepResult } from "@/lib/fleet/state";
import styles from "./Fleet.module.css";

export interface SweepControlProps {
  /** How many live assignments the sweep is about to consider — the number that makes the scope concrete. */
  readonly liveCount: number;
  /** True while the confirm dialog is open. */
  readonly confirming: boolean;
  /** True while the sweep request is in flight. */
  readonly running: boolean;
  /** The last result, or `null` before any sweep has run this session. */
  readonly lastResult: SweepResult | null;
  /** The last failure's message, or `null`. */
  readonly errorMessage: string | null;
  readonly onOpenConfirm: () => void;
  readonly onCancelConfirm: () => void;
  readonly onConfirmSweep: () => void;
}

export function SweepControl({
  liveCount,
  confirming,
  running,
  lastResult,
  errorMessage,
  onOpenConfirm,
  onCancelConfirm,
  onConfirmSweep,
}: SweepControlProps) {
  return (
    <div className={styles.sweepPanel}>
      <button
        type="button"
        className={styles.sweepButton}
        onClick={onOpenConfirm}
        disabled={confirming || running}
      >
        Run sweep
      </button>

      {/* The confirmation IS the unmissable-scope requirement — a plain
          `window.confirm` would say nothing about what the click actually
          does, and a button with no confirmation at all is the exact
          failure the task warns about. */}
      {confirming && (
        <div className={styles.sweepConfirm} role="alertdialog" aria-label="Confirm sweep">
          <p className={styles.sweepConfirmText}>
            This runs the liveness sweep for the <strong>whole board</strong>, not this item or this
            filter. It will check every live assignment in the installation ({liveCount} right now)
            and release every one the ladder judges dead.
          </p>
          <div className={styles.sweepConfirmActions}>
            <button
              type="button"
              className={styles.sweepConfirmButton}
              onClick={onConfirmSweep}
              disabled={running}
            >
              {running ? "Sweeping…" : "Sweep the whole board"}
            </button>
            <button type="button" className={styles.sweepCancelButton} onClick={onCancelConfirm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {errorMessage !== null && (
        <p className={styles.sweepError} role="alert">
          {errorMessage}
        </p>
      )}

      {/* What it released, AFTER the click — the other half of the
          requirement. `released.length`, never a guess at what "probably"
          happened. */}
      {lastResult !== null && (
        <p className={styles.sweepResult} data-released-count={lastResult.released.length}>
          Sweep checked at {new Date(lastResult.checkedAt).toLocaleTimeString()}: released{" "}
          <strong>{lastResult.released.length}</strong>{" "}
          {lastResult.released.length === 1 ? "claim" : "claims"}, moved {lastResult.moves.length}.
        </p>
      )}
    </div>
  );
}
