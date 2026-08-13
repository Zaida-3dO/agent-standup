// MCP write tools — MILESTONES.md #32 ("create, update, transition,
// complete"). `tests/mcp-server.test.ts` and `tests/mcp-adapter-mount.test.ts`
// already prove the generic derivation (#30) exposes every registered
// operation as a tool; this file covers what is specific to this row:
//
//   1. The four write operations are actually the ones registered, with the
//      annotations and schemas §18 promises for them.
//   2. `withRehearsalUnwrapping` (`@/lib/mcp/rehearsal.ts`) — the new
//      mechanism this row adds — correctly turns `transition_item`'s
//      dry-run rollback into a normal MCP success, both as a bare function
//      and driven through a real MCP client over an in-memory transport.
//
// No database here — every call below is a stub or a canned error, the
// same posture `mcp-server.test.ts` takes for its own protocol-level
// assertions. `tests/mcp-write-tools-live.test.ts` covers the same tools
// against real Postgres, including what dry_run actually does and does not
// write.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  GuardRejectedError,
  RehearsalRollback,
  getOperation,
  type TransitionOutcome,
} from "@/lib/service";
import { createMcpServer, withRehearsalUnwrapping, type ServiceCall } from "@/lib/mcp";

const WRITE_TOOL_NAMES = ["create_item", "update_item", "transition_item", "complete_item"];

/** A canned rehearsal outcome — an allowed preview, cheap to build per test. */
function allowedOutcome(overrides: Partial<TransitionOutcome> = {}): TransitionOutcome {
  return {
    itemId: "item-1",
    from: "executing",
    to: "someday",
    allowed: true,
    rehearsed: true,
    ...overrides,
  };
}

/** A rejected rehearsal outcome — the move would be refused. */
function rejectedOutcome(): TransitionOutcome {
  return {
    itemId: "item-1",
    from: "executing",
    to: "blocked",
    allowed: false,
    rehearsed: true,
    rejection: {
      code: "guard_rejected",
      guard: "blocked.requires_reason",
      message: "No.",
      fields: [],
    },
  };
}

