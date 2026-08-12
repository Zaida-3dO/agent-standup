// The MCP server core (MILESTONES.md #30).
//
// Driven through a real MCP client over an in-memory transport pair, not by
// calling the handlers directly, so what these tests exercise is the wiring
// a client actually sees — `tools/list`, `tools/call`, and the protocol's
// own framing — rather than a function the protocol might never reach.
//
// The in-memory transport is also the demonstration that the core is
// transport-agnostic in the only way that matters operationally: it is a
// third transport, neither HTTP nor stdio, and the core is connected to it
// without a line of the core changing.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConflictError,
  GuardRejectedError,
  InvalidInputError,
  OPERATION_NAMES,
  ServiceRuntime,
  defineOperation,
  listOperations,
  type TransactionHandle,
} from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { callTool, createMcpServer, type ServiceCall } from "@/lib/mcp";

/** A transaction handle that answers nothing — no test here issues a query. */
const inertHandle: TransactionHandle = {
  $queryRawUnsafe: async <T = unknown>(): Promise<T> => [] as T,
  $executeRawUnsafe: async () => 0,
};

/** The real runtime, over a stub transaction — no database, real dispatch. */
function realRuntimeCall(): ServiceCall {
  const runtime = new ServiceRuntime({
    transaction: (body) => body(inertHandle),
    resolveSnapshot: async () => defaultSnapshot(),
  });
  return (name, input, options) => runtime.call(name, input, options);
}

