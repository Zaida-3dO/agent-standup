// Time the undo window did not get to spend — the pure half of "an undo
// offered while a modal is open must still be takeable when it closes".
//
// ── The defect this exists for ──────────────────────────────────────────
//
// The undo toast renders at `z-index: 50`, beneath every modal overlay in
// the app (quick create at 60, the palette and help sheet at 70, the
// profile picker at 100). That layering is CORRECT and is not what this
// changes: a modal that things float over is not a modal, and raising the
// toast above an `aria-modal` dialog would buy clickability by breaking
// modality. Measured with `document.elementFromPoint` at the centre of the
// Undo button while quick create was open, the topmost element is the
// backdrop and the button is unreachable.
//
// So the affordance was visible and inert. A person who moved a card,
// opened a dialog, and then realised they wanted the move back could watch
// the countdown run out through the scrim without being able to press it.
//
// ── Why the window PAUSES rather than continuing to run ─────────────────
//
// The alternative — suppress the toast but let its window keep ticking —
// fixes the visual contradiction and none of the loss. The person closes
// the dialog to find the offer simply gone, which is the same ten seconds
// wasted, just without being made to watch. That is a cosmetic fix to a
// behavioural complaint.
//
// The window is a measure of ATTENTION, not of wall-clock time.
// `UNDO_WINDOW_MS`'s own reasoning is that ten seconds is "long enough to
// notice a mistaken drop and reach for the button" — a person reading a
// modal dialog is not spending that attention on a toast they cannot see or
// reach. Freezing the countdown for exactly as long as they could not act
// on it is what makes the window mean what it says it means.
//
// **The cost of pausing, stated plainly.** An undo can now be taken later
// in wall-clock terms than a naive reading of "ten seconds" implies — open
// a dialog for a minute and the offer is still there afterwards, with
// whatever time it had left. The premise an undo rests on (that the item is
// still where the action left it) has had longer to go stale.
//
// That is a real cost and it is survivable here for a specific reason
// rather than by optimism: **staleness is already checked by the server,
// not assumed by the client.** Every undo transition carries `expectedFrom`
// (see `UndoTransitionStep`), so an item someone else moved in the meantime
// refuses the undo with a 409 and the toast reports it as `kind: "stale"`.
// `actions.ts` says it directly — "`expectedFrom` is what makes the racy
// case safe, and the short window is what makes it rare". Pausing makes the
// race marginally less rare. It does not make it unsafe, because the thing
// that makes it safe was never the window.
//
// Weighed against that: not pausing loses the offer every single time, with
// certainty. An occasional refusal the person is told about is a better
// failure than a guaranteed silent loss.
//
// ── Pure, and a parameter for every clock read ──────────────────────────
//
// No hooks, no `Date.now()`. The whole point of this file is that "how much
// time did the window actually get" is decidable by calling a function with
// numbers, in the repo's DOM-free harness, rather than by opening a dialog
// and waiting.

/**
 * How long an offer has been unable to be acted on.
 *
 * `accumulatedMs` is time from windows that have already closed and been
 * reopened. `since` is when the current suspension began, or `null` when
 * nothing is suppressing the toast right now — so a live suspension is
 * still growing and a finished one has been banked.
 *
 * Two fields rather than one running total because the total cannot be
 * updated without a clock tick, and a suspension that is open right now has
 * to be measurable at any `nowMs` the caller happens to ask about. Keeping
 * the open interval separate means the answer is derived rather than
 * maintained.
 */
export interface Suspension {
  readonly accumulatedMs: number;
  readonly since: number | null;
}

/** Nothing has been suspended. The state every offer starts in. */
export const NO_SUSPENSION: Suspension = { accumulatedMs: 0, since: null };

/**
 * An overlay opened at `nowMs`.
 *
 * Idempotent while already suspended: a second overlay opening (or a
 * re-render reporting the same fact) must not restart the interval, because
 * that would discard the time already elapsed in the current one. The
 * suspension runs from the FIRST thing that covered the toast until the
 * LAST one goes away.
 */
export function suspended(suspension: Suspension, nowMs: number): Suspension {
  if (suspension.since !== null) return suspension;
  return { accumulatedMs: suspension.accumulatedMs, since: nowMs };
}

/**
 * Every overlay closed at `nowMs`.
 *
 * Banks the open interval into the total and clears it. Idempotent when
 * nothing was suspended, so a caller reporting "no overlay is open" on
 * every render does not have to check first.
 *
 * A `since` in the future (a clock that stepped backwards) banks zero
 * rather than a negative, which would otherwise *shorten* the window and
 * expire an offer early — the failure `isWithinWindow` explicitly refuses
 * to have for the same reason.
 */
export function resumed(suspension: Suspension, nowMs: number): Suspension {
  if (suspension.since === null) return suspension;
  const elapsed = nowMs - suspension.since;
  return {
    accumulatedMs: suspension.accumulatedMs + (elapsed > 0 ? elapsed : 0),
    since: null,
  };
}

/**
 * Total time the window has been frozen for, as of `nowMs`.
 *
 * The banked total plus whatever an open interval has run to at `nowMs`.
 * This is the number every other reader wants, and deriving it here is what
 * keeps `Suspension`'s two fields an implementation detail.
 */
export function suspendedMs(suspension: Suspension, nowMs: number): number {
  if (suspension.since === null) return suspension.accumulatedMs;
  const open = nowMs - suspension.since;
  return suspension.accumulatedMs + (open > 0 ? open : 0);
}

/**
 * The instant to judge the window against, given time it did not get to
 * spend.
 *
 * Every existing window question — `isWithinWindow`, `remainingMs`,
 * `canUndo`, `ticked` — takes a `nowMs` and compares it to `action.at`.
 * Rather than teaching each of them about suspension, the suspended time is
 * subtracted from the clock ONCE here and the existing functions are handed
 * the result. An offer suspended for four seconds is, as far as the window
 * is concerned, four seconds younger than the wall clock says.
 *
 * This is why nothing in `actions.ts` or `state.ts` changes shape: their
 * arithmetic was already right, it was being given the wrong instant.
 */
export function windowClock(nowMs: number, suspension: Suspension): number {
  return nowMs - suspendedMs(suspension, nowMs);
}
