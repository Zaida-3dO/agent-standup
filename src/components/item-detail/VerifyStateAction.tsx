// The "confirm state" action — MILESTONES.md #131's second half.
//
// Two buttons, not a form: the question this asks is narrow ("does the
// stored `state` match what you found when you looked"), and a free-text
// box invites a much longer answer that belongs in a note or a checkpoint,
// not in the one artifact this screen exists to make cheap to record. Each
// button posts a fixed, honest body naming which outcome was found — see
// `bodyFor` — so the artifact `record_artifact` requires is never invented
// by this component, only assembled from what the reader clicked.
//
// **Says the refusal before it happens, not after.** `record_artifact`
// refuses a `historical_verification` with no `commitSha` — SCHEMA.md §6b —
// and this item may have no `commit` artifact to name one from at all. A
// disabled button with a reason is what the task brief asks for
// explicitly: "if your confirm-state action leads somewhere the state
// machine will refuse, say so in the UI before the user commits."
//
// **Never claims the merge gate is open.** `historical_verification`
// satisfying a MERGE additionally requires
// `ENABLE_HISTORICAL_VERIFICATION=true` on the server
// (`historical-verification-enabled.ts`), which nothing here can observe —
// the flag is an environment variable, deliberately unreachable from any
// caller (that file's header: "nothing reachable over HTTP, MCP or the
// command line can open it for itself"). So this component defaults to the
// PESSIMISTIC assumption and says so, rather than promising a merge-gate
// effect it cannot confirm the server will honour.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts`. Submitting
// state and the actual POST live in the container.
import styles from "./ItemDetail.module.css";

export type VerifyStateStatus =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "done" }
  | { readonly status: "error"; readonly message: string };

export interface VerifyStateActionProps {
  /**
   * The commit this item's evidence would be checked against — the newest
   * `commit` artifact's sha, or `null` when the item has none.
   * `record_artifact` cannot record a `historical_verification` without
   * one, so `null` disables the action rather than letting the click fail
   * on the server after the fact.
   */
  readonly tipCommitSha: string | null;
  readonly status: VerifyStateStatus;
  /** Called with which outcome the reader found — `agrees` or `disagrees` with the stored `state`. */
  readonly onConfirm: (outcome: "agrees" | "disagrees") => void;
}

/** The `body` a click records — what `record_artifact` requires, honestly stating which button was pressed. */
export function bodyFor(outcome: "agrees" | "disagrees", state: string): string {
  return outcome === "agrees"
    ? `Checked against the tip commit — the stored state (${state}) matches what was found.`
    : `Checked against the tip commit — the stored state (${state}) does NOT match what was found.`;
}

export function VerifyStateAction({ tipCommitSha, status, onConfirm }: VerifyStateActionProps) {
  const disabled = status.status === "submitting";

  if (tipCommitSha === null) {
    return (
      <p className={styles.verifyUnavailable} data-region="verify-state-unavailable">
        This item has no commit artifact recorded, so a verification cannot be attached — a
        `historical_verification` must name the commit it was checked against. Record a commit
        artifact first.
      </p>
    );
  }

  return (
    <div className={styles.verifyAction} data-region="verify-state">
      <p className={styles.verifyPrompt}>
        Does the stored state still match what you found?
        {/* The pessimistic default the header explains: this component
            cannot see ENABLE_HISTORICAL_VERIFICATION, so it never claims
            the record will satisfy a merge — only that it will be on file. */}
        <span className={styles.verifyCaveat}>
          {" "}
          This records what you found; it does not by itself change the item&apos;s state or satisfy
          a merge review.
        </span>
      </p>
      <div className={styles.verifyButtons}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onConfirm("agrees")}
          data-verify-outcome="agrees"
        >
          State is correct
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onConfirm("disagrees")}
          data-verify-outcome="disagrees"
        >
          State is wrong
        </button>
      </div>
      {status.status === "done" && (
        <p className={styles.verifyDone} data-region="verify-state-done">
          Recorded.
        </p>
      )}
      {status.status === "error" && (
        <p className={styles.verifyError} data-region="verify-state-error">
          {status.message}
        </p>
      )}
    </div>
  );
}
