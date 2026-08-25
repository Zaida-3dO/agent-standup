// Archive and restore, on the item detail page — the affordance #274's
// reversibility was built for and never got.
//
// ── What makes this deliberate, and why it is not a confirm dialog ──────
//
// Archiving takes a row out of the board, out of search, out of every listing
// read, and out of its parent's subtree. It is reversible — that is the whole
// point of `restore_item` — but it is quiet: nothing else on screen changes,
// and a person who did it by accident may not notice for a week. So it must
// not be reachable by one stray click.
//
// The obvious guard is a confirm dialog, and it is deliberately **not** what
// this uses. A dialog asking "are you sure?" is answered yes reflexively; it
// measures nothing except whether a person can press a second button, and the
// person who mis-clicked the first is exactly the person who will mis-click
// the second. It also has nothing to say — it can only restate the question.
//
// What this uses instead is the requirement `delete_item` already imposes:
// **a reason of at least twenty characters, which is refused if it reads like
// a cancellation**. That is a far better gate than a dialog, for three reasons
// that are worth stating because they are why the extra typing is not friction
// to be optimised away later:
//
//   1. **It cannot be satisfied reflexively.** A sentence naming *which*
//      duplicate or *which* accident has to be composed, and there is no way
//      to compose one by accident.
//   2. **It is the moment the mistake surfaces.** `delete_item`'s own header
//      makes this argument: writing the sentence is where "I decided not to do
//      this" usually reveals itself as the real answer — and that is a
//      `cancelled` transition, not an archive. The operation refuses those
//      wordings by name and says so.
//   3. **It leaves a record.** The reason is stored on the row and shown on
//      the archived notice, so a mistaken archive is reviewable later by
//      someone who was not there. A dialog leaves nothing behind.
//
// So the shape is: a plain text button that opens a form, a reason box that
// must be filled before the archive control is enabled, and a way out beside
// it. Three deliberate acts — open, compose, submit — none of which is a
// double-click away from the one before.
//
// ── Why the way out is "Keep it" and not "Cancel" ───────────────────────
//
// This panel is the one place the product asks a person to tell **archiving**
// apart from **cancelling**, and they are genuinely different: archiving says
// the row should not exist, cancelling records a decision that real work is
// not being done. `CancelAction` sits directly beside this component with a
// button reading "Cancel this work" — a recorded act.
//
// A dismiss button labelled "Cancel" here would spend that same word on a
// third meaning — "close this form, do nothing" — on the one view whose whole
// job is teaching the distinction. So the convention this file and
// `CancelAction` both follow is: **a dismiss control names what the thing
// will still be afterwards, never the verb of a neighbouring act.** "Keep it"
// here, "Keep it open" on the cancel form. Both say the row survives
// untouched, and neither can be misread as performing anything.
//
// **Restore is a single button, and that asymmetry is the point.** Restoring
// puts a row back where it was; the failure mode of an accidental restore is a
// visible row somebody archives again, which is nothing like the failure mode
// of an accidental archive. Guarding both equally would have taught people to
// click through the guard on the safe one and then click through it on the
// dangerous one.
//
// ── The refusals are rendered verbatim ──────────────────────────────────
//
// Every message shown in the error region is the server's own sentence, passed
// through untouched by `@/lib/item-detail/archive-state`. See that module's
// header for why. Two of the refusals are acknowledgeable, and this renders a
// second, explicitly-labelled control for those — never an automatic retry,
// because the flag means "I have read this and I mean it" and sending it
// without the person having read it would make the guard a formality.
//
// Hook-free and prop-driven, per `tests/helpers/react-element.ts` and the
// convention every other component in this directory follows. All state and
// every fetch live in `ItemDetailContainer.tsx`.
import styles from "./ItemDetail.module.css";
import {
  isAcknowledgeable,
  ARCHIVE_REASON_MIN_CHARS,
  RESTORE_SUPERSEDED_GUARD,
} from "@/lib/item-detail/archive-state";

