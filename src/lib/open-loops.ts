// Open loops — SCHEMA.md §3a. The loose ends a session is carrying that are
// not themselves work items: "the retry path is untested", "we never checked
// what happens on a cold boot".
//
// **A loop is a pair of events, not an item and not a table.** It has no
// state machine, no assignee, no review and no merge — the four things that
// make something an item here — so modelling it as one would put every loop
// on the board and into every count that ranges over items. It has exactly
// two moments (it opened; it closed) and a line of text, which is the shape
// `events` already is.
//
// This also fixes a real hole rather than adding a nicety: the only existing
// source of open loops is `Summary.notDone`, and `Summary` is one-to-one with
// an item and written only at completion. Before this, an item still
// `executing` could not carry an open loop at all — the state in which it is
// most likely to have one.
//
// The fold below is pure. It is the part that decides whether a loop is open,
// so it is testable without a database, and orientation calls it rather than
// asking Postgres to express the pairing in SQL.

/** The two event types a loop is made of. Mirrors `EventType` in schema.prisma. */
export const OPEN_LOOP_EVENT_TYPES = ["open_loop", "open_loop_closed"] as const;

/**
 * One open loop, as `orientation` reports it.
 *
 * `loopId` is the correlation key the two events share — supplied by whoever
 * opens the loop, not derived from the text. Deriving it from the text would
 * make "close the loop" depend on quoting the loop's wording back exactly,
 * and would silently merge two genuinely different loops that happened to be
 * phrased identically.
 */
export interface OpenLoop {
  readonly loopId: string;
  readonly text: string;
  /** ISO timestamp of the `open_loop` event. */
  readonly openedAt: string;
  /** The event id of the `open_loop`, stringified — `bigint` cannot cross a JSON boundary. */
  readonly eventId: string;
}

/** The subset of an event row this fold reads. Deliberately structural, so any row shape fits. */
export interface LoopEventLike {
  readonly id: bigint | number | string;
  readonly ts: Date | string;
  readonly type: string;
  readonly payload: unknown;
}

export class InvalidOpenLoopPayloadError extends Error {
  constructor(reason: string) {
    super(`open-loop payload: ${reason}`);
    this.name = "InvalidOpenLoopPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the payload of an `open_loop` event: `{ loopId, text }`, both
 * non-empty strings. Throws rather than returning a default — a loop whose
 * id is missing can never be closed, so accepting one would write a
 * permanently-open loop into the ledger.
 */
export function parseOpenLoopPayload(payload: unknown): { loopId: string; text: string } {
  if (!isRecord(payload)) {
    throw new InvalidOpenLoopPayloadError("must be an object");
  }
  const loopId = payload.loopId;
  const text = payload.text;
  if (typeof loopId !== "string" || loopId.trim() === "") {
    throw new InvalidOpenLoopPayloadError("loopId is required and must be a non-empty string");
  }
  if (typeof text !== "string" || text.trim() === "") {
    throw new InvalidOpenLoopPayloadError("text is required and must be a non-empty string");
  }
  return { loopId, text };
}

/**
 * Validates the payload of an `open_loop_closed` event: `{ loopId }`. The
 * text is not repeated — the open event already carries it, and a second
 * copy is a second thing that can disagree.
 */
export function parseOpenLoopClosedPayload(payload: unknown): { loopId: string } {
  if (!isRecord(payload)) {
    throw new InvalidOpenLoopPayloadError("must be an object");
  }
  const loopId = payload.loopId;
  if (typeof loopId !== "string" || loopId.trim() === "") {
    throw new InvalidOpenLoopPayloadError("loopId is required and must be a non-empty string");
  }
  return { loopId };
}

function toIso(ts: Date | string): string {
  return ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
}

/**
 * Folds a stream of events into the loops that are still open: every
 * `open_loop` whose `loopId` has no `open_loop_closed`.
 *
 * Order-independent by construction — the closes are collected first, then
 * the opens are filtered against them — so a ledger read that returns a close
 * before its open (possible: `events.id` is allocated before commit, so
 * sequence order is not commit order, SCHEMA.md §3) still resolves the loop
 * as closed. A single-pass fold that only cancelled a loop it had already
 * seen opened would report a closed loop as open in exactly that case.
 *
 * A close naming a `loopId` that was never opened is ignored rather than
 * raised: this reads a slice of the ledger, and the open may simply be older
 * than the slice. Reporting a loop the caller cannot see as an error would
 * make "catch me up" fail on a perfectly ordinary window.
 *
 * Malformed payloads are skipped, not thrown on — deliberately the opposite
 * posture from the two parsers above. Those guard the WRITE path, where a
 * refusal costs one caller a clear error. This is the READ path: it is what a
 * session calls to orient itself, and one bad row written by anything at any
 * point in history would otherwise make orientation permanently unusable for
 * that item.
 */
export function deriveOpenLoops(events: readonly LoopEventLike[]): OpenLoop[] {
  const closed = new Set<string>();
  for (const event of events) {
    if (event.type !== "open_loop_closed") continue;
    if (!isRecord(event.payload)) continue;
    const loopId = event.payload.loopId;
    if (typeof loopId === "string" && loopId.trim() !== "") {
      closed.add(loopId);
    }
  }

  const open: OpenLoop[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "open_loop") continue;
    if (!isRecord(event.payload)) continue;
    const loopId = event.payload.loopId;
    const text = event.payload.text;
    if (typeof loopId !== "string" || loopId.trim() === "") continue;
    if (typeof text !== "string" || text.trim() === "") continue;
    if (closed.has(loopId)) continue;
    // The same loop re-opened without an intervening close is one loop, not
    // two. Keeping the first occurrence keeps `openedAt` meaning "when this
    // became an open question", which is the thing a resuming session wants.
    if (seen.has(loopId)) continue;
    seen.add(loopId);
    open.push({
      loopId,
      text,
      openedAt: toIso(event.ts),
      eventId: String(event.id),
    });
  }
  return open;
}
