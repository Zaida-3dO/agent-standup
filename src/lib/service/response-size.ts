// A read that will not fit says so — MILESTONES.md #115.
//
// **The house style is already settled in the opposite direction from
// truncation.** The summary validators refuse an over-cap summary rather
// than trimming it — "it will not be truncated for you" — because a value
// silently shortened is a value the caller believes it received in full.
// The same reasoning applies with more force to a read: a partial result
// that does not announce itself is indistinguishable from a complete one,
// and a caller cannot tell "these are the twelve items" from "these are
// twelve of the items". So an oversized response is **refused**, naming the
// call that was too big and a narrower one that would work.
//
// **The assertion is about response SIZE, not row count**, which is the
// row's own wording and the lesson #107 paid for. Row count was never the
// thing that overflowed: a handful of items carrying long bodies and custom
// fields is a larger payload than hundreds of slim ones, so `limit: 1` on
// the largest item still overflows a context window. What a caller's
// context actually enforces is characters, so characters are what this
// measures.
//
// **Why this exists even after the bounded reads and slim projections.**
// Those change what a read returns *by default*. They do not put a ceiling
// on anything: a caller may still ask for `full` records at the maximum
// page size, an item's own `body` and `customFields` are unbounded, and a
// read added later inherits no bound at all. Defaults decide the common
// case; this catches whatever still exceeds them, which is the case nobody
// predicted.
//
// **Where the check sits, and why it is not in each operation.** The
// runtime is the one seam every call crosses on every adapter (SCHEMA.md
// §22), so measuring here covers the reads that exist and the reads that do
// not exist yet, and cannot be forgotten by an operation author. Putting it
// in the operations would be a rule re-implemented per operation, which is
// the shape of gap this codebase's registry-driven checks exist to close.
import { GuardRejectedError } from "./errors";
import { invocationFor, surfaceForTransport, type CallSurface } from "@/lib/surfaces";

/**
 * The largest response a read may return, in characters of serialised JSON.
 *
 * **The number is a context budget, not a database limit.** 200,000
 * characters is roughly 50k tokens — far larger than any response this
 * application has cause to return, and still comfortably inside a modern
 * caller's context. It is deliberately well above the bounded reads'
 * own defaults: this is a backstop for the responses those defaults do not
 * cover, and a ceiling that fired on ordinary use would be a page size in
 * disguise rather than a guard.
 *
 * The measurements this row was filed over sit above it — a board read at
 * ~542,000 characters, a `full` projection at ~1,045,000 — so the responses
 * that actually failed are refused, while every legitimate large read
 * passes.
 */
export const MAX_RESPONSE_CHARS = 200_000;

/** The guard identifier, as a refusal reports it. */
export const RESPONSE_TOO_LARGE_GUARD = "response.too_large";

/**
 * The serialised size of a response, before any adapter renders it.
 *
 * `JSON.stringify` because a serialised form is what crosses every one of
 * this application's boundaries — an HTTP body, an MCP tool result, the
 * command line's JSON envelope. Measuring the JavaScript object graph
 * instead would measure a thing no caller ever sees.
 *
 * **This is the payload's own size, not the number of characters that reach
 * a particular caller.** An adapter may render the same value more than
 * once, so what lands in a context is a multiple of this — see
 * `WIRE_COPIES_PER_SURFACE`, which is what `enforceResponseSize` applies on
 * top of this figure.
 *
 * A value that cannot be serialised at all — a circular structure — is not
 * a size problem and must not be reported as one, so it is treated as
 * unmeasurable and allowed through to fail where it really fails. This
 * guard exists to make an oversized read legible; converting an unrelated
 * defect into a size refusal would do the opposite.
 */
export function responseSize(value: unknown): number | null {
  try {
    const serialised = JSON.stringify(value);
    // `undefined` serialises to `undefined` rather than to a string — an
    // operation returning nothing has no size to speak of.
    return serialised === undefined ? 0 : serialised.length;
  } catch {
    return null;
  }
}

/**
 * How many times a surface puts the payload on the wire.
 *
 * **A ceiling on the payload is not a ceiling on what arrives** wherever an
 * adapter renders the same value twice, and one here does: an MCP tool
 * result carries the answer as both a `text` rendering and as
 * `structuredContent`, because clients are split on which they read and
 * neither is safely droppable (`mcp/result.ts` carries that reasoning). A
 * caller on that surface therefore receives two copies of everything, so a
 * payload measured at just under the ceiling would deliver just under twice
 * it — on the surface an agent is most likely to be reading through, which
 * is exactly the overflow this guard exists to prevent.
 *
 * Applying the factor here rather than raising the ceiling keeps the
 * constant meaning one thing: `MAX_RESPONSE_CHARS` is what a caller may
 * receive, and each surface states how much wire it spends per character of
 * payload. A surface absent from this table sends one copy, which is the
 * honest default — an adapter that starts duplicating its output adds an
 * entry here rather than silently halving the guard.
 */
const WIRE_COPIES_PER_SURFACE: Readonly<Record<string, number>> = {
  mcp: 2,
};