/** Connects a client to a server built over `call`, and returns the client. */
async function connect(
  call: ServiceCall,
  options: { transport?: string; operations?: ReturnType<typeof listOperations> } = {},
): Promise<Client> {
  const server = createMcpServer({
    call,
    transport: options.transport ?? "mcp-test",
    ...(options.operations ? { operations: options.operations } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("tools are derived from the operation registry", () => {
  let client: Client;

  beforeEach(async () => {
    client = await connect(realRuntimeCall());
  });

  it("exposes exactly one tool per registered operation", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it("takes each tool's description from the operation's own summary", async () => {
    const { tools } = await client.listTools();
    // Not a re-derivation of the tool list: the expectation comes from the
    // service layer's operations, which is a different object than the
    // adapter built its tools from at the call site above.
    for (const operation of listOperations()) {
      const tool = tools.find((candidate) => candidate.name === operation.name);
      expect(tool).toBeDefined();
      expect(tool?.description).toBe(operation.summary);
    }
  });

  it("advertises each operation's real input schema, not an empty one", async () => {
    const { tools } = await client.listTools();
    const serviceInfo = tools.find((tool) => tool.name === "service_info");
    // `service_info` declares `kind?: "read" | "write"`. An advertised
    // schema that had lost the shape — the failure `.catch()` would cause
    // if it wrapped the schema in something opaque — would show up here as
    // a bare `{ type: "object" }` with no properties.
    expect(serviceInfo?.inputSchema.properties).toMatchObject({
      kind: { enum: ["read", "write"] },
    });
  });

  it("annotates read operations read-only and write operations not", async () => {
    const { tools } = await client.listTools();
    for (const operation of listOperations()) {
      const tool = tools.find((candidate) => candidate.name === operation.name);
      expect(tool?.annotations?.readOnlyHint).toBe(operation.kind === "read");
    }
    // Both arms have to be represented or the assertion above is one-sided.
    const kinds = new Set(listOperations().map((operation) => operation.kind));
    expect([...kinds].sort()).toEqual(["read", "write"]);
  });

  it("exposes only the operations it was given, when given a subset", async () => {
    // Proves the derivation reads its input rather than reaching for the
    // registry regardless — the failure that would make the "derived, not
    // listed" claim unfalsifiable.
    const only = listOperations().filter((operation) => operation.name === "service_info");
    const subsetClient = await connect(realRuntimeCall(), { operations: only });
    const { tools } = await subsetClient.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["service_info"]);
  });
});

describe("a tool call is a service call", () => {
  it("returns what the service returned", async () => {
    const client = await connect(realRuntimeCall());
    const result = await client.callTool({ name: "service_info", arguments: {} });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { operations: unknown[] };
    expect(structured.operations.length).toBe(OPERATION_NAMES.length);
  });

  it("passes the arguments through to the service unchanged", async () => {
    const seen: { name: string; input: unknown }[] = [];
    const client = await connect(async (name, input) => {
      seen.push({ name, input });
      return { ok: true };
    });
    await client.callTool({ name: "service_info", arguments: { kind: "write" } });
    expect(seen).toEqual([{ name: "service_info", input: { kind: "write" } }]);
  });

  it("stamps the transport it was configured with on every call", async () => {
    // §21's five transport values: an adapter stamps it, an operation never
    // guesses. The value comes from the wiring, which is what lets #84's
    // stdio binding stamp `mcp-stdio` through this same core.
    const stamped: (string | undefined)[] = [];
    const client = await connect(
      async (_name, _input, options) => {
        stamped.push(options?.caller?.transport);
        return {};
      },
      { transport: "mcp-stdio" },
    );
    await client.callTool({ name: "service_info", arguments: {} });
    expect(stamped).toEqual(["mcp-stdio"]);
  });
});

describe("rejections arrive with the service's own code and fields", () => {
  it("renders an invalid input as the service refused it, not as the SDK would", async () => {
    // The load-bearing one. The MCP SDK validates a declared `inputSchema`
    // before the handler runs and throws its own error, which carries no
    // code and no fields — so if `advertisedSchema` stopped suppressing
    // that validation, this rejection would lose exactly the two things
    // §22's first conformance assertion compares.
    const client = await connect(realRuntimeCall());
    const result = await client.callTool({
      name: "service_info",
      arguments: { kind: "sideways" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "invalid_input",
      fields: ["kind"],
    });
  });

  it("reports an unregistered tool name as the service's not_found", async () => {
    const client = await connect(realRuntimeCall());
    // Registered tools are derived from the registry, so an unknown name
    // never reaches the service through `tools/call` — the SDK refuses it
    // first, at the protocol level, which is the correct layer for "no such
    // tool". Recorded here as the observed behaviour so that a change to it
    // is visible rather than silently absorbed.
    const viaProtocol = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(viaProtocol.isError).toBe(true);

    // The shell's own path for the same condition: when the name does reach
    // the service — which is how #84's stdio wiring and #94's drivers can
    // call it — the refusal is the service's `not_found`, with a code a
    // conformance driver can compare.
    const direct = await callTool(realRuntimeCall(), "mcp-test", "no_such_tool", {});
    expect(direct.isError).toBe(true);
    expect(direct.structuredContent).toMatchObject({ code: "not_found" });
  });

  it.each([
    ["guard_rejected", new GuardRejectedError("some_rule", "Refused.", { fields: ["state"] })],
    ["conflict", new ConflictError("Held by someone else.", { fields: ["itemId"] })],
    ["invalid_input", new InvalidInputError("No.", { fields: ["title"] })],
  ])("preserves a %s refusal verbatim", async (code, error) => {
    const client = await connect(async () => {
      throw error;
    });
    const result = await client.callTool({ name: "service_info", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code, fields: error.fields });
  });

  it("keeps the guard identifier, which conformance computes coverage from", async () => {
    // §22's third assertion is computed from the `guard` the service
    // returned. An adapter that dropped it would make that assertion
    // unsatisfiable while every happy-path test still passed.
    const client = await connect(async () => {
      throw new GuardRejectedError("hierarchy", "Too deep.", { fields: ["parentId"] });
    });
    const result = await client.callTool({ name: "service_info", arguments: {} });
    expect(result.structuredContent).toMatchObject({ guard: "hierarchy" });
  });

  it("turns an unexpected throw into internal without leaking its message", async () => {
    const client = await connect(async () => {
      // An invented driver message, in the shape a real one takes — the
      // point is that whatever a driver puts in here must not survive to
      // the caller, so it has to look like something that would matter.
      throw new Error("connect ECONNREFUSED db-host.invalid:5432");
    });
    const result = await client.callTool({ name: "service_info", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "internal" });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });
});

describe("the core reaches no rule of its own", () => {
  it("makes no service call the caller did not ask for", async () => {
    // A thin shell calls one operation, once. An adapter that resolved a
    // setting, checked a guard or pre-flighted anything would show up here
    // as a second call.
    const calls: string[] = [];
    const client = await connect(async (name) => {
      calls.push(name);
      return {};
    });
    await client.callTool({ name: "service_info", arguments: {} });
    expect(calls).toEqual(["service_info"]);
  });

  it("refuses an operation the registry does not have, even when handed one", async () => {
    // The registry is canonical *through* this adapter too: an operation
    // object that is valid but unregistered is exposed as a tool (the
    // adapter was told to expose it) and still cannot be called, because
    // the service refuses a name it does not have. The adapter contains no
    // second dispatch table that could disagree.
    const orphan = defineOperation({
      name: "mcp_orphan",
      kind: "read",
      summary: "Valid, exposed by the adapter, and unregistered in the service.",
      input: z.object({}).strict(),
      async handler() {
        return { reached: true };
      },
    });
    const client = await connect(realRuntimeCall(), {
      operations: [...listOperations(), orphan],
    });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("mcp_orphan");

    const result = await client.callTool({ name: "mcp_orphan", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "not_found" });
  });
});
