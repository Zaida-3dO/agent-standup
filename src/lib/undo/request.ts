// Performing an undo — the half that talks to the network.
//
// Split from `actions.ts` for the reason `board/move.ts` is split from
// `board/drag.ts`: this is the part that takes a `fetch`, and keeping it a
// plain function with the fetch injected makes the whole
// shaping-and-refusal path testable with a stub, no DOM and no server.
//
// ── `expectedFrom` is not optional here, and that is the point ──────────
//
// `transition_item` gained an optional `expectedFrom` in MILESTONES.md
// #257. Its own doc is explicit that omitting it is not a weaker version of
// supplying it — it is last-writer-wins, the pre-existing contract. **Undo
// is the operation that most needs the stronger one.** The whole premise of
// an undo is "put this back where it was", and that premise names a state
// the item was in ten seconds ago. In between, another session may have
// moved it: this board is written concurrently by many agents on many
// machines, which is the situation the field was added for. An undo sent
// without the precondition would silently overwrite that other session's
// move with a state the person only meant to restore from *their* action —
// the person would see "undone" and the board would be wrong.
//
// So every step this module sends carries `expectedFrom`, and it is typed
// as required on `UndoStep` rather than optional, so a caller cannot build
// a step that omits it.
//
// ── A 409 is reported, never retried ────────────────────────────────────
//
// When the precondition fails the server answers `conflict` (HTTP 409) via
// `StaleTransitionError`, carrying the item's **actual** current state in
// `details.currentState`. Retrying would mean re-sending with the new state
// as the premise, which is precisely the silent clobber the precondition
// exists to prevent — the person asked to undo *their* move, not to
// overwrite whatever happened since. So this reports it, and reports it
// specifically enough to be actionable: what the item's state is now, so
// the person knows what they are looking at rather than being told a
// generic failure.
import { uiApiPath } from "@/lib/ui-proxy/path";
import type { UndoPlan, UndoStep } from "./actions";

/**
 * How an undo attempt ended.
 *
 * `stale` is its own outcome rather than folded into `failed`, because the
 * two call for different words to the person and different behaviour: a
 * failure invites trying again, a stale item does not. Keeping them
 * distinct in the type means the surface cannot accidentally offer a retry
 * on the one outcome where retrying is wrong.
 */
export type UndoOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: "stale";
      readonly message: string;
      /** Where the item actually is now, when the server named it. */
      readonly currentState: string | null;
    }
  | { readonly ok: false; readonly kind: "failed"; readonly message: string };

/** The error envelope every items route answers with (`src/app/api/items/respond.ts`). */
interface ErrorBody {
  readonly error?: {
    readonly message?: unknown;
    readonly details?: { readonly currentState?: unknown };
  };
}

/** The message a failed response carries, or a stand-in naming the status. */
async function readError(response: Response): Promise<{
  message: string;
  currentState: string | null;
}> {
  try {
    const body = (await response.json()) as ErrorBody;
    const message = body.error?.message;
    const currentState = body.error?.details?.currentState;
    return {
      message:
        typeof message === "string" && message !== ""
          ? message
          : `The undo failed (${response.status}).`,
      currentState: typeof currentState === "string" && currentState !== "" ? currentState : null,
    };
  } catch {
    // A non-JSON error body is not itself worth reporting — the status is.
    return { message: `The undo failed (${response.status}).`, currentState: null };
  }
}

/**
 * What the person is told when the item moved out from under the undo.
 *
 * Built here rather than passing the server's own sentence through,
 * because the server's message is written for a caller deciding what to do
 * next ("Re-read the item and decide again against its current state") and
 * this reader is a person who pressed a button. What they need is that it
 * did *not* happen and why — someone else moved it — plus where it is now,
 * which is the fact that makes the sentence checkable rather than a shrug.
 */
export function staleMessage(currentState: string | null): string {
  return currentState === null
    ? "Someone else moved this — the undo was not applied."
    : `Someone else moved this — it is now in ${currentState}, so the undo was not applied.`;
}

/**
 * Where one step goes and what it carries.
 *
 * Split out so `sendStep` below holds exactly one copy of the request,
 * response and error handling — all of which are identical for both kinds.
 * The only thing that differs between undoing a move and undoing an archive
 * is the URL and the body, so that is the only thing that varies here.
 */
function requestFor(step: UndoStep): { path: string; body: string } {
  if (step.kind === "restore") {
    return {
      path: `/api/items/${encodeURIComponent(step.itemId)}/restore`,
      // No `expectedFrom` equivalent: a restore does not move the item, so
      // there is no state for a staleness check to compare against. See
      // `UndoRestoreStep`.
      body: "{}",
    };
  }
  return {
    path: `/api/items/${encodeURIComponent(step.itemId)}/transition`,
    body: JSON.stringify({ to: step.to, expectedFrom: step.expectedFrom }),
  };
}

/**
 * Sends one step.
 *
 * `full: false` (the default, so it is simply not sent): unlike a board
 * drag, an undo has no card to reconcile — the surface re-reads or the
 * toast simply reports the outcome — so asking for the whole row would
 * fetch fields nothing here reads.
 */
async function sendStep(step: UndoStep, fetchImpl: typeof fetch): Promise<UndoOutcome> {
  const { path, body } = requestFor(step);
  let response: Response;
  try {
    response = await fetchImpl(uiApiPath(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    // The request never reached the server. Reported as a failure rather
    // than a stale item: nothing is known about where the item is, and
    // claiming someone else moved it would be a guess.
    return { ok: false, kind: "failed", message: "The undo could not be sent." };
  }

  if (response.ok) return { ok: true };

  const { message, currentState } = await readError(response);
  if (response.status === 409) {
    return { ok: false, kind: "stale", message: staleMessage(currentState), currentState };
  }
  return { ok: false, kind: "failed", message };
}

/**
 * Runs a whole plan.
 *
 * **Sequential, and it stops at the first refusal.** A bulk undo is several
 * transitions and they are not a transaction — the server has no
 * multi-item write — so partial application is possible whatever this
 * does. Stopping on the first refusal keeps the damage bounded and, more
 * importantly, keeps the message true: continuing past a stale item would
 * end with "someone else moved this" while having gone on to move several
 * others anyway, which reads as a failure and behaves as a success.
 *
 * The already-applied steps are deliberately NOT rolled back. Rolling back
 * an undo would be a third layer of inferred intent, and each rollback
 * could itself hit a stale item — the person is better served by an honest
 * report and a board they can look at.
 */
export async function runUndo(
  plan: UndoPlan,
  fetchImpl: typeof fetch = fetch,
): Promise<UndoOutcome> {
  if (!plan.available) {
    return { ok: false, kind: "failed", message: plan.reason };
  }
  for (const step of plan.steps) {
    const outcome = await sendStep(step, fetchImpl);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}
