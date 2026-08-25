// Cancelling an item, on the item detail page — the control the archive
// guard's advice has been pointing at with nothing on the other end.
//
// ── The gap this closes ─────────────────────────────────────────────────
//
// `delete_item` refuses an archive reason that reads like a cancellation and
// names `cancelled` as the call to make instead. `ArchiveAction`'s own hint
// repeats that advice: *"if this work was real and is simply not being done,
// cancel it instead"*. This is the control that advice points at, and it has
// to exist for the advice to mean anything — a remedy a person is named and
// cannot reach is worse than no advice, because it reads as an instruction and
// behaves as a dead end.
//
// Without it, the confusion the archive guard exists to prevent gets **more**
// likely rather than less: if archive is the only control on the page, the
// person who wants to record a decision finds the destructive act first.
//
// ── Why these read as different acts, not two similar buttons ───────────
//
// This is the criterion that matters most, because two controls that look
// alike would be a worse outcome than one control: a person who can tell the
// two acts apart picks correctly, and a person facing two matching buttons
// picks by coin-flip. Five things separate them, and each is deliberate:
//
//   1. **Different questions.** Archive asks *"why should this item not
//      exist?"*. Cancel asks *"why is this work not being done?"*. The two
//      sentences cannot both be honestly answered about the same row, which
//      is the fastest way for a person to find out which act they are in.
//   2. **Different stated consequences.** Archive says it disappears from the
//      board and every listing. Cancel says the row **stays visible** and
//      carries the decision. That is the actual difference between them, so
//      it is what each control leads with.
//   3. **Different verbs on the record.** Archive's reason answers "should not
//      have existed"; cancel's decision answers "was real, and was dropped".
//   4. **Visual separation, and an order.** Cancel is presented first, in the
//      shared panel, because it is the commoner and the safer act — the
//      owner's own framing is *"typically it's: I had this task, I wanted to
//      do it, I decided not to. That's cancel, not archive."* Putting the
//      likelier correct act first is not decoration; it is what stops archive
//      being chosen by default for being the only thing on screen.
//   5. **Only one is destructive-looking.** Archive keeps its warning styling.
//      Cancel is styled as an ordinary closing act, because that is what it
//      is: the row survives, and a cancelled row can be transitioned again.
//
// ── No reverse guard, and why ───────────────────────────────────────────
//
// `delete_item` refuses a *cancellation-shaped archive reason*. The obvious
// symmetry would be to refuse an *archive-shaped cancel decision* here. That
// is deliberately not done, for three reasons:
//
//   1. **The harms are not symmetric.** A cancel that should have been an
//      archive leaves a visible row carrying its decision — nothing is lost,
//      and archive is one control away on this same panel. An archive that
//      should have been a cancel loses the decision entirely and hides the
//      row. Only one direction destroys information, and the guard already
//      defends that one.
//   2. **There is no honest vocabulary to match on.** `delete_item`'s check
//      works because the phrases it looks for essentially cannot appear in a
//      truthful archive reason. The inverse has no such list: *"duplicate of
//      the auth refactor"* is a perfectly legitimate cancellation decision —
//      we cancelled this **because** it duplicates that. A matcher on those
//      words would refuse callers who are right, and `delete-item.ts` states
//      the cost of that plainly: it teaches callers to write worse reasons to
//      satisfy a matcher.
//   3. **The steering it would add is already collected.** The decision floor
//      is the same 20 characters as the archive reason, deliberately. The
//      moment of composing a sentence — which is where `delete_item` says the
//      mistake usually surfaces — happens on both paths already.
//
// What the budget went to instead is (2) above: making the two acts legible at
// the point of choice, which is the actual cause of the confusion rather than
// a second place to catch it after the fact.
//
// Hook-free and prop-driven, per `tests/helpers/react-element.ts` and the
// convention every other component in this directory follows. All state and
// every fetch live in `ItemDetailContainer.tsx`.
import styles from "./ItemDetail.module.css";
import { DECISION_CHAR_MIN, DECISION_CHAR_CAP } from "@/lib/item-detail/cancel-state";

/**
 * Where the cancel affordance is in its own flow.
 *
 * The same union-of-states shape as `ArchiveActionState`, for the same reason:
 * "composing a decision" and "a cancellation is in flight" cannot both be
 * true, so making that unrepresentable beats disallowing it.
 */
export type CancelActionState =
  /** Nothing going on — the page shows only the control that starts this. */
  | { readonly status: "idle" }
  /** The decision form is open. `decision` is the draft. */
  | { readonly status: "composing"; readonly decision: string }
  /** A request is in flight. Controls disable; nothing else changes. */
  | { readonly status: "submitting" }
  /**
   * The server refused.
   *
   * `message` is its sentence, verbatim. `decision` is carried so a refused
   * cancellation does not lose what was typed — losing a composed sentence to
   * a refusal asking for a rewording is the most annoying possible way to
   * enforce a guard, and `ArchiveActionState` carries its reason for exactly
   * the same reason.
   */
  | {
      readonly status: "error";
      readonly message: string;
      readonly decision: string;
    };