/**
 * Where the archive/restore affordance is in its own little flow.
 *
 * A union rather than a set of booleans, for the reason `EditingField` beside
 * it is one: the states are mutually exclusive and several combinations are
 * meaningless ("composing a reason" and "an archive is in flight" cannot both
 * be true), so making them unrepresentable beats disallowing them.
 */
export type ArchiveActionState =
  /** Nothing going on — the page shows only the control that starts this. */
  | { readonly status: "idle" }
  /** The reason form is open. `reason` is the draft. */
  | { readonly status: "composing"; readonly reason: string }
  /** A request is in flight. Both controls disable; nothing else changes. */
  | { readonly status: "submitting" }
  /**
   * The server refused.
   *
   * `message` is its sentence, verbatim. `guard` decides whether the
   * acknowledge control is offered, and `supersededById` — present only on a
   * superseded-restore refusal — is the row worth looking at before deciding.
   * `reason` is carried so a refused archive does not lose what was typed:
   * losing a composed sentence to a refusal that asks the person to reword it
   * is the most annoying possible way to enforce a guard.
   */
  | {
      readonly status: "error";
      readonly message: string;
      readonly guard: string | null;
      readonly supersededById: string | null;
      readonly reason: string;
    };

export interface ArchiveActionProps {
  /** Whether the row is archived right now — decides Archive vs Restore. */
  readonly archived: boolean;
  /** Why it was archived, shown on the archived notice. Null when live or unrecorded. */
  readonly archivedReason: string | null;
  /** The surviving replacement, when one was named — shown so a stale link leads somewhere live. */
  readonly supersededById: string | null;
  readonly state: ArchiveActionState;
  /** Opens the reason form. */
  readonly onBeginArchive: () => void;
  /** Abandons the form or clears a refusal, back to idle. */
  readonly onCancel: () => void;
  readonly onReasonChange: (reason: string) => void;
  /** Submits the archive with the composed reason. */
  readonly onArchive: () => void;
  /** Submits a restore. */
  readonly onRestore: () => void;
  /**
   * Retries the refused call with the acknowledgement flag set — the person
   * having read the refusal is the entire meaning of this control, which is
   * why it is a separate handler rather than a second press of the first.
   */
  readonly onAcknowledge: () => void;
}

/**
 * The label the acknowledge control carries, chosen by which guard refused.
 *
 * Deliberately says what will happen rather than "Continue": the two
 * acknowledgements permit genuinely different things, and a person who has
 * just read a list of live children is owed a button that names what pressing
 * it does to them.
 */
export function acknowledgeLabel(guard: string | null): string {
  return guard === RESTORE_SUPERSEDED_GUARD
    ? "Restore anyway — they are different work"
    : "Archive anyway — I have read what points at it";
}

