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
 * The size of a response as the caller will actually receive it.
 *
 * `JSON.stringify` because that is what crosses every one of this
 * application's boundaries — an HTTP body, an MCP tool result, the command
 * line's JSON envelope. Measuring the JavaScript object graph instead would
 * measure a thing no caller ever sees.
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
  get_events: "a smaller `limit`, or a narrower time range",
  get_item: "`full: false`, which returns the slim record",
  get_item_detail: "`get_item` with `full: false` for the slim record",
  orientation: "`get_item` for the one item, rather than its whole context",
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
  const size = responseSize(result);
  if (size === null || size <= MAX_RESPONSE_CHARS) return;
  throw new GuardRejectedError(
    RESPONSE_TOO_LARGE_GUARD,
    responseTooLargeMessage(operation, size, surfaceForTransport(transport)),
    { details: { operation, size, limit: MAX_RESPONSE_CHARS } },
  );
}
