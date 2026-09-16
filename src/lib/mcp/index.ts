// The MCP adapter's public surface (MILESTONES.md #30).
//
// Split deliberately, and the split is the point of the row: `./server.ts`
// and `./tools.ts` are the transport-agnostic core — the same modules #84's
// stdio wiring imports — while `./http.ts` is one transport's wiring. A
// consumer that wants the core imports it from here without dragging HTTP
// in behind it, because the core's own import graph contains none.
export {
  MCP_SERVER_INFO,
  callTool,
  createMcpServer,
  type McpCallerIdentity,
  type McpServerOptions,
  type ServiceCall,
} from "./server";

export { advertisedSchema, toolsFromOperations, type McpToolDescriptor } from "./tools";

export { toolRejection, toolSuccess, type RenderedRejection, type ToolResult } from "./result";

// Deliberately absent: any helper for unwrapping `transition_item`'s
// dry-run rollback (MILESTONES.md #32). That sentinel is caught in the
// service runtime, at the one seam every adapter crosses
// (`../service/runtime.ts`), so an MCP mount has no rehearsal concern and
// there is nothing here for one to remember to apply. A per-mount wrapper
// exported from this module would reintroduce exactly the obligation the
// runtime exists to remove.

// Not re-exported here: `./http.ts` or `./stdio.ts`. Each is one transport's
// wiring, and a module importing the core should not acquire a dependency on
// streamable HTTP or stdio by doing so — the same reasoning `../service/index.ts`
// gives for keeping `live.ts` out of its own re-exports. The route handler
// and the `standup mcp` command import them by name, and a reviewer sees
// that in the diff.