/** How many copies of the payload the caller's surface puts on the wire. */
export function wireCopiesFor(surface: CallSurface | undefined): number {
  return surface === undefined ? 1 : (WIRE_COPIES_PER_SURFACE[surface] ?? 1);
}

/**
 * How a caller asks the same question for less — named per operation,
 * because "narrow it" is advice and a parameter is an instruction.
 *
 * Only the reads whose narrower form is genuinely different are listed. A
 * read absent from this table falls back to the generic sentence below,
 * which names `search` — the call that answers "the specific item I want"
 * without returning a set at all, and therefore the honest suggestion when
 * nothing more specific is known.
 */
const NARROWER_CALL: Readonly<Record<string, string>> = {
  get_board: "a single `column` with a smaller `limit`, or `full: false`",
  list_items: "a smaller `limit`, a `state` or `area` filter, or `full: false`",
  search: "a narrower `query` or a smaller `limit`",
  // **Not `limit`, and this is the correction rather than a wording
  // preference.** The advice here used to read "a smaller `limit`, or a
  // narrower time range", and neither remedy reaches this operation at any
  // sensible magnitude: `payload` and `body` are ~95% of an event, so a
  // page of 20 still measured ~144,000 characters against the 200,000
  // ceiling — a caller following that advice narrows the page repeatedly
  // and is refused every time. `full: false` is the control that actually
  // works, and it is the default, so this fires only for a caller who
  // opted into the heavy columns. A guard that refuses correctly but
  // advises wrongly costs the same debugging time as one that only refuses.
  get_events: "`full: false`, which drops each event's payload and body",
  get_item: "`full: false`, which returns the slim record",
  // **Both of these used to name a call that does not return loops, and
  // that is the correction.** `get_item_detail` suggested `get_item {full:
  // false}` and `orientation` suggested `get_item`; neither returns loops at
  // all. On a long-lived item the loops are frequently *why* the response
  // does not fit — 40 of them measured 321,056 characters through
  // `orientation` — so the caller most likely to hit this refusal was being
  // redirected to a call that silently omits the thing they were reading
  // for. A redirect to a tool that answers a different question is worse
  // than the refusal alone: the refusal is at least legible as a failure,
  // where an empty `openLoops` reads as "there are none".
  //
  // Both now name `loop_list` first, because that is the call that actually
  // returns the withheld thing, and keep the slim-record route for the rest
  // of the payload.
  get_item_detail:
    "`loop_list` for this item's loops, or `get_item` with `full: false` for the slim record",
  orientation:
    "`loop_list` for this item's loops, or `get_item` for the item itself, rather than its whole context",
  my_work: "a smaller `limit`",
};

/**
 * The refusal a caller reads.
 *
 * Three things it has to carry, and the reason for each. **What happened**,
 * in characters against the ceiling, because "too large" without a number
 * gives a caller nothing to aim at. **Which call**, spelled for the surface
 * they are on, because a refusal naming an MCP tool to someone in a
 * terminal costs the round trip it was meant to save. **What to do
 * instead**, as a parameter rather than as encouragement — this is the same
 * self-routing principle the bounded reads' notices apply to a successful
 * read, reaching the case where the read could not be returned at all.
 */
export function responseTooLargeMessage(
  operation: string,
  size: number,
  surface: CallSurface | undefined,
): string {
  const narrower = NARROWER_CALL[operation];
  const remedy =
    narrower === undefined
      ? `Ask for less, or use ${invocationFor("search", surface)} to find one specific item.`
      : `Call ${invocationFor(operation, surface)} with ${narrower}.`;
  return (
    `This ${invocationFor(operation, surface)} response is ${size.toLocaleString("en-GB")} characters, ` +
    `over the ${MAX_RESPONSE_CHARS.toLocaleString("en-GB")}-character limit, so it was not returned — ` +
    `it will not be truncated for you, because a partial result you cannot identify as partial is worse ` +
    `than none. ${remedy}`
  );
}

/**
 * Refuses a response that will not fit, or returns it untouched.
 *
 * Applied to reads only. A write's response is a receipt — an id, a state,
 * the row that was just written — and its size is a function of what the
 * caller itself sent rather than of how much data the store happens to
 * hold; refusing one *after* the transaction committed would also report a
 * failure for work that succeeded, which is a worse answer than a large
 * receipt.
 */
export function enforceResponseSize(
  operation: string,
  kind: "read" | "write",
  transport: string | undefined,
  result: unknown,
): void {
  if (kind !== "read") return;
  const payload = responseSize(result);
  if (payload === null) return;
  const surface = surfaceForTransport(transport);
  // What the caller receives, which is the payload times however many copies
  // its surface puts on the wire — see `WIRE_COPIES_PER_SURFACE`. Measuring
  // the payload alone would leave the guard half as strong on the surface
  // that duplicates, which is the one an agent most often reads through.
  const delivered = payload * wireCopiesFor(surface);
  if (delivered <= MAX_RESPONSE_CHARS) return;
  throw new GuardRejectedError(
    RESPONSE_TOO_LARGE_GUARD,
    responseTooLargeMessage(operation, delivered, surface),
    { details: { operation, size: delivered, payload, limit: MAX_RESPONSE_CHARS } },
  );
}
