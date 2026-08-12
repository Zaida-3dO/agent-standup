// The MCP server core. See MILESTONES.md #30 ("a transport-agnostic server
// core — tool registration and handlers calling the service layer") and #84
// ("MCP over stdio, wiring the same transport-agnostic server core").
//
// ── Transport-agnostic, and what that means concretely ──────────────────
//
// This module builds a server and registers its tools. It never decides how
// a message arrives. Concretely, that means **nothing here mentions a
// request, a response, a status code, a header, a socket or a stream** —
// there is no `Request`, no `Response`, no `IncomingMessage`, no `Headers`,
// and no import from any `*StreamableHTTP*` or `*Stdio*` module. What it
// returns is an `McpServer`, which speaks to whatever `Transport` is later
// connected to it.
//
// That is not a stylistic preference; it is the whole reason #84 is a small
// row rather than a second implementation. `createMcpServer` is called
// identically by `./http.ts` (which connects a streamable-HTTP transport)
// and by whatever stdio wiring #84 adds (which connects a stdio transport).
// Neither of them touches a handler, because a handler cannot tell them
// apart. `tests/mcp-transport-agnostic.test.ts` asserts this structurally
// against this file's source, rather than trusting the comment.
//
// ── Thin shell over a service call ──────────────────────────────────────
//
// CLAUDE.md: "Every adapter is a thin shell over a service call. No adapter
// may reach the database or a guard directly." Every tool handler below does
// exactly three things — take the arguments, call one service operation,
// render the outcome. It opens no transaction, resolves no settings, and
// imports no database client; the service caller arrives as a parameter, so
// this module has no way to construct one even if a handler wanted to.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listOperations, type AnyOperation } from "@/lib/service";
import { toolRejection, toolSuccess, type ToolResult } from "./result";
import { advertisedSchema, toolsFromOperations } from "./tools";

/**
 * The one thing this adapter needs from the service layer.
 *
 * A function, not the `ServiceRuntime` class, so the core depends on the
 * *shape* of a service call rather than on the composition root that
 * happens to provide one. That is what lets a test drive the whole server
 * against a stub without a database, and what keeps `live.ts` — the only
 * module that reaches the database client — out of this file's import
 * graph entirely.
 */
export type ServiceCall = (
  name: string,
  input: unknown,
  options?: { caller?: { transport?: string; sessionId?: string; actor?: string } },
) => Promise<unknown>;

export interface McpServerOptions {
  /** How this core reaches the rules. The only capability it is given. */
  readonly call: ServiceCall;
  /**
   * The value stamped on `ServiceContext.caller.transport` for every call
   * made through this server.
   *
   * Supplied by the *wiring*, not chosen here, because it is the one thing
   * that genuinely differs between #30's HTTP binding and #84's stdio one
   * (`mcp-http` and `mcp-stdio`, SCHEMA.md §21's five transport values).
   * Passing it in is what keeps the rest of this module identical for both
   * — the alternative, branching on a transport inside a handler, is
   * exactly the shape that makes a core stop being transport-agnostic.
   */
  readonly transport: string;
  /** The operations to expose. Defaults to every registered one. */
  readonly operations?: readonly AnyOperation[];
  /** Reported on `initialize`. */
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

/** What this server calls itself when a client asks. */
export const MCP_SERVER_INFO = { name: "agent-standup", version: "0.1.0" } as const;

/**
 * Builds the MCP server, with one tool per service operation.
 *
 * **Tools are derived, not listed.** The default operation set is
 * `listOperations()` — the canonical registry — so this adapter's surface is
 * a function of the service layer's, and an operation cannot be present in
 * one and absent from the other. There is no hand-maintained tool table to
 * fall out of step, which is what #94's completeness assertion needs to be
 * true rather than merely intended.
 *
 * The returned server is **not connected to anything**. Connecting it is the
 * transport's job, and doing it here is precisely the coupling this row
 * exists to avoid.
 */
export function createMcpServer({
  call,
  transport,
  operations = listOperations(),
  serverInfo = MCP_SERVER_INFO,
}: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: serverInfo.name, version: serverInfo.version },
    { capabilities: { tools: {} } },
  );

  for (const tool of toolsFromOperations(operations)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The operation's own schema, wrapped so the SDK advertises it but
        // never rejects with it — see `advertisedSchema`'s comment. The
        // rejection has to come from the service layer, or MCP's refusal
        // of a bad input would not match the web API's for the same call.
        inputSchema: advertisedSchema(tool.inputSchema),
        annotations: { readOnlyHint: tool.readOnly },
      },
      async (args: unknown): Promise<ToolResult> => callTool(call, transport, tool.name, args),
    );
  }

  return server;
}

/**
 * One tool call: hand the arguments to the service, render what comes back.
 *
 * Exported so a test can exercise the shell without a protocol round trip,
 * and because it is the honest statement of what this adapter *is* — three
 * lines with no rule in them. Every refusal, including an unregistered
 * operation name, is produced by the service and rendered unedited; nothing
 * here decides whether a call is allowed.
 */
export async function callTool(
  call: ServiceCall,
  transport: string,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  try {
    return toolSuccess(await call(name, args, { caller: { transport } }));
  } catch (error) {
    return toolRejection(error);
  }
}