export function ArchiveAction({
  archived,
  archivedReason,
  supersededById,
  state,
  onBeginArchive,
  onCancel,
  onReasonChange,
  onArchive,
  onRestore,
  onAcknowledge,
}: ArchiveActionProps) {
  const busy = state.status === "submitting";

  // The refusal, wherever the flow is. Rendered by both branches below, so it
  // is built once here rather than duplicated into each.
  const refusal =
    state.status === "error" ? (
      <div className={styles.archiveError} data-region="archive-error">
        {/* The server's sentence, verbatim — see this file's header and
            `archive-state.ts`. Nothing summarises or truncates it. */}
        <p className={styles.archiveErrorMessage}>{state.message}</p>
        {state.supersededById !== null && (
          <p className={styles.archiveSuperseded}>
            {/* A plain link, because the refusal names an id and an id is not
                something a person can act on by reading it. This is the row
                the work was taken up by, and looking at it is the decision the
                guard is asking them to make. */}
            <a href={`/items/${state.supersededById}`} data-region="archive-superseded-link">
              Look at {state.supersededById} first
            </a>
          </p>
        )}
        {isAcknowledgeable(state.guard) && (
          <button
            type="button"
            disabled={busy}
            onClick={onAcknowledge}
            data-region="archive-acknowledge"
          >
            {acknowledgeLabel(state.guard)}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onCancel} data-region="archive-dismiss">
          Dismiss
        </button>
      </div>
    ) : null;

  if (archived) {
    return (
      <div className={styles.archivedNotice} data-region="archived-notice">
        <p className={styles.archivedHeading}>
          This item is archived. It does not appear on the board, in search, or in any other
          ordinary read — this page still resolves it so an old link lands somewhere real.
        </p>
        {archivedReason !== null && (
          <p className={styles.archivedReason} data-region="archived-reason">
            Reason given: {archivedReason}
          </p>
        )}
        {supersededById !== null && (
          <p className={styles.archivedReason}>
            {/* Shown on the notice as well as on a refusal: a reader who
                arrived here by a stale link needs the live row, and they have
                not pressed anything to be told about it. */}
            Superseded by <a href={`/items/${supersededById}`}>{supersededById}</a>
          </p>
        )}
        <button type="button" disabled={busy} onClick={onRestore} data-region="restore-item">
          {busy ? "Restoring…" : "Restore this item"}
        </button>
        {refusal}
      </div>
    );
  }

  if (state.status === "composing" || state.status === "error") {
    // A refused archive keeps its form open with the typed reason intact, so
    // rewording is an edit rather than a retype. Both phases carry `reason`
    // for exactly this — losing a composed sentence to a refusal that asks for
    // a rewording is the most annoying possible way to enforce a guard.
    const { reason } = state;
    const longEnough = reason.trim().length >= ARCHIVE_REASON_MIN_CHARS;
    return (
      <div className={styles.archiveForm} data-region="archive-form">
        <label className={styles.archiveLabel} htmlFor="archive-reason">
          Why should this item not exist? Name which duplicate, or which accident — this is stored
          on the row and is what makes a mistaken archive reviewable later.
        </label>
        <textarea
          id="archive-reason"
          className={styles.archiveReasonInput}
          value={reason}
          rows={3}
          disabled={busy}
          onChange={(event) => onReasonChange(event.target.value)}
          data-region="archive-reason-input"
        />
        <p className={styles.archiveHint} data-region="archive-hint">
          {/* States the rule and the distance from it, so the disabled control
              below is never a mystery. The cancellation check is NOT mirrored
              here — see `archiveReasonIsValid` for why that refusal is worth
              hearing in the server's own words. */}
          {longEnough
            ? "Long enough. If this work was real and is simply not being done, cancel it instead — that is a different thing and belongs in the record."
            : `At least ${ARCHIVE_REASON_MIN_CHARS} characters (${reason.trim().length} so far).`}
        </p>
        <div className={styles.archiveButtons}>
          <button
            type="button"
            /* Disabled until the reason clears the length rule. The server
               would refuse anyway; this simply means the person is not sent
               on a round trip to be told what the hint already says. */
            disabled={busy || !longEnough}
            onClick={onArchive}
            data-region="archive-confirm"
          >
            {busy ? "Archiving…" : "Archive this item"}
          </button>
          {/* "Keep it", not "Cancel" — see this file's header. "Cancel this
              work" is a recorded act on this same panel, and spending the
              word on "close the form" here would blur the one distinction
              this view exists to teach. */}
          <button type="button" disabled={busy} onClick={onCancel} data-region="archive-cancel">
            Keep it
          </button>
        </div>
        {refusal}
      </div>
    );
  }

  return (
    <div className={styles.archiveStart} data-region="archive-start">
      <button type="button" disabled={busy} onClick={onBeginArchive} data-region="archive-begin">
        Archive this item…
      </button>
      {/* The ellipsis on the label above is doing real work: it is the
          convention for a control that opens something rather than acting, so
          the first click reads as "start" rather than "do it". */}
      <span className={styles.archiveStartHint}>
        Removes it from the board and every listing. Reversible, and it asks for a reason.
      </span>
    </div>
  );
}
