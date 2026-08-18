// The MCP adapter's HTTP mount point (MILESTONES.md #30, SCHEMA.md §18).
//
// A thin shell in the strictest sense: it resolves nothing, decides nothing,
// and contains no rule. It hands the request to `handleMcpRequest` with the
// live service call, and returns what comes back.
//
// Mounted through the adapter registry (`@/lib/adapters`, MILESTONES.md #26)
// rather than by naming a string here. `MCP_HTTP_ADAPTER` is the registry's
// own descriptor, so this route cannot be serving an adapter the registry
// does not know about — a rename in the registry is a compile error here,
// not a silently divergent mount. §22: "the module the application mounts
// its adapters through, so the names are load-bearing at runtime rather
// than a list maintained for a test."
import { ADAPTER_REGISTRY } from "@/lib/adapters";
import { handleMcpRequest } from "@/lib/mcp/http";
import { withRehearsalUnwrapping } from "@/lib/mcp";
import { service } from "@/lib/service/live";
import { authenticate } from "@/lib/auth";
import { unauthenticatedResponse } from "../_shared/respond";

/** The registry entry this route serves. Exported so a test can assert the mount. */
export const MCP_HTTP_ADAPTER = ADAPTER_REGISTRY.mcp_http;

/**
 * Streamable HTTP is a single endpoint answering POST (a JSON-RPC message),
 * GET (the server-initiated stream) and DELETE (ending a session).
 *
 * All three are forwarded rather than filtered: a stateless server has no
 * stream to open and no session to end, so the correct answer to GET and
 * DELETE is the protocol-level refusal the transport already produces —
 * which is a better answer than a 404 from a route that declined to
 * implement them, because a client can tell "this server is stateless"
 * apart from "this endpoint does not exist".
 *
 * The call handed to the core is wrapped with `withRehearsalUnwrapping`
 * (MILESTONES.md #32) — the MCP equivalent of the transition route's own
 * `RehearsalRollback` catch, applied here because this is this transport's
 * mount point, the same way the web API does its own unwrapping in its own
 * route rather than in a shared renderer.
 */
async function serve(request: Request): Promise<Response> {
  // Authenticated here, not inside the MCP core, for the same reason the
  // web API authenticates in its own shared responder: this is the mount
  // point — the place that knows a request arrived over HTTP and carries
  // headers — and the core below it is transport-agnostic by design. A
  // token check inside the core would be a check the stdio transport, which
  // has no headers and no network, would have to be taught to skip.
  //
  // **This surface needs the gate at least as much as the routes do.** Every
  // service operation is reachable through it as a tool, so an unauthenticated
  // MCP mount is an unauthenticated copy of the entire write surface — and it
  // is the one an agent is most likely to be pointed at.
  //
  // The refusal is the same 401 envelope the rest of the API returns rather
  // than a JSON-RPC error: the request never reached the protocol layer, so
  // there is no JSON-RPC exchange to answer within, and a client that failed
  // to authenticate has a transport problem to fix, not a tool call to retry.
  const auth = authenticate(request);
  if (!auth.ok) return unauthenticatedResponse(auth.reason);

  return handleMcpRequest(
    request,
    withRehearsalUnwrapping((name, input, options) => service.call(name, input, options)),
    auth.machine.machine,
  );
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
