// How an HTTP request says which of §21's five transports it really is.
//
// Four of the five transports are self-evident to the adapter that receives
// them: the two MCP transports and the command line's `direct` binding each
// know what they are because of *where they are running*. The fifth is not.
// A `cli-http` call and a plain `http` call arrive at the same route, over
// the same protocol, in the same shape — the difference is which client
// composed it, and nothing about the request itself carries that.
//
// So this header carries it, and the rules around it are what keep it from
// being a self-report a caller could use to claim a capability:
//
//   - **It is only ever read by the registration route**, which is the one
//     place §21 says the transport means anything. No guard, no other
//     operation and no other route consults it.
//   - **It is read from a narrow allow-list**, `CLI_TRANSPORTS` below.
//     Anything else — including the three transports that are not reachable
//     over HTTP at all — is ignored, and the request registers as plain
//     `http`. A caller cannot use this header to register as `mcp-stdio` or
//     `cli-direct` and so cannot claim proximity it does not have.
//   - **What it can claim is strictly weaker than what it would otherwise
//     get.** Both `cli-http` and `http` map to the same hook variant
//     (`http`, `variantForTransport`), so a caller that lies here changes
//     which label its own registration row carries and changes nothing about
//     what it is permitted to do. That is what makes an unauthenticated
//     header acceptable at all: the honest and the dishonest answers have
//     the same consequence.
//
// A header rather than a body field because it is *who is calling*, not part
// of the operation's input — the same reason the session and actor travel as
// headers (`cli/bindings/http.ts`), and the same reason a body field would
// fail the operation's `.strict()` parse.

import { isSessionTransport, type SessionTransport } from "./sessions";

/** The header the command line's `http` binding stamps on every request. */
export const CLI_TRANSPORT_HEADER = "X-Standup-Transport";

/**
 * The transports a request arriving over HTTP is allowed to declare itself
 * as.
 *
 * Exactly one entry. Written as a list rather than an equality check because
 * the question it answers is "which transports reach the server over HTTP",
 * and that is a set — a second client wanting to be distinguishable is one
 * entry here, with the allow-list property unchanged, rather than a second
 * special case somewhere.
 */
export const CLI_TRANSPORTS: readonly SessionTransport[] = Object.freeze(["cli-http"]);

/**
 * The transport to stamp on a call that arrived over HTTP.
 *
 * Defaults to `http` for a missing, unreadable or disallowed header — never
 * refuses. A registration is a handshake, and refusing one because a header
 * this build did not recognise was present would break exactly the clients
 * that are trying hardest to be honest about themselves.
 */
export function transportForHttpRequest(headerValue: string | null | undefined): SessionTransport {
  if (typeof headerValue !== "string") return "http";
  const value = headerValue.trim();
  if (!isSessionTransport(value)) return "http";
  return CLI_TRANSPORTS.includes(value) ? value : "http";
}
