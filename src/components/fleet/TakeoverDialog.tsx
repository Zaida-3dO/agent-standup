// The per-row "Take over" dialog — M10 T16.
//
// The targeted alternative to sweep, for when a reader means ONE item.
// `POST /api/claims/takeover` already requires a written reason whenever
// the holder may still be alive (`takeoverAssignment`'s `REASON_REQUIRED_GUARD`)
// — this dialog is what captures it, rather than the caller inventing one.
//
// Hook-free and prop-driven; the open/closed and in-flight STATE lives in
// the container.
import type { FleetAssignment } from "@/lib/fleet/types";
import styles from "./Fleet.module.css";

export interface TakeoverDialogProps {
  readonly assignment: FleetAssignment;
  readonly reason: string;
  readonly submitting: boolean;
  readonly errorMessage: string | null;
  readonly onReasonChange: (reason: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function TakeoverDialog({
  assignment,
  reason,
  submitting,
  errorMessage,
  onReasonChange,
  onCancel,
  onConfirm,
}: TakeoverDialogProps) {
  return (
    <div className={styles.takeoverDialog} role="alertdialog" aria-label="Confirm takeover">
      <p className={styles.takeoverText}>
        Take <strong>{assignment.itemTitle}</strong> over from{" "}
        <strong>{assignment.displayName}</strong>? This is a targeted takeover of this one item — it
        does not touch anything else in the fleet.
      </p>
      {/* Required whenever the holder may still be alive — the server
          decides that, not this dialog (see `requestTakeover`'s header) —
          but a reader is always given the chance to say why, since a
          `dead` holder's takeover is free and a `running`/`stalled` one is
          refused without it. */}
      <label className={styles.takeoverReasonLabel}>
        Reason
        <textarea
          className={styles.takeoverReasonInput}
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Why are you taking this over?"
          rows={2}
        />
      </label>
      {errorMessage !== null && (
        <p className={styles.takeoverError} role="alert">
          {errorMessage}
        </p>
      )}
      <div className={styles.takeoverActions}>
        <button
          type="button"
          className={styles.takeoverConfirmButton}
          onClick={onConfirm}
          disabled={submitting}
        >
          {submitting ? "Taking over…" : "Confirm takeover"}
        </button>
        {/* Names what the assignment will still be — the house convention
            for a dismiss control (see `ArchiveAction`'s header). "Cancel"
            here would read as cancelling the *work*, which is a recorded
            act elsewhere in the product and emphatically not what closing
            this dialog does: the current holder simply keeps it. */}
        <button type="button" className={styles.takeoverCancelButton} onClick={onCancel}>
          Leave it with them
        </button>
      </div>
    </div>
  );
}
