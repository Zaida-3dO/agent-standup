// MCP over streamable HTTP, and the "stateless" half of MILESTONES.md #30.
//
// Driven by handing `handleMcpRequest` real `Request` objects and reading
// the real `Response` back, so what is exercised is the wiring a client
// reaches over the network rather than a mock of it.
//
// "Stateless" is asserted in the two ways it is observable from outside:
// **no session identifier is ever minted**, and **no request depends on a
// previous one** — a second, independent request initialises and calls a
// tool with no knowledge that the first ever happened. Both are properties
// a client can check, which is what makes them testable at all; the
// internal claim "no per-session state is held" is not directly observable
// and is proven only in so far as those two hold.
import { describe, expect, it } from "vitest";
import { ServiceRuntime, type TransactionHandle } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import type { ServiceCall } from "@/lib/mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  MCP_HTTP_TRANSPORT,
  createStatelessTransport,
  handleMcpRequest,
  identityFromHeaders,
} from "@/lib/mcp/http";
import { ACTOR_HEADER, SESSION_HEADER } from "@/lib/session-transport-header";

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

/** One JSON-RPC message, as a POST the transport will accept. */
function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://mcp.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const initialize = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};

const listTools = { jsonrpc: "2.0" as const, id: 2, method: "tools/list", params: {} };

function callToolMessage(name: string, args: unknown, id = 3) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

