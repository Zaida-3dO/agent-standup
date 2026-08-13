// MCP over streamable HTTP. See MILESTONES.md #30 ("wired to streamable
// HTTP. **Stateless.**") and docs/plans/DECISIONS.md §12, "MCP statefulness".
//
// **This is the only file in `src/lib/mcp/` that knows HTTP exists.** The
// core (`./server.ts`) registers tools and calls the service; this module
// takes the server the core built and connects it to a transport that
// speaks streamable HTTP. #84 adds a sibling of this file for stdio and
// changes nothing else, which is the property row #30 was scoped around.
//
// ── Stateless, and what that rules out ──────────────────────────────────
//
// `sessionIdGenerator: undefined` puts the transport in stateless mode: no
// `Mcp-Session-Id` is minted on initialize, none is validated on subsequent
// requests, and no per-session state is held between them. A fresh
// server *and* a fresh transport are constructed for every single request
// and closed when it completes, so there is no cross-request memory to
// leak, to grow, or to pin a client to one process.
//
// What that buys is that any request can be served by any process. The
// application ships as a container image, so "any process" includes a
// replacement started a second ago and a second replica behind a proxy —
// neither of which could serve a client that had been handed a session id
// by the first one.
//
// What it rules out, plainly, is every MCP feature that needs the server to
// remember a caller between requests:
//
//   - **Server-initiated messages.** No standalone `GET` SSE stream to push
//     notifications down, so no `notifications/tools/list_changed`, no
//     server-initiated sampling or elicitation, and no logging stream.
//   - **Progress on a long call.** A tool cannot report incremental progress
//     for work still running; it answers once, when it is done.
//   - **Resumability.** No event store, so a client that drops mid-response
//     retries the call rather than resuming the stream.
//   - **Anything remembered between calls.** No per-session cursor, cached
//     authorisation, or accumulated context — every call carries everything
//     it needs.
//
// None of that is a loss here, because every tool is a single service call
// that answers and returns (§22). The thing that would genuinely need
// server-initiated messages is waiting for a crew event, and §18 already
// puts that outside MCP: `wait_for_crew` is a command-line call, "because
// only a shell call can be backgrounded".
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type ServiceCall } from "./server";

/** The transport name stamped on every call arriving this way (SCHEMA.md §21). */
export const MCP_HTTP_TRANSPORT = "mcp-http";

/**
 * Builds a stateless streamable-HTTP transport.
 *
 * `sessionIdGenerator: undefined` is the whole of "stateless" — the SDK
 * reads its absence as "session management is disabled". It is written out
 * explicitly rather than omitted because an omitted option looks like an
 * oversight in a diff, and this one is the row's headline requirement.
 *
 * `enableJsonResponse: true` answers a POST with a plain JSON body instead
 * of opening an SSE stream. A stateless server has nothing to stream —
 * there are no server-initiated messages and no progress notifications to
 * interleave — so a single JSON response is the complete answer, and it
 * avoids holding a response open that will never carry a second frame.
 */
export function createStatelessTransport(): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
}

/**
 * Serves one MCP request over streamable HTTP.
 *
 * A server and a transport per request, both closed before returning. That
 * is the stateless posture taken literally: nothing survives the call, so
 * two requests cannot share anything and a client cannot depend on landing
 * back on the same instance. It costs a server construction per request —
 * tool registration over a handful of operations, no I/O — which is
 * cheaper than the coordination that keeping one alive would require.
 *
 * The transport is closed in a `finally` so that a handler that throws
 * cannot leak one. `close()` on a stateless transport tears down only this
 * request's state; there is no session to end.
 */
export async function handleMcpRequest(request: Request, call: ServiceCall): Promise<Response> {
  const server = createMcpServer({ call, transport: MCP_HTTP_TRANSPORT, adapter: "mcp_http" });
  const transport = createStatelessTransport();
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}
