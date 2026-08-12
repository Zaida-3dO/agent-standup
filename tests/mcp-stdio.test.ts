// MCP over stdio (MILESTONES.md #84) and the "one long-lived connection"
// half of it stdio-specific from `./mcp-http.test.ts`'s "one request, one
// connection" half.
//
// Driven by writing real newline-delimited JSON-RPC frames into a stream and
// reading real framed responses back out of another — the actual wire
// format `StdioServerTransport` speaks (`shared/stdio.js`'s
// `serializeMessage`/`ReadBuffer`) — rather than calling `serveMcpStdio`'s
// internals directly. That is what proves the wiring a real client sees,
// the same reasoning `mcp-http.test.ts`'s header gives for driving `Request`
// objects through `handleMcpRequest` instead of unit-testing its pieces.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ServiceRuntime, type TransactionHandle } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import type { ServiceCall } from "@/lib/mcp";
import { MCP_STDIO_TRANSPORT, serveMcpStdio } from "@/lib/mcp/stdio";

const PROTOCOL_VERSION = "2025-06-18";

const inertHandle: TransactionHandle = {
  $queryRawUnsafe: async <T = unknown>(): Promise<T> => [] as T,
  $executeRawUnsafe: async () => 0,
};

function realRuntimeCall(): ServiceCall {
  const runtime = new ServiceRuntime({
    transaction: (body) => body(inertHandle),
    resolveSnapshot: async () => defaultSnapshot(),
  });
  return (name, input, options) => runtime.call(name, input, options);
}

/** One stdio connection: an input frames are written to, and output they're read back from. */
interface StdioSession {
  /** Resolves once the connection has closed — the promise `serveMcpStdio` returned. */
  readonly served: Promise<void>;
  send(message: unknown): void;
  /** Waits for the JSON-RPC response carrying this id and returns its parsed body. */
  waitFor(id: number): Promise<Record<string, unknown>>;
  /** Ends the input stream — the real signal a client closing its pipe sends. */
  end(): void;
}

/** Wires a real `serveMcpStdio` connection over two in-memory streams. */
function startSession(call: ServiceCall): StdioSession {
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serveMcpStdio(call, { input, output });

  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message.id;
      if (typeof id === "number") {
        waiters.get(id)?.(message);
        waiters.delete(id);
      }
    }
  });

  return {
    served,
    send(message: unknown) {
      input.write(`${JSON.stringify(message)}\n`);
    },
    waitFor(id: number) {
      return new Promise((resolve) => {
        waiters.set(id, resolve);
      });
    },
    end() {
      input.end();
    },
  };
}

function initializeMessage(id = 1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };
}

function callToolMessage(name: string, args: unknown, id: number) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

