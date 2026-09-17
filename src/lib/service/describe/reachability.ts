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
  ["get_item_detail", "get_item"],
  ["get_item_body", "read_item"],
  ["get_item_history", "read_item"],
  ["get_item_artifacts", "read_item"],
  ["claim", "ownership"],
  ["release", "ownership"],
  ["takeover", "ownership"],
]);

/**
 * Whether an MCP caller can reach `operation` at all — directly, or through
 * the tool it was folded into.
 *
 * ── The invariant this expresses ───────────────────────────────────────
 *
 * `tests/adapter-waivers.test.ts` protects a class of mistake §22's own
 * bound cannot see: a waiver that is legal — no guard loses coverage — and
 * still wrong, because it removes the one surface an agent was *told to
 * use*. `guard.response_too_large` refuses `get_item_detail` and its advice
 * names `get_item_history` and `get_item_artifacts` as the way to reach
 * that item's notes and artifacts. Waive those off MCP and a refusal
 * prescribes a remedy the refused caller cannot perform. It is not
 * hypothetical: two sessions hit exactly that dead end, one tried six
 * routes and found nothing, another lost a spec it had written into a note.
 *
 * That invariant was written as `isWaived(...) === false`, and while every
 * remedy was its own tool the two were the same statement. **They are not
 * the same statement once folds exist.** What has to be true is that the
 * CAPABILITY is reachable; non-waiver of a NAME was only ever the way to
 * say so. A remedy folded into an exposed tool is still reachable — the
 * fold dispatches to the operation that implements it and hands back its
 * refusal object unedited — and its spelling moves with it, because
 * `advice.ts`'s `unreachable` class fails the build on advice naming a tool
 * the caller cannot call.
 *
 * **Stated honestly, this is a TRADE rather than a strict superset of the
 * name test.** Over the space of (waived?, folded?, target reachable?):
 *
 *   - exposed, not folded — both pass. Equal.
 *   - waived, not folded — both fail. Equal.
 *   - waived, folded into an EXPOSED tool — the name test fails, this
 *     passes. **A loosening, and it is conceded**: it is precisely the case
 *     the `read_item` fold is, and the only way that fold can ship.
 *   - waived, folded into a WAIVED tool — both fail, but this one fails for
 *     the right reason rather than by coincidence.
 *   - waived, folded into a tool that does not exist, or a fold chain whose
 *     terminal tool is waived — the name test PASSED both (it never
 *     consulted `FOLDED_INTO` at all); this fails. **Two strengthenings.**
 *
 * The conceded case is closed by a second assertion rather than by claiming
 * it away: `tests/adapter-waivers.test.ts` cross-checks `FOLDED_INTO`
 * against `FOLD_ACTIONS` so a fold cannot be a valid target while declaring
 * no action that reaches what it folds, and
 * `tests/fold-forwarding-names.test.ts` OBSERVES each fold reaching each
 * delegate. Without those, this function trusts a name-to-name map: an
 * operation could be "reachable" through a fold that has no action for it.
 *
 * Recursive so a fold chain resolves to what a caller actually holds. A
 * cycle would not terminate, and cannot arise from a correct table — so it
 * is guarded rather than trusted, and reports unreachable, the conservative
 * answer, rather than hanging the build.
 */
export function reachableOnMcp(operation: string): boolean {
  const offMcp = operationsOffMcp();
  const seen = new Set<string>();
  let current = operation;
  for (;;) {
    if (seen.has(current)) return false;
    seen.add(current);
    const folded = FOLDED_INTO.get(current);
    if (folded === undefined) return !offMcp.has(current);
    current = folded;
  }
}
