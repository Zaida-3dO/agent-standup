// The size and shape of the MCP tool surface, asserted rather than typed.
//
// ── Why a test owns this number ─────────────────────────────────────────
//
// An MCP tool list is sent to the model on every session, so the size of
// this surface is a real cost and a number worth stating. A number stated in
// prose drifts the moment anyone adds or waives a tool, and a headline that
// double-counted a saving has already shipped in this lineage once.
//
// So the count is DERIVED from the adapter's own exposed list — the same
// call the adapter makes to decide what to advertise — and the documentation
// is pointed here rather than carrying a figure of its own. A doc that names
// no number cannot state a wrong one; a test that derives the number cannot
// disagree with the surface it measures.
//
// **This test will fail when the surface changes, and that is the point.**
// It is not a nuisance to be updated reflexively: a change in this number is
// a change in what every session pays for, so it should be a deliberate edit
// with a reason in its commit message. Update the constant and say why.
import { describe, expect, it } from "vitest";

import { listOperations, OPERATION_NAMES } from "@/lib/service";
import { exposedOperations, isWaived } from "@/lib/adapters/waivers";
import { ADAPTER_NAMES } from "@/lib/adapters/registry";
import { FOLDED_INTO } from "@/lib/service/describe/reachability";

/**
 * How many tools an MCP caller is offered.
 *
 * Reached by folding the scoring, project, session, create, loop, read,
 * record and ownership verbs into tools that take an `action`, and waiving
 * the verbs themselves off MCP alone — every one of them stays reachable on
 * HTTP, on the command line, and through the tool it was folded into.
 */
const EXPECTED_MCP_TOOL_COUNT = 28;

/** The tools an MCP caller is actually offered, derived from the waiver table. */
function mcpTools(): string[] {
  return exposedOperations("mcp_http", listOperations())
    .map((operation) => operation.name)
    .sort();
}

describe("the MCP tool surface", () => {
  it("offers exactly the number of tools the documentation points at", () => {
    const tools = mcpTools();
    // Named in the failure, so a run that goes red says WHICH tools are on
    // the surface rather than only that a number moved. Reading that list is
    // usually the whole diagnosis.
    expect(tools.length, `tools on MCP: ${tools.join(", ")}`).toBe(EXPECTED_MCP_TOOL_COUNT);
  });

  it("offers the same surface over both MCP transports", () => {
    // One MCP surface, two transports. A waiver applied to one and not the
    // other leaves a tool reachable for some callers and not others, which
    // is the state every fold's waiver reason claims is not happening.
    const stdio = exposedOperations("mcp_stdio", listOperations())
      .map((operation) => operation.name)
      .sort();
    expect(stdio).toEqual(mcpTools());
  });

  it("exposes every fold target it folds something into", () => {
    // The count is only honest if the tools the folded verbs were folded
    // INTO are themselves on the surface. A target waived off MCP would make
    // every operation folded into it unreachable while the count looked
    // unchanged — smaller AND broken, which is the failure mode a bare
    // number cannot distinguish from success.
    expect(FOLDED_INTO.size).toBeGreaterThan(0);
    const tools = new Set(mcpTools());
    for (const target of new Set(FOLDED_INTO.values())) {
      expect(tools.has(target), `${target} folds something but is not on MCP`).toBe(true);
    }
  });

  it("keeps every folded verb reachable somewhere other than MCP", () => {
    // The other half of the honesty check, and the one that separates a
    // narrowed tool list from a removed capability. Every operation folded
    // off MCP must still be exposed by an adapter that is not MCP.
    const nonMcp = ADAPTER_NAMES.filter((adapter) => !adapter.startsWith("mcp"));
    expect(nonMcp.length).toBeGreaterThan(0);
    for (const folded of FOLDED_INTO.keys()) {
      expect(OPERATION_NAMES, `${folded} is folded but not registered`).toContain(folded);
      const reachable = nonMcp.some((adapter) => !isWaived(adapter, folded));
      expect(reachable, `${folded} is waived off MCP and off every other adapter too`).toBe(true);
    }
  });
});
