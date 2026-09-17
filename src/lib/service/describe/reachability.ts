// Which operations an MCP caller can actually reach.
//
// ── Why this is its own module ──────────────────────────────────────────
//
// Both definitions below need only `ADAPTER_WAIVERS` and a literal map.
// Neither reads the operation registry — and that is the property being
// protected by keeping them here.
//
// `advice.ts`, which is where they would otherwise sit, imports
// `../registry` and `../operations/search`, so importing *anything* from it
// pulls in every registered operation. `OPERATION_REGISTRY` is built from
// the imported operation objects, and several operations import
// `@/lib/surfaces` to word their own refusals. A module that wants to know
// what is reachable in order to spell an invocation therefore closes a
// cycle through the registry, and the registry initialises half-built:
// `Cannot read properties of undefined (reading 'name')` at the first entry
// whose module has not finished loading.
//
// Splitting the registry-free half out is what makes `bindings.ts` able to
// ask "is this on MCP?" without dragging in the answer to "what operations
// exist?".

import { ADAPTER_WAIVERS } from "@/lib/adapters/waivers";

/**
 * Operations no MCP adapter exposes — the tools an MCP caller cannot call.
 *
 * Derived from `ADAPTER_WAIVERS` rather than listed, for the same reason
 * the tool list itself is derived: a hand-kept copy is a second list to
 * forget, and this check exists precisely because a *change to the first
 * list* stranded advice that nothing re-read.
 *
 * **Waived on every MCP adapter, not on any.** `mcp_http` and `mcp_stdio`
 * are one surface over two transports and the waiver table sets them
 * identically, but the intersection is the honest reading: a tool one MCP
 * adapter still serves is reachable for some MCP caller, and calling that
 * unreachable would be a false positive.
 */
export function operationsOffMcp(): ReadonlySet<string> {
  const mcpAdapters = [...new Set(ADAPTER_WAIVERS.map((waiver) => waiver.adapter))].filter(
    (adapter) => adapter.startsWith("mcp"),
  );
  if (mcpAdapters.length === 0) return new Set();
  const waivedOnEvery = new Set<string>();
  for (const waiver of ADAPTER_WAIVERS) {
    if (!waiver.adapter.startsWith("mcp")) continue;
    const operation = waiver.operation;
    if (waivedOnEvery.has(operation)) continue;
    const onAll = mcpAdapters.every((adapter) =>
      ADAPTER_WAIVERS.some((other) => other.adapter === adapter && other.operation === operation),
    );
    if (onAll) waivedOnEvery.add(operation);
  }
  return waivedOnEvery;
}

/**
 * Folded tools, and the waived operations whose messages they surface.
 *
 * A fold does not reimplement its verbs — `loop` and `create_work` each
 * dispatch to the operation that already implements the action, handing
 * back *the same refusal object* it threw. So a waived operation reached
 * through a fold speaks **directly to an MCP caller**, and its summary and
 * contract rules have to satisfy this check even though the operation
 * itself is waived.
 *
 * Verified on the live wire rather than assumed: `loop {action: "delete"}`
 * with a resolution-sounding reason returns `loop_delete`'s own message,
 * "…which is `loop_close`, not `loop_delete`", naming two tools no MCP
 * caller has.
 *
 * Declared as data because there is no way to read a dispatch relationship
 * off the registry, and a checker that inferred one would be guessing.
 */
export const FOLDED_INTO: ReadonlyMap<string, string> = new Map([
  ["loop_add", "loop"],
  ["loop_get", "loop"],
  ["loop_list", "loop"],
  ["loop_edit", "loop"],
  ["loop_close", "loop"],
  ["loop_delete", "loop"],
  ["create_project", "create_work"],
  ["create_task", "create_work"],
  ["create_subtask", "create_work"],
  ["score_run", "score"],
  ["derive_run_score", "score"],
  ["accept_run_score", "score"],
  ["get_run_scores", "score"],
  ["score_intervention", "score"],
  ["get_intervention_scores", "score"],
  ["get_projects", "project"],
  ["get_project_detail", "project"],
  ["repair_stuck_projects", "project"],
  ["register_session", "session"],
  ["get_session_shape", "session"],
]);
