// The toast's state, as plain data and plain transitions.
//
// The container that mounts this (`UndoToastHost`) holds one value of type
// `UndoToastState` and sets it to the result of the functions here.
// None of them is a hook; all of them are total; the clock is a parameter.
// That is what lets the whole behaviour of the affordance — appearing,
// counting down, disappearing, reporting a conflict — be tested by calling
// functions, in a harness with no DOM.
//
// **Why a reducer rather than four `useState`s in the host.** The states
// are mutually exclusive in ways separate flags cannot express: an action
// being undone must not also be expiring out from under the request, and a
// conflict message must outlive the action that produced it (the action is
// gone; the explanation is the whole point). Writing them as one union
// makes those impossible combinations unrepresentable instead of merely
// avoided.
import { canUndo, isWithinWindow, type UndoableAction } from "./actions";

/**
 * What the toast area is showing.
 *
 * `idle` renders nothing at all — not an empty container — so the toast
 * occupies no space and traps no clicks when there is nothing to say.
 */
export type UndoToastState =
  | { readonly phase: "idle" }
  /** An action just happened and is offered back. */
  | { readonly phase: "offered"; readonly action: UndoableAction }
  /** The person pressed undo and the transitions are in flight. */
  | { readonly phase: "undoing"; readonly action: UndoableAction }
  /** The undo landed. */
  | { readonly phase: "undone" }
  /**
   * The undo did not land. `stale` is kept distinct from `failed` all the
   * way to the surface so the message can say someone else moved it — see
   * `request.ts` for why retrying a stale undo is wrong.
   */
  | { readonly phase: "error"; readonly kind: "stale" | "failed"; readonly message: string };

export const idleToast: UndoToastState = { phase: "idle" };

/**
 * A new action arrives.
 *
 * **It takes over the toast unconditionally**, including from an
 * in-flight undo. One toast at a time is the whole design: stacking them
 * would put two time-limited buttons on screen whose windows expire at
 * different moments, and the second action is by definition the more
 * recent thing the person did, so it is the one they would mean.
 */
export function actionOffered(action: UndoableAction): UndoToastState {
  return { phase: "offered", action };
}

/**
 * The person pressed undo.
 *
 * Refuses from any phase but `offered`, and refuses an action that is no
 * longer undoable at `nowMs` — a double-press, or a press landing in the
 * same tick the window closes, must not send a second set of transitions.
 * Returning the state unchanged (rather than throwing) keeps the caller a
 * plain event handler.
 */
export function undoPressed(state: UndoToastState, nowMs: number): UndoToastState {
  if (state.phase !== "offered") return state;
  if (!canUndo(state.action, nowMs)) return state;
  return { phase: "undoing", action: state.action };
}

/**
 * The clock advanced.
 *
 * Only an `offered` action expires. An `undoing` one deliberately does
 * not: the request is already sent, and pulling the toast out from under
 * it would leave the person with no report of what happened to a write
 * they asked for. `undone` and `error` do not expire here either — they
 * are dismissed by `dismissed`, or replaced by the next action — because
 * an explanation that vanishes on a timer is one the person may never have
 * read.
 */
export function ticked(state: UndoToastState, nowMs: number): UndoToastState {
  if (state.phase !== "offered") return state;
  // **The window only — deliberately NOT `canUndo`.**
  //
  // `canUndo` ANDs the window with `inverseOf(action).available`, which is
  // the right question for "should the button render" and the wrong one for
  // "should the toast render". Using it here made visibility depend on
  // undoability, and for an archive `available` is permanently false — so
  // the first tick collapsed the toast to `idle` and the confirmation
  // "Archived X" was never seen at all. The same fate hit a no-op
  // `from === to` move, and it made `UndoToast`'s `unavailableReason`
  // branch unreachable: the component was written to render the toast
  // without a button and say why, and nothing could ever reach that path.
  //
  // A confirmation of something the person just did is worth showing
  // whether or not it can be taken back — the toast is how they learn the
  // archive happened. What it must not do is offer a button that cannot
  // work, and that is `showUndo`'s job, one layer up, where `canUndo`'s
  // two conditions still both apply.
  return isWithinWindow(state.action, nowMs) ? state : idleToast;
}

/** The undo finished. `ok` decides which report the person is left with. */
export function undoSettled(
  state: UndoToastState,
  outcome:
    | { readonly ok: true }
    | { readonly ok: false; readonly kind: "stale" | "failed"; readonly message: string },
): UndoToastState {
  // Only the undo this toast started may settle it. Without this, a
  // response arriving after the person has already done something else
  // would overwrite the newer toast with a report about a vanished one.
  if (state.phase !== "undoing") return state;
  return outcome.ok
    ? { phase: "undone" }
    : { phase: "error", kind: outcome.kind, message: outcome.message };
}

/** The person dismissed the toast. Always lands on idle, from any phase. */
export function dismissed(): UndoToastState {
  return idleToast;
}