export interface CancelActionProps {
  /**
   * Whether the item is already in a state that ends it.
   *
   * When it is, no cancel control is offered and a plain line says why. This
   * is not a guard — the server owns that — it is the surface not offering an
   * act that cannot apply, which is different from offering it and having it
   * refused.
   */
  readonly alreadyClosed: boolean;
  /** The state it is in, named on that line so "already closed" is not a mystery. */
  readonly state: string;
  readonly cancelState: CancelActionState;
  /** Opens the decision form. */
  readonly onBegin: () => void;
  /** Abandons the form or clears a refusal, back to idle. */
  readonly onDismiss: () => void;
  readonly onDecisionChange: (decision: string) => void;
  /** Submits the cancellation with the composed decision. */
  readonly onCancelItem: () => void;
}

/**
 * The hint under the decision box: the rule, and the distance from it.
 *
 * Pulled out as a function because it is the one piece of copy here with real
 * branching, and a unit test can then pin every branch without a DOM. The
 * over-cap branch matters most: a person 40 characters over should learn it
 * from the box rather than from a refusal.
 */
export function decisionHint(decision: string): string {
  const length = decision.trim().length;
  if (length < DECISION_CHAR_MIN) {
    return `At least ${DECISION_CHAR_MIN} characters (${length} so far). Name what changed, or which duplicate — a reader six months from now cannot reconstruct it from the row alone.`;
  }
  if (length > DECISION_CHAR_CAP) {
    return `${length} characters, over the ${DECISION_CHAR_CAP}-character limit. Trim it to the decision itself.`;
  }
  return "Long enough. This is recorded on the row, which stays visible — if instead this item should never have existed, archive it below.";
}

export function CancelAction({
  alreadyClosed,
  state,
  cancelState,
  onBegin,
  onDismiss,
  onDecisionChange,
  onCancelItem,
}: CancelActionProps) {
  const busy = cancelState.status === "submitting";

  if (alreadyClosed) {
    return (
      <div className={styles.cancelClosed} data-region="cancel-already-closed">
        <p className={styles.cancelClosedText}>
          This item is already closed ({state}). Cancelling records a decision to stop work that is
          still open, so there is nothing to cancel here.
        </p>
      </div>
    );
  }

  // The refusal, rendered verbatim. The summary validator's refusals name the
  // field and the distance from the rule, so there is nothing to improve by
  // rewriting them — see `cancel-state.ts`.
  const refusal =
    cancelState.status === "error" ? (
      <div className={styles.archiveError} data-region="cancel-error">
        <p className={styles.archiveErrorMessage}>{cancelState.message}</p>
        <button type="button" disabled={busy} onClick={onDismiss} data-region="cancel-dismiss">
          Dismiss
        </button>
      </div>
    ) : null;

  if (cancelState.status === "composing" || cancelState.status === "error") {
    // A refused cancellation keeps its form open with the typed decision
    // intact, so rewording is an edit rather than a retype.
    const { decision } = cancelState;
    const submittable =
      decision.trim().length >= DECISION_CHAR_MIN && decision.trim().length <= DECISION_CHAR_CAP;
    return (
      <div className={styles.cancelForm} data-region="cancel-form">
        <label className={styles.archiveLabel} htmlFor="cancel-decision">
          {/* Deliberately a different question from the archive form's "why
              should this item not exist?". A person who cannot answer this one
              honestly is not cancelling, and finding that out here is the
              whole point. */}
          Why is this work not being done? This is recorded as the decision, and the row stays on
          the board carrying it.
        </label>
        <textarea
          id="cancel-decision"
          className={styles.archiveReasonInput}
          value={decision}
          rows={3}
          disabled={busy}
          onChange={(event) => onDecisionChange(event.target.value)}
          data-region="cancel-decision-input"
        />
        <p className={styles.archiveHint} data-region="cancel-hint">
          {decisionHint(decision)}
        </p>
        <div className={styles.archiveButtons}>
          <button
            type="button"
            /* Disabled until the decision clears the length rule. The server
               would refuse anyway; this simply means the person is not sent on
               a round trip to be told what the hint already says. */
            disabled={busy || !submittable}
            onClick={onCancelItem}
            data-region="cancel-confirm"
          >
            {busy ? "Cancelling…" : "Cancel this work"}
          </button>
          <button type="button" disabled={busy} onClick={onDismiss} data-region="cancel-abandon">
            Keep it open
          </button>
        </div>
        {refusal}
      </div>
    );
  }

  return (
    <div className={styles.cancelStart} data-region="cancel-start">
      <button type="button" disabled={busy} onClick={onBegin} data-region="cancel-begin">
        Cancel this work…
      </button>
      {/* The ellipsis matches the archive control's: the convention for a
          control that opens something rather than acting. */}
      <span className={styles.cancelStartHint}>
        For work that was real and is not being done. The row stays visible and keeps the decision.
      </span>
    </div>
  );
}
