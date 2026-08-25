// Conflict handling when two agents touch one item — T17, part 2.
//
// **What makes this possible at all is server-side and already shipped.**
// `transition_item` accepts `expectedFrom` and refuses with a 409 carrying
// the item's *actual* state (`StaleTransitionError`, MILESTONES.md #257), and
// the HTTP adapter spreads that error's `details` alongside the envelope
// precisely so a client does not have to parse prose to learn where the item
// really is (`src/app/api/items/respond.ts`). A UI that instead compared a
// stale local copy and declined to send would not be conflict handling — it
// would be the same race with a wider window, since the copy it compares can
// go stale between the check and the request.
//
// **What this module adds is the sentence, and the reconciliation.** The
// existing refusal path is genuinely good — it reverts the card and
// announces the reason through `role="alert"` — and it survives unchanged for
// every other refusal. What it does badly is the multiplayer case
// specifically: "That move was refused" for a card someone else moved two
// seconds ago reads as the interface being broken. So a 409 gets a sentence
// naming who moved it, where to, and how long ago; and the card settles on
// where the server says it is rather than snapping back to a position that is
// also wrong.
//
// Pure functions over plain data, like every other decision in
// `src/lib/board/`.
import { actorName, latestStateChange, shortAgo, type LiveEvent } from "./events";

/** The structured part of a 409 the board can act on. */
export interface ConflictDetails {
  /** Where the server says the item actually is. */
  readonly currentState: string;
  /** What the client believed, when it said so. */
  readonly expectedFrom: string | null;
}

/**
 * Reads a 409's `details` out of an error envelope.
 *
 * Returns `null` for anything that is not a conflict this module understands
 * — a 409 with no `details`, or with a `currentState` that is not a non-empty
 * string. Falling back to the generic refusal is the right failure: a
 * conflict message that names a state it did not actually read would be worse
 * than the generic one, because it would be confidently wrong.
 *
 * Typed against `unknown` rather than a parsed envelope because this runs in
 * a browser on a response body nothing has validated.
 */
export function conflictDetailsFrom(body: unknown): ConflictDetails | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;

  const currentState = (details as { currentState?: unknown }).currentState;
  if (typeof currentState !== "string" || currentState.trim() === "") return null;

  const expectedFrom = (details as { expectedFrom?: unknown }).expectedFrom;
  return {
    currentState,
    expectedFrom: typeof expectedFrom === "string" && expectedFrom !== "" ? expectedFrom : null,
  };
}

/** `plan_review` → `plan review`, matching `@/lib/since/view`'s own humanise. */
function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * The sentence shown when a move was refused because someone else got there
 * first.
 *
 * **Attribution is best-effort and degrades honestly.** `recent` is whatever
 * the live feed has already read — no extra request is made to build this
 * message, because a refusal that waits on the network to explain itself is a
 * refusal that arrives after the person has stopped looking. When the ledger
 * happens to hold the `state_change` that caused the conflict, the message
 * names the actor and the age; when it does not, the message still says
 * truthfully where the item is now, which is the fact that makes the refusal
 * actionable. It never invents an actor.
 *
 * The `to` in the message comes from the *event* when there is one and from
 * `details.currentState` otherwise. Those agree in the ordinary case; when
 * they do not, the server's `currentState` is the newer fact, so it wins —
 * a message naming a state the item has already left would send the reader
 * looking in the wrong column.
 */
export function conflictMessage(
  details: ConflictDetails,
  recent: readonly LiveEvent[],
  itemId: string,
  now: number,
): string {
  const where = humanise(details.currentState);
  const event = latestStateChange(recent, itemId);
  if (event === null) {
    return `Someone else moved this. It is now in ${where} — the board has been updated.`;
  }
  return `${actorName(event)} moved this to ${where} ${shortAgo(event.ts, now)}. The board has been updated.`;
}
