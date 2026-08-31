// Adapter waivers (SCHEMA.md §22's fourth conformance assertion).
//
// A waiver is a deliberate gap in an adapter's surface. These tests are what
// make it *bounded*: that it names a real adapter and a real operation, that
// it carries an argument rather than a shrug, and that the operation it
// waives is one §22's rule actually permits to be waived.
import { describe, expect, it } from "vitest";
import { ADAPTER_NAMES } from "@/lib/adapters/registry";
import {
  ADAPTER_WAIVERS,
  exposedOperations,
  isWaived,
  waiversFor,
  waiversNameRegisteredAdapters,
} from "@/lib/adapters/waivers";
import { listOperations, OPERATION_NAMES } from "@/lib/service";
import { createMcpServer } from "@/lib/mcp/server";
import { toolsFromOperations } from "@/lib/mcp/tools";

describe("the waiver list", () => {
  it("names only registered adapters", () => {
    expect(waiversNameRegisteredAdapters()).toBe(true);
    for (const waiver of ADAPTER_WAIVERS) {
      expect(ADAPTER_NAMES).toContain(waiver.adapter);
    }
  });

  it("names only registered operations — a waiver for nothing is a stale waiver", () => {
    for (const waiver of ADAPTER_WAIVERS) {
      expect(OPERATION_NAMES).toContain(waiver.operation);
    }
  });

  it("carries a real reason on every entry, not a placeholder", () => {
    // §22: waivers "live in one reviewed file with a reason each". A reason
    // short enough to be a shrug is not one.
    for (const waiver of ADAPTER_WAIVERS) {
      expect(waiver.reason.length).toBeGreaterThan(40);
    }
  });

  it("waives no operation a registered guard can reject — §22's bound", () => {
    // The bound exists so an adapter cannot decline to expose the
    // operations that are hard to get right and then pass the comparison
    // assertions vacuously.
    //
    // Derived rather than hand-listed. A permit list naming each waived
    // operation grows with the waiver list and is maintained by the same
    // edit, so it stops being independent evidence the moment the list is
    // long — it becomes a second copy of the thing it checks, and the
    // honest way to satisfy it is to append to both. What actually bounds
    // a waiver is *structural*: a registered guard runs only inside the
    // state machine's `runGuards`, and the only *registered operations*
    // that reach it are the two below. (`rehearsal-rollback.ts` also calls
    // the transition path but declares no operation, so no adapter can
    // expose or waive it.) An operation that cannot reach a transition
    // cannot be refused by a guard, so waiving it loses no guard-coverage
    // case — which is exactly what §22's bound protects.
    //
    // Adding a third guard-running operation and waiving it from MCP
    // fails here, which is the behaviour being bought.
    const GUARD_RUNNING_OPERATIONS = new Set(["transition_item", "complete_item"]);
    for (const waiver of ADAPTER_WAIVERS) {
      expect(GUARD_RUNNING_OPERATIONS.has(waiver.operation)).toBe(false);
    }
  });

  it("waives nothing that is an agent's only route to a documented remediation", () => {
    // A waiver is legal under §22 and still wrong if it removes the one
    // surface an agent was told to use. The kill guard refuses a
    // machine-wide kill and its refusal text names `register_process` as
    // the way to make the call succeed (`@/lib/kill/ownership`); the
    // other two process operations are how that registry is read and
    // closed. Waiving any of them from MCP would leave a refusal message
    // pointing at a tool the refused agent cannot call.
    const AGENT_REMEDIATION_OPERATIONS = ["register_process", "end_process", "list_processes"];
    for (const operation of AGENT_REMEDIATION_OPERATIONS) {
      expect(isWaived("mcp_http", operation)).toBe(false);
      expect(isWaived("mcp_stdio", operation)).toBe(false);
    }
  });
});

