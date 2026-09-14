// `standup mcp` (SCHEMA.md §20, MILESTONES.md #84): the CLI layer above
// `src/lib/mcp/stdio.ts` — preflighting a database the same way `--direct`
// does, loading the service the same deferred way `run.ts`'s binding does,
// and reaching `serveMcpStdio` with the result. `tests/mcp-stdio.test.ts`
// covers the transport itself; this file covers the wiring around it: the
// preflight, the deferred load, and that `standup mcp` actually dispatches
// here at all.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { EXIT, runCli, runMcpStdio, type CallableService } from "@/lib/cli";

const PROTOCOL_VERSION = "2025-06-18";

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

/** Reads newline-framed JSON-RPC responses off a stream, by id. */
function responseReader(output: PassThrough) {
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
    waitFor(id: number) {
      return new Promise<Record<string, unknown>>((resolve) => {
        waiters.set(id, resolve);
      });
    },
  };
}

describe("runMcpStdio — the preflight", () => {
  it("refuses with exit code 4 when nothing is configured, and never loads a service", async () => {
    let loaded = false;
    const outcome = await runMcpStdio({
      env: {},
      loadService: async () => {
        loaded = true;
        return { call: async () => ({}) };
      },
    });
    expect(outcome.exitCode).toBe(EXIT.UNCONFIGURED);
    expect(outcome.envelope.ok).toBe(false);
    if (!outcome.envelope.ok) {
      expect(outcome.envelope.error.message).toContain("standup init");
    }
    // The deferred-import claim, proven rather than asserted: a preflight
    // that loaded the service before checking configuration would pay for
    // importing the database client on every unconfigured run.
    expect(loaded).toBe(false);
  });

  it("is satisfied by DATABASE_URL alone — no STANDUP_URL required", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = responseReader(output);

    const outcomePromise = runMcpStdio({
      env: { DATABASE_URL: "postgresql://u@h/d" },
      loadService: async () => ({ call: async () => ({ ok: true }) }),
      input,
      output,
    });

    input.write(`${JSON.stringify(initializeMessage(1))}\n`);
    const response = await reader.waitFor(1);
    expect(
      (response.result as { capabilities: Record<string, unknown> }).capabilities,
    ).toHaveProperty("tools");

    input.end();
    const outcome = await outcomePromise;
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(outcome.envelope.ok).toBe(true);
  });
});