/** POST one message and read the JSON-RPC result out of the response. */
async function rpc(
  call: ServiceCall,
  message: unknown,
  headers: Record<string, string> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await handleMcpRequest(post(message, headers), call);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

describe("the HTTP wiring answers a real MCP conversation", () => {
  it("initialises and reports the tools capability", async () => {
    const { response, body } = await rpc(realRuntimeCall(), initialize);
    expect(response.status).toBe(200);
    const result = body.result as { capabilities: Record<string, unknown> };
    expect(result.capabilities).toHaveProperty("tools");
  });

  it("lists the tools the core derived, over HTTP", async () => {
    const call = realRuntimeCall();
    await rpc(call, initialize);
    const { body } = await rpc(call, listTools, {
      "mcp-protocol-version": PROTOCOL_VERSION,
    });
    const result = body.result as { tools: { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toContain("service_info");
  });

  it("calls a tool and returns the service's answer", async () => {
    const call = realRuntimeCall();
    await rpc(call, initialize);
    const { body } = await rpc(call, callToolMessage("service_info", {}), {
      "mcp-protocol-version": PROTOCOL_VERSION,
    });
    const result = body.result as { isError?: boolean; structuredContent: { operations: [] } };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.operations.length).toBeGreaterThan(0);
  });

  it("stamps mcp-http as the transport on a call arriving this way", async () => {
    // The value #84's stdio wiring will differ on, and the one §21 records
    // per session. Asserted through the real HTTP path rather than by
    // reading the constant, so a wiring that forgot to pass it is caught.
    const stamped: (string | undefined)[] = [];
    const call: ServiceCall = async (_name, _input, options) => {
      stamped.push(options?.caller?.transport);
      return {};
    };
    await rpc(call, initialize);
    await rpc(call, callToolMessage("service_info", {}), {
      "mcp-protocol-version": PROTOCOL_VERSION,
    });
    expect(stamped).toEqual([MCP_HTTP_TRANSPORT]);
  });

  it("renders a service rejection with its code and fields over HTTP too", async () => {
    // The same assertion `mcp-server.test.ts` makes in-process, repeated
    // across the real transport: a rejection that survived the core but
    // was flattened by the transport would still break §22's comparison.
    const call = realRuntimeCall();
    await rpc(call, initialize);
    const { body } = await rpc(call, callToolMessage("service_info", { kind: "sideways" }), {
      "mcp-protocol-version": PROTOCOL_VERSION,
    });
    const result = body.result as { isError: boolean; structuredContent: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "invalid_input", fields: ["kind"] });
  });
});

describe("stateless", () => {
  it("never mints a session identifier", async () => {
    // The observable signature of statelessness. A stateful server returns
    // `Mcp-Session-Id` on initialize and requires it thereafter; this one
    // has nothing to hand back because it keeps nothing to look up.
    const { response } = await rpc(realRuntimeCall(), initialize);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("builds a transport with session management disabled", async () => {
    // The one line DECISIONS.md §12 says the whole property turns on
    // ("can be flipped stateless in one line"), asserted directly so that
    // flipping it back is a failing test rather than a silent change of
    // deployment shape.
    const transport = createStatelessTransport();
    try {
      expect(transport.sessionId).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it("serves a call on a request that never initialised, with no prior request", async () => {
    // The property that matters operationally: any request can be served by
    // any process. A stateful server would refuse this — a `tools/call`
    // with no session and no preceding initialize is exactly what arrives
    // at a replica that has never seen this client.
    const { response, body } = await rpc(realRuntimeCall(), callToolMessage("service_info", {}));
    expect(response.status).toBe(200);
    const result = body.result as { isError?: boolean; structuredContent: { operations: [] } };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.operations.length).toBeGreaterThan(0);
  });

  it("does not carry a rejection, or anything else, from one request into the next", async () => {
    // Two independent calls through the same entry point. If any state
    // survived a request — a cached parse, a remembered failure, a
    // half-closed stream — the second would differ from a first.
    const call = realRuntimeCall();
    const bad = await rpc(call, callToolMessage("service_info", { kind: "sideways" }, 10));
    expect((bad.body.result as { isError: boolean }).isError).toBe(true);

    const good = await rpc(call, callToolMessage("service_info", {}, 11));
    const result = good.body.result as { isError?: boolean; structuredContent: { operations: [] } };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.operations.length).toBeGreaterThan(0);
  });

  it("answers two concurrent requests independently", async () => {
    // A per-request server and transport means two in flight at once
    // cannot see each other. Sequential independence (above) would still
    // pass if the two shared a single mutable server, so this runs them
    // overlapped.
    const call = realRuntimeCall();
    const [first, second] = await Promise.all([
      rpc(call, callToolMessage("service_info", { kind: "read" }, 20)),
      rpc(call, callToolMessage("service_info", { kind: "write" }, 21)),
    ]);
    const readOnly = (
      first.body.result as { structuredContent: { operations: { kind: string }[] } }
    ).structuredContent.operations;
    const writeOnly = (
      second.body.result as { structuredContent: { operations: { kind: string }[] } }
    ).structuredContent.operations;
    expect(readOnly.length).toBeGreaterThan(0);
    expect(writeOnly.length).toBeGreaterThan(0);
    expect(readOnly.every((operation) => operation.kind === "read")).toBe(true);
    expect(writeOnly.every((operation) => operation.kind === "write")).toBe(true);
  });
});

describe("nothing is left running after a request", () => {
  it("closes the transport even when the service throws", async () => {
    // The `finally` in `handleMcpRequest`. A handler that returned early on
    // an error path would leak a transport per failed request — invisible
    // in a passing test suite and fatal in a long-running process. Proven
    // by observing the transport's own `onclose`, which the SDK fires when
    // `close()` runs.
    const closed: string[] = [];
    const originalClose = WebStandardStreamableHTTPServerTransport.prototype.close;
    WebStandardStreamableHTTPServerTransport.prototype.close = async function patched(
      this: WebStandardStreamableHTTPServerTransport,
    ) {
      closed.push("closed");
      return originalClose.call(this);
    };
    try {
      await rpc(
        async () => {
          throw new Error("the service fell over");
        },
        callToolMessage("service_info", {}, 30),
      );
      expect(closed.length).toBe(1);
    } finally {
      WebStandardStreamableHTTPServerTransport.prototype.close = originalClose;
    }
  });

  it("closes the transport on the success path too", async () => {
    const closed: string[] = [];
    const originalClose = WebStandardStreamableHTTPServerTransport.prototype.close;
    WebStandardStreamableHTTPServerTransport.prototype.close = async function patched(
      this: WebStandardStreamableHTTPServerTransport,
    ) {
      closed.push("closed");
      return originalClose.call(this);
    };
    try {
      await rpc(realRuntimeCall(), callToolMessage("service_info", {}, 31));
      expect(closed.length).toBe(1);
    } finally {
      WebStandardStreamableHTTPServerTransport.prototype.close = originalClose;
    }
  });
});

/**
 * A `Headers`-shaped object that returns values **exactly** as given.
 *
 * A real `Headers` strips surrounding whitespace in its own constructor, so a
 * test that built one could never reach this module's trimming at all — it
 * would assert the platform's normalisation and pass just as happily with the
 * trim deleted, which is the hollow-test shape this suite exists to avoid.
 * Feeding un-normalised values is the only way to put the assertion on the
 * code under test rather than on undici.
 */
function rawHeaders(values: Record<string, string>): Headers {
  return { get: (name: string) => values[name] ?? null } as Headers;
}

describe("a stateless request says who is calling in its headers", () => {
  // Statelessness is exactly why this has to be a header: the transport mints
  // no session id and remembers nothing between requests, so a caller that
  // wants its writes attributed has to re-declare itself on every call. Before
  // this, nothing carried it — `ctx.caller.sessionId` was never populated over
  // MCP, so the four item-mutating operations credited every MCP write to
  // `system` while crediting the identical call made another way correctly.

  it("threads the session and actor headers into the service call", async () => {
    const callers: (Record<string, unknown> | undefined)[] = [];
    await rpc(
      async (_name, _input, options) => {
        callers.push(options?.caller as Record<string, unknown>);
        return {};
      },
      callToolMessage("service_info", {}, 40),
      { [SESSION_HEADER]: "session-http", [ACTOR_HEADER]: "agent-http" },
    );
    expect(callers[0]).toMatchObject({
      sessionId: "session-http",
      actor: "agent-http",
      transport: MCP_HTTP_TRANSPORT,
    });
  });

  it("leaves the caller unidentified when the headers are absent", async () => {
    // The unattributed call must keep working. Refusing it would turn a
    // missing courtesy into an outage on the surface every agent depends on,
    // and an identity is not a permission here — it decides only how a call is
    // described.
    const callers: (Record<string, unknown> | undefined)[] = [];
    const { body } = await rpc(
      async (_name, _input, options) => {
        callers.push(options?.caller as Record<string, unknown>);
        return {};
      },
      callToolMessage("service_info", {}, 41),
    );
    expect(body.error).toBeUndefined();
    expect(Object.keys(callers[0]!)).not.toContain("sessionId");
    expect(Object.keys(callers[0]!)).not.toContain("actor");
  });

  it("reads a blank or whitespace-only header as no identity at all", () => {
    // A header sent empty is a client that meant to identify itself and had
    // nothing — the unidentified case. Passing `""` through would put an empty
    // string where a real id belongs, where it would compare unequal to every
    // assignment rather than falling back to the attribution that honestly
    // describes it.
    expect(
      identityFromHeaders(rawHeaders({ [SESSION_HEADER]: "", [ACTOR_HEADER]: "   " })),
    ).toEqual({});
  });

  it("trims a header rather than carrying its surrounding whitespace", () => {
    expect(identityFromHeaders(rawHeaders({ [SESSION_HEADER]: "  session-c  " }))).toEqual({
      sessionId: "session-c",
    });
  });

  it("reads each half independently", () => {
    expect(identityFromHeaders(new Headers({ [SESSION_HEADER]: "s" }))).toEqual({ sessionId: "s" });
    expect(identityFromHeaders(new Headers({ [ACTOR_HEADER]: "a" }))).toEqual({ actor: "a" });
  });
});
