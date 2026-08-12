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
  type McpServerOptions,
  type ServiceCall,
} from "./server";

export { advertisedSchema, toolsFromOperations, type McpToolDescriptor } from "./tools";

export { toolRejection, toolSuccess, type RenderedRejection, type ToolResult } from "./result";

// MILESTONES.md #32: unwraps `transition_item`'s dry-run rollback into a
// normal successful result, for whichever mount point needs it.
export { withRehearsalUnwrapping } from "./rehearsal";

// Not re-exported here: `./http.ts`. It is one transport's wiring, and a
// module importing the core should not acquire a dependency on streamable
// HTTP by doing so — the same reasoning `../service/index.ts` gives for
// keeping `live.ts` out of its own re-exports. The route handler imports it
// by name, and a reviewer sees that in the diff.