describe("runMcpStdio — reaching the service", () => {
  it("calls the loaded service through the core, stamping mcp-stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = responseReader(output);

    const calls: { name: string; transport: string | undefined }[] = [];
    const service: CallableService = {
      call: async (name, _input, options) => {
        calls.push({ name, transport: options?.caller?.transport });
        return { operations: [{ name: "describe_tool", kind: "read" }] };
      },
    };

    const outcomePromise = runMcpStdio({
      env: { DATABASE_URL: "postgresql://u@h/d" },
      loadService: async () => service,
      input,
      output,
      // The startup drift check (this row's own addition, see mcp.ts) writes
      // here rather than to the real stderr — nothing about the assertions
      // below is about that check, so it is silenced the same way `input`
      // and `output` stand in for the real streams.
      stderr: { write: () => {} },
    });

    input.write(`${JSON.stringify(initializeMessage(1))}\n`);
    await reader.waitFor(1);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "describe_tool", arguments: { tool: "describe_tool" } },
      })}\n`,
    );
    await reader.waitFor(2);

    // The first call is `runMcpStdio`'s own pre-flight migration-drift check
    // (unnamed `tool`, so `describe_tool`'s build/transport/migrations
    // branch); the second is the client's real `tools/call`, named above.
    // Both stamp `mcp-stdio` through the same core, which is what this test
    // exists to prove.
    expect(calls).toEqual([
      { name: "describe_tool", transport: "mcp-stdio" },
      { name: "describe_tool", transport: "mcp-stdio" },
    ]);

    input.end();
    await outcomePromise;
  });
});

describe("runMcpStdio — the migration-drift check", () => {
  /** A service whose `describe_tool` reports one migration-drift severity. */
  function serviceReporting(migrations: { severity: string; message: string }): CallableService {
    return {
      call: async (name) => {
        if (name === "describe_tool") {
          return {
            migrations,
            transport: { transport: "mcp-stdio", adapter: "mcp_stdio", waived: [] },
          };
        }
        return { operations: [] };
      },
    };
  }

  it("warns to stderr and still serves when the database is merely ahead", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];

    const outcomePromise = runMcpStdio({
      env: { DATABASE_URL: "postgresql://u@h/d" },
      loadService: async () =>
        serviceReporting({ severity: "database_ahead", message: "the database is ahead" }),
      input,
      output,
      stderr: { write: (chunk) => written.push(chunk) },
    });

    input.write(`${JSON.stringify(initializeMessage(1))}\n`);
    const reader = responseReader(output);
    const response = await reader.waitFor(1);
    expect(
      (response.result as { capabilities: Record<string, unknown> }).capabilities,
    ).toHaveProperty("tools");
    expect(written.join("")).toContain("the database is ahead");

    input.end();
    const outcome = await outcomePromise;
    expect(outcome.exitCode).toBe(EXIT.OK);
  });

  it("says nothing to stderr when migration state matches", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];

    const outcomePromise = runMcpStdio({
      env: { DATABASE_URL: "postgresql://u@h/d" },
      loadService: async () =>
        serviceReporting({ severity: "none", message: "Migration state matches." }),
      input,
      output,
      stderr: { write: (chunk) => written.push(chunk) },
    });

    input.write(`${JSON.stringify(initializeMessage(1))}\n`);
    const reader = responseReader(output);
    await reader.waitFor(1);
    expect(written).toEqual([]);

    input.end();
    await outcomePromise;
  });

  it("refuses to start on genuine incompatibility, and never opens the stdio transport", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    let outputWritten = false;
    output.on("data", () => {
      outputWritten = true;
    });

    const outcome = await runMcpStdio({
      env: { DATABASE_URL: "postgresql://u@h/d" },
      loadService: async () =>
        serviceReporting({ severity: "incompatible", message: "no common base" }),
      input,
      output,
      stderr: { write: (chunk) => written.push(chunk) },
    });

    expect(outcome.exitCode).toBe(EXIT.REJECTED);
    expect(outcome.envelope.ok).toBe(false);
    if (!outcome.envelope.ok) {
      expect(outcome.envelope.error.message).toContain("no common base");
    }
    expect(written.join("")).toContain("no common base");
    // Never reached the transport at all — nothing was written to stdout,
    // which is where an MCP protocol frame would appear if it had.
    expect(outputWritten).toBe(false);
  });

  it("continues rather than refusing when the drift check itself cannot be answered", async () => {
    // A `describe_tool` call that throws (a database reachable for the
    // preflight but not for this call, say) must not be read as
    // incompatibility — see `driftReport`'s own comment in mcp.ts.
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = responseReader(output);

    const outcomePromise = runMcpStdio({
      env: { DATABASE_URL: "postgresql://u@h/d" },
      loadService: async () => ({
        call: async () => {
          throw new Error("connection reset");
        },
      }),
      input,
      output,
      stderr: { write: () => {} },
    });

    input.write(`${JSON.stringify(initializeMessage(1))}\n`);
    const response = await reader.waitFor(1);
    expect(
      (response.result as { capabilities: Record<string, unknown> }).capabilities,
    ).toHaveProperty("tools");

    input.end();
    const outcome = await outcomePromise;
    expect(outcome.exitCode).toBe(EXIT.OK);
  });
});

describe("standup mcp dispatches through runCli", () => {
  it("reaches the mcp-specific unconfigured refusal, not the generic one", async () => {
    // Both the `mcp` preflight and the generic one (`resolveConfig` with
    // `--direct` not forced) refuse the same way when *nothing at all* is
    // configured — same exit code, same `malformed_command` shape from
    // `envelope.ts`'s `malformed()`. What tells them apart is the specific
    // refusal: `mcp` forces `--direct`, so it names only `DATABASE_URL`;
    // the generic path names both variables. If `run.ts`'s `mcp` branch
    // were removed, `words[0] === "mcp"` would fall through to the general
    // `resolution` computed earlier in `runCli` and report both fields.
    const outcome = await runCli(["mcp"], { env: {} });
    expect(outcome.exitCode).toBe(EXIT.UNCONFIGURED);
    expect(outcome.envelope.ok).toBe(false);
    if (!outcome.envelope.ok) {
      expect(outcome.envelope.error.fields).toEqual(["DATABASE_URL"]);
    }
  });

  it("stays unconfigured with a server reachable — mcp is --direct-only, not swallowed by http", async () => {
    // The strongest distinguishing case. With `STANDUP_URL` set and no
    // `DATABASE_URL`, the *generic* resolution path succeeds — `binding:
    // "http"` — and would go on to look `mcp` up as a noun, which does not
    // exist in `COMMANDS`, refusing with `malformed_command` and exit code
    // `2`. `standup mcp` itself must never reach that path: it stays
    // exit code `4` regardless of a server being configured, because this
    // row is specifically the no-server substitute (DECISIONS.md §13f).
    // A mutant that dropped `run.ts`'s `mcp` branch, or one that dropped
    // `flags: { direct: true }` from `./mcp.ts`'s own `resolveConfig` call,
    // would each turn this into exit code `2` instead of `4`.
    const outcome = await runCli(["mcp"], { env: { STANDUP_URL: "https://example.test" } });
    expect(outcome.exitCode).toBe(EXIT.UNCONFIGURED);
    expect(outcome.envelope.ok).toBe(false);
    if (!outcome.envelope.ok) {
      expect(outcome.envelope.error.fields).toEqual(["DATABASE_URL"]);
    }
  });
});