describe("the four write operations are registered as MCP tools", () => {
  it("exists as a write operation for each of create, update, transition, complete", () => {
    for (const name of WRITE_TOOL_NAMES) {
      const operation = getOperation(name);
      expect(operation, `missing operation: ${name}`).toBeDefined();
      expect(operation?.kind).toBe("write");
    }
  });

  it("annotates all four as not read-only, over a real MCP client", async () => {
    const operations = WRITE_TOOL_NAMES.map((name) => {
      const operation = getOperation(name);
      if (!operation) throw new Error(`missing operation: ${name}`);
      return operation;
    });
    const server = createMcpServer({
      adapter: "mcp_http",
      call: async () => ({}),
      transport: "mcp-test",
      operations,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...WRITE_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(false);
    }
  });

  it("advertises transition_item's dryRun field and complete_item's summary shape", async () => {
    const transitionOp = getOperation("transition_item")!;
    const completeOp = getOperation("complete_item")!;
    const server = createMcpServer({
      adapter: "mcp_http",
      call: async () => ({}),
      transport: "mcp-test",
      operations: [transitionOp, completeOp],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const transitionTool = tools.find((tool) => tool.name === "transition_item");
    expect(transitionTool?.inputSchema.properties).toMatchObject({ dryRun: { type: "boolean" } });

    const completeTool = tools.find((tool) => tool.name === "complete_item");
    const summaryProperty = (
      completeTool?.inputSchema.properties as { summary?: { properties?: object } } | undefined
    )?.summary;
    expect(summaryProperty?.properties).toMatchObject({
      shipped: expect.anything(),
      not_done: expect.anything(),
      watch_for: expect.anything(),
    });
  });
});

describe("withRehearsalUnwrapping, as a bare function", () => {
  it("resolves a RehearsalRollback into { outcome }, the same shape the web API answers with", async () => {
    const outcome = allowedOutcome();
    const call: ServiceCall = async () => {
      throw new RehearsalRollback(outcome);
    };
    const wrapped = withRehearsalUnwrapping(call);
    await expect(
      wrapped("transition_item", { id: "item-1", to: "someday", dryRun: true }),
    ).resolves.toEqual({
      outcome,
    });
  });

  it("unwraps a rejected rehearsal outcome the same way — it is a reported answer, not an error", async () => {
    const outcome = rejectedOutcome();
    const call: ServiceCall = async () => {
      throw new RehearsalRollback(outcome);
    };
    const wrapped = withRehearsalUnwrapping(call);
    const result = await wrapped("transition_item", {});
    expect(result).toEqual({ outcome });
  });

  it("passes a normal successful result through unchanged", async () => {
    const value = { item: { id: "item-1", state: "someday" } };
    const call: ServiceCall = async () => value;
    const wrapped = withRehearsalUnwrapping(call);
    await expect(wrapped("transition_item", {})).resolves.toBe(value);
  });

  it("rethrows any other error unchanged — instance identity preserved", async () => {
    const error = new GuardRejectedError("hierarchy", "Too deep.", { fields: ["parentId"] });
    const call: ServiceCall = async () => {
      throw error;
    };
    const wrapped = withRehearsalUnwrapping(call);
    await expect(wrapped("complete_item", {})).rejects.toBe(error);
  });

  it("passes name, input and options through to the wrapped call unchanged", async () => {
    const spy = vi.fn(async () => ({ ok: true }));
    const wrapped = withRehearsalUnwrapping(spy);
    const options = { caller: { transport: "mcp-http", sessionId: "s-1" } };
    await wrapped("create_item", { title: "x" }, options);
    expect(spy).toHaveBeenCalledExactlyOnceWith("create_item", { title: "x" }, options);
  });
});

describe("withRehearsalUnwrapping, driven through a real MCP client", () => {
  async function connect(call: ServiceCall) {
    const server = createMcpServer({
      adapter: "mcp_http",
      call: withRehearsalUnwrapping(call),
      transport: "mcp-test",
      operations: [getOperation("transition_item")!],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("an allowed dry-run preview reaches the agent as a success, not an internal error", async () => {
    const outcome = allowedOutcome();
    const client = await connect(async (_name, input) => {
      const parsed = input as { dryRun?: boolean };
      if (parsed.dryRun) throw new RehearsalRollback(outcome);
      throw new Error("test only exercises the dry-run branch");
    });

    const result = await client.callTool({
      name: "transition_item",
      arguments: { id: "item-1", to: "someday", dryRun: true },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ outcome });
  });

  it("a rejected dry-run preview also reaches the agent as a success", async () => {
    const outcome = rejectedOutcome();
    const client = await connect(async () => {
      throw new RehearsalRollback(outcome);
    });

    const result = await client.callTool({
      name: "transition_item",
      arguments: { id: "item-1", to: "blocked", dryRun: true },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ outcome });
    const structured = result.structuredContent as { outcome: TransitionOutcome };
    expect(structured.outcome.allowed).toBe(false);
  });

  it("a real (non-rehearsed) transition is unaffected by the wrapper", async () => {
    const applied = { item: { id: "item-1", state: "someday" }, outcome: { rehearsed: false } };
    const client = await connect(async (_name, input) => {
      const parsed = input as { dryRun?: boolean };
      if (parsed.dryRun) throw new RehearsalRollback(allowedOutcome());
      return applied;
    });

    const result = await client.callTool({
      name: "transition_item",
      arguments: { id: "item-1", to: "someday", dryRun: false },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(applied);
  });

  it("an ordinary guard rejection during a real move still renders as an MCP error", async () => {
    // Proves the wrapper is scoped to `RehearsalRollback` alone — an
    // unrelated rejection on the very same operation must still come
    // through exactly as `mcp-server.test.ts` already proves for the
    // unwrapped core, or this wrapper would be swallowing more than it was
    // built to.
    const client = await connect(async () => {
      throw new GuardRejectedError("hierarchy", "Too deep.", { fields: ["parentId"] });
    });

    const result = await client.callTool({
      name: "transition_item",
      arguments: { id: "item-1", to: "someday", dryRun: false },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "guard_rejected",
      guard: "hierarchy",
      fields: ["parentId"],
    });
  });
});
