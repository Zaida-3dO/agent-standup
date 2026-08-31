// Argument types survive the MCP surface unchanged — MILESTONES.md #30, #84.
//
// ── Why this file exists ────────────────────────────────────────────────
//
// A repeatedly-filed defect claimed that `put_setting` could not be given a
// JSON boolean over MCP: a real `false` was reported to arrive at the
// validator as the *string* `"false"`, refused with
//
//   Invalid value for hook.require_registration_to_claim:
//   Expected boolean, received string
//
// and the blast radius was assumed to be every non-string setting value —
// every boolean, number and array unsettable over the one surface agents
// actually use.
//
// Driving the real transports proved the server does no such coercion; the
// value had already been stringified before it reached the wire, by
// something on the *client* side of the protocol. But the reason that took
// re-diagnosing five times is visible in the test suite rather than in the
// source: **`put_setting` was exercised at the CLI layer and at the service
// layer, and never once across MCP.** `cli-config-command.test.ts` proves
// `parseSettingValue` turns `true` into a boolean; `settings-operations.test.ts`
// proves the operation validates what it is handed. Neither says anything
// about what an argument looks like after a JSON-RPC round trip, so neither
// could have confirmed or refuted the report — an HTTP-only or CLI-only test
// passes whether or not MCP mangles its input.
//
// These tests close that gap. They assert the property the defect was about,
// over the surface the defect was reported against, for each JSON type a
// setting value can take.
//
// ── What would make these fail ──────────────────────────────────────────
//
// They are written against the *seam a coercion would have to cross*: the
// `ServiceCall` the adapter invokes. A single character is enough to break
// each — changing `server.ts`'s handler to pass `JSON.stringify(args)`, or
// `advertisedSchema`'s `.catch((ctx) => ctx.input)` to return a coerced
// value instead of the untouched input, turns every `toEqual` below red.
// `z.unknown()` in `put_setting`'s schema means Zod itself will never
// object to a wrong type here, which is precisely why the type has to be
// asserted rather than assumed to be enforced.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getOperation } from "@/lib/service";
import { createMcpServer, type ServiceCall } from "@/lib/mcp";
import { handleMcpRequest } from "@/lib/mcp/http";

const PROTOCOL_VERSION = "2025-06-18";

/**
 * One value of each JSON type a setting may hold, paired with a real
 * registry key declaring that type.
 *
 * Real keys rather than invented ones so the case list cannot drift into
 * testing shapes the registry does not actually have. `false` is first and
 * deliberate: it is the exact value from the defect report, and the one
 * most likely to be mangled, because it is the only case where a naive
 * stringification (`"false"`) is itself truthy.
 */
const TYPED_VALUES: readonly { label: string; key: string; value: unknown }[] = [
  { label: "boolean false", key: "hook.require_registration_to_claim", value: false },
  { label: "boolean true", key: "hook.require_registration_to_claim", value: true },
  { label: "number", key: "shape.minimum_sample", value: 7 },
  { label: "array of strings", key: "minting.source_globs", value: ["a/**", "b/**"] },
  { label: "null", key: "retention.tool_calls_days", value: null },
  { label: "string", key: "ui.default_landing", value: "board" },
];

/** Captures what the service layer is handed, without a database. */
function recordingCall(): { call: ServiceCall; seen: unknown[] } {
  const seen: unknown[] = [];
  const call: ServiceCall = async (_name, input) => {
    seen.push(input);
    return { ok: true };
  };
  return { call, seen };
}

/** A `put_setting` server over an in-memory pair, plus a connected client. */
async function connectedClient(call: ServiceCall) {
  const operation = getOperation("put_setting");
  if (!operation) throw new Error("put_setting is not a registered operation");
  const server = createMcpServer({
    adapter: "mcp_http",
    call,
    transport: "mcp-test",
    operations: [operation],
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "argument-types-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("put_setting argument types survive a real MCP client call", () => {
  for (const { label, key, value } of TYPED_VALUES) {
    it(`hands the service a ${label}, not a stringified one`, async () => {
      const { call, seen } = recordingCall();
      const client = await connectedClient(call);
      try {
        await client.callTool({ name: "put_setting", arguments: { key, value } });
      } finally {
        await client.close();
      }
      // `toEqual` on the whole input, so a coercion of *either* field is
      // caught, and so an extra or renamed key cannot pass unnoticed.
      expect(seen).toEqual([{ key, value }]);
    });
  }

  it('keeps a boolean false distinguishable from the string "false"', async () => {
    // The defect's exact confusion, pinned as its own assertion: these two
    // calls must not arrive identically. `toEqual` above would already
    // catch it, but stated separately this is the one line that names what
    // went wrong, and it fails loudly if a future change starts coercing.
    const { call, seen } = recordingCall();
    const client = await connectedClient(call);
    try {
      const key = "hook.require_registration_to_claim";
      await client.callTool({ name: "put_setting", arguments: { key, value: false } });
      await client.callTool({ name: "put_setting", arguments: { key, value: "false" } });
    } finally {
      await client.close();
    }
    const values = seen.map((input) => (input as { value: unknown }).value);
    expect(values).toEqual([false, "false"]);
    expect(typeof values[0]).toBe("boolean");
    expect(typeof values[1]).toBe("string");
  });
});

describe("argument types survive the streamable-HTTP transport", () => {
  /** POSTs one JSON-RPC message at the real HTTP handler. */
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
      clientInfo: { name: "argument-types-test", version: "0.0.0" },
    },
  };

  it("delivers every JSON type unchanged across a real HTTP round trip", async () => {
    // The transport the defect was reported against — the mount an agent
    // reaches at `/api/mcp`. Serialising to bytes and parsing back is the
    // step a client-side coercion would be hidden in, so it is done for
    // real here rather than simulated.
    //
    // **Driven through `update_item` rather than `put_setting`.** Settings
    // administration is waived from the MCP surface (`@/lib/adapters/waivers`)
    // because a setting is a deployment-wide policy decision a person makes,
    // so `put_setting` is not a tool this mount serves: a call naming it is
    // refused before any argument is examined, which would make this
    // assertion pass without the value ever crossing the seam it is about.
    //
    // The property under test is a property of the *transport*, not of any
    // one tool. `update_item` is exposed here and its `customFields` is
    // `z.record(z.string(), z.unknown())` — the same "Zod will never object
    // to the type" shape that makes this assertion meaningful, carrying the
    // identical boolean/number/array/null/string values across the identical
    // JSON-RPC seam. The `put_setting`-specific coverage is kept in full by
    // the in-memory cases above, which name the operation explicitly and so
    // are unaffected by what the mount advertises.
    const { call, seen } = recordingCall();
    await handleMcpRequest(post(initialize), call);
    for (const [index, { key, value }] of TYPED_VALUES.entries()) {
      await handleMcpRequest(
        post(
          {
            jsonrpc: "2.0",
            id: 100 + index,
            method: "tools/call",
            params: {
              name: "update_item",
              arguments: { id: "item-under-test", customFields: { [key]: value } },
            },
          },
          { "mcp-protocol-version": PROTOCOL_VERSION },
        ),
        call,
      );
    }
    // `full: false` is `update_item`'s own schema default, applied on the way
    // through. Asserted rather than stripped: it is evidence the argument was
    // really parsed by the operation's schema on the far side of the wire,
    // and not passed along as an opaque blob that a coercion could hide in.
    expect(seen).toEqual(
      TYPED_VALUES.map(({ key, value }) => ({
        id: "item-under-test",
        customFields: { [key]: value },
        full: false,
      })),
    );
  });
});