describe("isWaived / waiversFor / exposedOperations", () => {
  it("reports a waived pair and nothing else", () => {
    expect(isWaived("mcp_http", "backfill")).toBe(true);
    expect(isWaived("mcp_stdio", "backfill")).toBe(true);
    expect(isWaived("http", "backfill")).toBe(false);
    expect(isWaived("cli", "backfill")).toBe(false);
    // `checkpoint` is the sentinel for "still exposed": it is one of the
    // most-called agent-facing tools and is deliberately not waived. It took
    // this role from `create_task`, which is now reached through the folded
    // `create_work` tool and waived off MCP with the other two creates — a
    // sentinel has to be a tool no planned fold will ever touch, or it stops
    // being a positive control and becomes another thing to edit.
    expect(isWaived("mcp_http", "checkpoint")).toBe(false);
    expect(isWaived("mcp_stdio", "checkpoint")).toBe(false);
    expect(isWaived("mcp_http", "create_item")).toBe(true);
    // The folded-away creates and loop verbs are waived on MCP only.
    expect(isWaived("mcp_http", "create_task")).toBe(true);
    expect(isWaived("mcp_http", "loop_add")).toBe(true);
    expect(isWaived("http", "create_task")).toBe(false);
    expect(isWaived("cli", "loop_add")).toBe(false);
    expect(isWaived("mcp_http", "get_crew_name")).toBe(true);
    expect(isWaived("mcp_stdio", "get_crew_name")).toBe(true);
    expect(isWaived("http", "get_crew_name")).toBe(false);
    expect(isWaived("cli", "get_crew_name")).toBe(false);
    // Readiness is an infrastructure probe, not an agent tool: waived from
    // both MCP surfaces, exposed on the two that cost nothing per session.
    expect(isWaived("mcp_http", "readiness")).toBe(true);
    expect(isWaived("mcp_stdio", "readiness")).toBe(true);
    expect(isWaived("http", "readiness")).toBe(false);
    expect(isWaived("cli", "readiness")).toBe(false);
  });

  it("groups waivers by adapter", () => {
    const mcpHttpWaived = waiversFor("mcp_http").map((w) => w.operation);
    // Grouping is what is under test, so: every entry returned is for this
    // adapter, the originals are still in it, and no operation is listed
    // twice — a duplicate would quietly double-count the surface reduction.
    for (const waiver of waiversFor("mcp_http")) expect(waiver.adapter).toBe("mcp_http");
    expect(mcpHttpWaived).toEqual(
      expect.arrayContaining(["backfill", "get_crew_name", "readiness"]),
    );
    expect(new Set(mcpHttpWaived).size).toBe(mcpHttpWaived.length);
    expect(waiversFor("mcp_http").length).toBe(waiversFor("mcp_stdio").length);
    expect(waiversFor("http")).toEqual([]);
  });

  it("filters a list down to what an adapter exposes", () => {
    const all = [{ name: "backfill" }, { name: "checkpoint" }];
    expect(exposedOperations("mcp_http", all).map((o) => o.name)).toEqual(["checkpoint"]);
    expect(exposedOperations("http", all).map((o) => o.name)).toEqual(["backfill", "checkpoint"]);
  });
});

describe("the MCP adapter honours its waiver", () => {
  it("does NOT advertise backfill or get_crew_name as a tool", async () => {
    // The whole reason for the waiver: an MCP tool list is sent to the
    // model on every session, so a one-shot bulk-import tool would spend
    // context permanently to be callable for minutes. Removing the filter
    // in createMcpServer puts it straight back into the list. `get_crew_name`
    // is waived for a different reason (naming is now a side effect of
    // register_session/claim), same mechanism.
    const tools = toolsFromOperations(exposedOperations("mcp_http", listOperations()));
    expect(tools.map((t) => t.name)).not.toContain("backfill");
    expect(tools.map((t) => t.name)).not.toContain("get_crew_name");
    expect(tools.map((t) => t.name)).toContain("checkpoint");
    // The folded tools are the ones MCP exposes: one loop tool with an
    // action field, one create tool with a required type field.
    expect(tools.map((t) => t.name)).toContain("create_work");
    expect(tools.map((t) => t.name)).toContain("loop");
    expect(tools.map((t) => t.name)).not.toContain("create_task");
    expect(tools.map((t) => t.name)).not.toContain("loop_add");
  });

  it("builds a server whose registered tools exclude the waived operation", async () => {
    // Reads the tools the SDK actually holds, rather than recomputing the
    // list this test is supposed to be checking. Deleting the
    // `exposedOperations` call in createMcpServer's default puts `backfill`
    // back into this set and fails here.
    const server = createMcpServer({
      call: async () => ({}),
      transport: "mcp-http",
      adapter: "mcp_http",
    });
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );

    expect(registered.length).toBeGreaterThan(0);
    expect(registered).toContain("checkpoint");
    expect(registered).toContain("create_work");
    expect(registered).toContain("loop");
    expect(registered).not.toContain("backfill");
    expect(registered).not.toContain("get_crew_name");
    // Everything else the registry holds IS exposed — the waiver is one
    // named gap, not a general shrinking of the surface.
    const expected = OPERATION_NAMES.filter((name) => !isWaived("mcp_http", name));
    expect(registered.sort()).toEqual([...expected].sort());

    await server.close();
  });
});
