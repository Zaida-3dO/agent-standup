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
import { service } from "@/lib/service/live";

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
 */
async function serve(request: Request): Promise<Response> {
  return handleMcpRequest(request, (name, input, options) => service.call(name, input, options));
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
