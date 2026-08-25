// The live feed's cursor arithmetic — T17, "the cursor is correct under
// concurrent transactions".
//
// **The hard part is already solved on the server, and this module must not
// re-solve it.** `readSinceBounded` (`@/lib/events`) reads
// `WHERE id > $1 AND txId < visibilityHorizon(db)`, and its header works
// through why the `txId` bound is required: `events.id` is allocated at
// INSERT time but becomes *visible* at commit time, so two transactions can
// commit out of order and leave a lower id landing after a reader already
// advanced past it. `id > since` alone would skip that row permanently.
// `get_events` returns the slice's own high-water mark as `cursor`, taken
// from rows that were already below the horizon.
//
// So the client's whole job is: **carry the server's cursor back verbatim,
// and never invent one.** Every function here is a pure function over
// strings, because the cursor is a `bigint` stringified — past 2^53 a JSON
// number silently rounds, and a cursor that rounds is a cursor that skips or
// repeats rows (see `get_events`'s `since` field for the same reasoning on
// the way in).
//
// **Why comparison is not `Number(a) > Number(b)`.** The same precision
// argument applies to comparing two cursors as to transporting one. These
// are decimal strings of arbitrary length, so they are compared by length
// first and then lexicographically — which is exact for non-negative
// integers with no leading zeros, and needs no BigInt in a browser bundle.

/** The cursor a client starts from before it has ever read the ledger. */
export const INITIAL_CURSOR = "0";

/** Whether a string is a cursor this module will act on: decimal digits only. */
export function isCursor(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Compares two cursors as integers: negative when `a` is behind `b`, zero
 * when equal, positive when ahead.
 *
 * Leading zeros are normalised away first, so `"007"` and `"7"` compare
 * equal rather than differing by length. The server never sends them, but a
 * comparison that silently got this wrong would be a cursor that appears to
 * move backwards.
 */
export function compareCursors(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The cursor to hold after a response.
 *
 * **Monotonic, and that is the point.** A cursor is only ever allowed to
 * move forward: a response that arrives out of order — two polls in flight
 * because a slow one overlapped a fast one — must not rewind the cursor and
 * replay a slice already applied. An older answer is dropped rather than
 * obeyed.
 *
 * A malformed or missing cursor leaves the held one untouched, for the same
 * reason: the alternative is resetting to `0` and re-reading the whole
 * ledger from the start, which turns one bad response into a flood.
 */
export function advanceCursor(held: string, received: unknown): string {
  if (!isCursor(received)) return held;
  return compareCursors(received, held) > 0 ? received : held;
}