describe("the stdio wiring answers a real MCP conversation", () => {
  it("initialises and reports the tools capability", async () => {
    const session = startSession(realRuntimeCall());
    session.send(initializeMessage(1));
    const response = await session.waitFor(1);
    const result = response.result as { capabilities: Record<string, unknown> };
    expect(result.capabilities).toHaveProperty("tools");
    session.end();
    await session.served;
  });

  it("lists the tools the core derived, over stdio", async () => {
    const session = startSession(realRuntimeCall());
    session.send(initializeMessage(1));
    await session.waitFor(1);
    session.send({ jsonrpc: "2.0" as const, id: 2, method: "tools/list", params: {} });
    const response = await session.waitFor(2);
    const result = response.result as { tools: { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toContain("service_info");
    session.end();
    await session.served;
  });

  it("calls a tool and returns the service's answer", async () => {
    const session = startSession(realRuntimeCall());
    session.send(initializeMessage(1));
    await session.waitFor(1);
    session.send(callToolMessage("service_info", {}, 2));
    const response = await session.waitFor(2);
    const result = response.result as {
      isError?: boolean;
      structuredContent: { operations: unknown[] };
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.operations.length).toBeGreaterThan(0);
    session.end();
    await session.served;
  });

  it("stamps mcp-stdio as the transport on a call arriving this way", async () => {
    // The value that has to differ from `mcp-http.test.ts`'s equivalent
    // assertion — the one thing this wiring alone decides (`./server.ts`
    // takes `transport` as a required parameter with no default; see
    // `tests/mcp-transport-agnostic.test.ts`).
    const stamped: (string | undefined)[] = [];
    const call: ServiceCall = async (_name, _input, options) => {
      stamped.push(options?.caller?.transport);
      return {};
    };
    const session = startSession(call);
    session.send(initializeMessage(1));
    await session.waitFor(1);
    session.send(callToolMessage("service_info", {}, 2));
    await session.waitFor(2);
    expect(stamped).toEqual([MCP_STDIO_TRANSPORT]);
    expect(MCP_STDIO_TRANSPORT).toBe("mcp-stdio");
    session.end();
    await session.served;
  });

  it("renders a service rejection with its code and fields over stdio too", async () => {
    const session = startSession(realRuntimeCall());
    session.send(initializeMessage(1));
    await session.waitFor(1);
    session.send(callToolMessage("service_info", { kind: "sideways" }, 2));
    const response = await session.waitFor(2);
    const result = response.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "invalid_input", fields: ["kind"] });
    session.end();
    await session.served;
  });
});

describe("one long-lived connection, not one per call", () => {
  it("answers a second, independent call on the same connection with no re-initialise", async () => {
    // The property this file exists to prove that `mcp-http.test.ts` proves
    // the opposite of: HTTP builds a fresh server and transport per request
    // (its "stateless" describe block); stdio keeps the one from
    // `initialize` for every later call. Two calls, one connection, one
    // `initialize`.
    const session = startSession(realRuntimeCall());
    session.send(initializeMessage(1));
    await session.waitFor(1);

    session.send(callToolMessage("service_info", { kind: "read" }, 2));
    const first = await session.waitFor(2);
    session.send(callToolMessage("service_info", { kind: "write" }, 3));
    const second = await session.waitFor(3);

    const firstOps = (first.result as { structuredContent: { operations: { kind: string }[] } })
      .structuredContent.operations;
    const secondOps = (second.result as { structuredContent: { operations: { kind: string }[] } })
      .structuredContent.operations;
    expect(firstOps.length).toBeGreaterThan(0);
    expect(secondOps.length).toBeGreaterThan(0);
    expect(firstOps.every((operation) => operation.kind === "read")).toBe(true);
    expect(secondOps.every((operation) => operation.kind === "write")).toBe(true);

    session.end();
    await session.served;
  });
});

describe("the connection ends when input ends, not before and not never", () => {
  it("resolves `serveMcpStdio` once the input stream ends", async () => {
    const session = startSession(realRuntimeCall());
    session.send(initializeMessage(1));
    await session.waitFor(1);
    session.end();
    // If `served` never resolved, this `await` would hang until the test's
    // own timeout — the failure mode a mutant deleting the `input.once`
    // wiring in `stdio.ts` produces.
    await session.served;
  });

  it("does not resolve while input is still open, mid-conversation", async () => {
    // The other half of the same claim, and the one a test that only
    // awaited `served` after calling `.end()` (every test above does) could
    // never catch: a version of `serveMcpStdio` that resolved as soon as
    // the *first* message was handled, rather than when input ends, would
    // pass every test above and only fail here.
    const session = startSession(realRuntimeCall());
    let settled = false;
    void session.served.then(() => {
      settled = true;
    });

    session.send(initializeMessage(1));
    await session.waitFor(1);
    session.send(callToolMessage("service_info", {}, 2));
    await session.waitFor(2);
    // Give any stray microtask/macrotask a real chance to run before
    // asserting the negative, so this is not passing by accident of timing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    session.end();
    await session.served;
    expect(settled).toBe(true);
  });
});
