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
    // assertions vacuously. `backfill` refuses with `forbidden` and
    // `invalid_input` only; `get_crew_name` refuses with `invalid_input` and
    // a plain `conflict` for an exhausted pool; `readiness` takes an empty
    // input and refuses nothing at all — it runs two reads and reports
    // counts. None declares a guard.
    const permitted = new Set(["backfill", "get_crew_name", "readiness"]);
    for (const waiver of ADAPTER_WAIVERS) {
      expect(permitted).toContain(waiver.operation);
    }
  });
});

describe("isWaived / waiversFor / exposedOperations", () => {
  it("reports a waived pair and nothing else", () => {
    expect(isWaived("mcp_http", "backfill")).toBe(true);
    expect(isWaived("mcp_stdio", "backfill")).toBe(true);
    expect(isWaived("http", "backfill")).toBe(false);
    expect(isWaived("cli", "backfill")).toBe(false);
    expect(isWaived("mcp_http", "create_item")).toBe(false);
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
    expect(
      waiversFor("mcp_http")
        .map((w) => w.operation)
        .sort(),
    ).toEqual(["backfill", "get_crew_name", "readiness"]);
    expect(waiversFor("http")).toEqual([]);
  });

  it("filters a list down to what an adapter exposes", () => {
    const all = [{ name: "backfill" }, { name: "create_item" }];
    expect(exposedOperations("mcp_http", all).map((o) => o.name)).toEqual(["create_item"]);
    expect(exposedOperations("http", all).map((o) => o.name)).toEqual(["backfill", "create_item"]);
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
    expect(tools.map((t) => t.name)).toContain("create_item");
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
    expect(registered).toContain("create_item");
    expect(registered).not.toContain("backfill");
    expect(registered).not.toContain("get_crew_name");
    // Everything else the registry holds IS exposed — the waiver is one
    // named gap, not a general shrinking of the surface.
    const expected = OPERATION_NAMES.filter((name) => !isWaived("mcp_http", name));
    expect(registered.sort()).toEqual([...expected].sort());

    await server.close();
  });
});
