// How a request id crosses the wire, and how it comes back.
//
// A request id already exists on both sides of an HTTP call: the command
// line mints one to label its own lines (`cli/bindings/http.ts`), and the
// service runtime mints one to label the server's (`service/runtime.ts`).
// They are simply different ids, so the two processes write correlated
// lines that cannot be joined — the client knows which call it made and the
// server knows which call it served, and nothing says they were the same
// call.
//
// This module is the join. One header carries the caller's id inbound, and
// the same header carries the served id back out, so a single value spans
// both logs and can also be quoted by whoever hit the problem.
//
// ── Why the caller's id is trusted, and what that costs ─────────────────
//
// A caller-supplied id is accepted as-is, and it is worth being precise
// about why that is safe here. This value is a *log label* and nothing
// else: it is never looked up, never compared against stored state, never
// used to authorise anything, and it decides nothing about what the caller
// may do. The threat it carries is not escalation but log corruption — an
// enormous, newline-laden or control-character-laden value would make the
// server's own log lines unreadable or forgeable, since those lines are
// newline-delimited JSON.
//
// So the value is not rejected, it is *constrained*: a shape that could
// corrupt a log line is discarded and the server falls back to minting its
// own id, exactly as it does when no header arrives at all. Refusing the
// request instead would turn a cosmetic mistake in a client's logging into
// a failed operation, which is a far worse trade for something that only
// ever labels a line.
//
// ── Why it is echoed ───────────────────────────────────────────────────
//
// Most feedback about this product arrives as "I called X and got Y". A
// response header naming the exact call means that report can carry the one
// value that finds it in the server's log, without the reporter needing
// access to the log or knowing what to look for. It is echoed on every
// response — success and failure alike — because the calls worth asking
// about are not only the ones that returned an error.

import { newRequestId } from "./log";

/**
 * The header a request id travels on, in both directions.
 *
 * `X-Request-Id` rather than a `Standup`-prefixed name: this is the
 * conventional spelling, which is what makes it legible to proxies, log
 * shippers and anyone debugging without having read this file first. The
 * `X-Standup-*` headers say something specific to this product; a request
 * id does not.
 */
export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * The longest caller-supplied id that will be honoured.
 *
 * A UUID is 36 characters; this leaves generous room for a client using
 * some other scheme while keeping a single log line bounded. The limit
 * exists so one caller cannot inflate every log line the server writes for
 * it.
 */
export const MAX_REQUEST_ID_LENGTH = 200;

/**
 * Whether a caller-supplied value is safe to write into a log line.
 *
 * Printable ASCII only, and no whitespace. That excludes the newline that
 * would let a value forge a second JSON log record, the control characters
 * that would corrupt one, and the non-ASCII bytes that are not valid in an
 * HTTP header value in the first place — so a value that passes here is
 * also one that can be echoed back in a response header unchanged.
 */
function isSafeRequestId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/**
 * The request id to use for a call that arrived over HTTP.
 *
 * Honours the caller's id when it is present and safe to log, and mints a
 * fresh one otherwise — a missing header and an unusable one take the same
 * path, because both mean "this call has no id the server can trust" and
 * the server's answer to that is the same either way. It never returns
 * `undefined`, so every HTTP call has an id to log and echo rather than
 * some having one and some not.
 */
export function requestIdForHttpRequest(headerValue: string | null | undefined): string {
  if (typeof headerValue !== "string") return newRequestId();
  const value = headerValue.trim();
  return isSafeRequestId(value) ? value : newRequestId();
}
