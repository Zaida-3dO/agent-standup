// The CLI and MCP adapters reach a log (MILESTONES.md #97).
//
// Before this, a failure through either reached no log anywhere. Both
// adapters correctly refuse to show a caller the underlying failure — MCP
// renders `{"code":"internal"}` with the fixed message, and the command line
// renders the error's *class* and nothing more — and neither wrote the
// withheld half down. The detail existed and was unreadable, which is #97's
// motivating failure in two more shapes.
//
// What every test here asserts twice over: the operator-facing detail
// reaches **stderr**, and the caller-facing result is **unchanged**. The
// second half is the one that matters most — a fix that made the log richer
// by making the response leakier would be worse than the failure.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { callTool, type ServiceCall } from "@/lib/mcp/server";
import { createDirectBinding } from "@/lib/cli/bindings/direct";
import { createHttpBinding } from "@/lib/cli/bindings/http";
import { main } from "@/lib/cli/main";
import { GuardRejectedError, InternalError, NotFoundError } from "@/lib/service";
import { captureLogs, oneRecord, type CapturedLogs } from "./helpers/capture-logs";

/** The text no caller-facing payload in this file may ever contain. */
const SECRET = "postgres://user:hunter2@db.internal:5432/app";

let logs: CapturedLogs;
let originalLevel: string | undefined;

beforeEach(() => {
  originalLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

describe("the MCP adapter", () => {
  const failing: ServiceCall = async () => {
    throw new InternalError(new Error(`connect ECONNREFUSED ${SECRET}`));
  };

  test("logs an internal failure at ERROR, with the cause", async () => {
    await callTool(failing, "mcp-stdio", "create_item", {});

    const record = oneRecord(logs.stderr(), "MCP tool call failed unexpectedly.");
    expect(record?.level).toBe("error");
    expect(record?.tool).toBe("create_item");
    expect(record?.transport).toBe("mcp-stdio");
    expect(record?.requestId).toBeTypeOf("string");
    expect(JSON.stringify(record)).toContain("ECONNREFUSED");
  });

  test("keeps the cause OUT of the tool result the agent reads", async () => {
    // The redaction boundary. An agent gets the code and the fixed message;
    // the connection string goes to the log and stops there.
    const result = await callTool(failing, "mcp-stdio", "create_item", {});

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(result.structuredContent?.code).toBe("internal");
  });

  test("logs a refusal at DEBUG, naming the rule that fired", async () => {
    const refusing: ServiceCall = async () => {
      throw new GuardRejectedError("merge.requires_commit", "A merge needs a commit.");
    };

    await callTool(refusing, "mcp-http", "transition_item", {});

    const record = oneRecord(logs.stderr(), "MCP tool call refused.");
    expect(record?.level).toBe("debug");
    expect(record?.code).toBe("guard_rejected");
    expect(record?.guard).toBe("merge.requires_commit");
    // Not at error — a refusal is the system working.
    expect(oneRecord(logs.stderr(), "MCP tool call failed unexpectedly.")).toBeUndefined();
  });

  test("passes a request id down to the service, so both halves correlate", async () => {
    // The adapter is where the call begins. Its own line and the service's
    // lines have to carry the same id or they correlate nothing.
    let seen: string | undefined;
    const capturing: ServiceCall = async (_name, _input, options) => {
      seen = options?.caller?.requestId;
      throw new InternalError(new Error("boom"));
    };

    await callTool(capturing, "mcp-stdio", "get_item", {});

    expect(seen).toBeTypeOf("string");
    expect(oneRecord(logs.stderr(), "MCP tool call failed unexpectedly.")?.requestId).toBe(seen);
  });

  test("writes NOTHING when the call succeeds, and returns the result unchanged", async () => {
    const ok: ServiceCall = async () => ({ id: "item-1" });

    const result = await callTool(ok, "mcp-stdio", "get_item", {});

    expect(result.structuredContent).toEqual({ id: "item-1" });
    expect(logs.stderr()).toEqual([]);
    expect(logs.stdout()).toEqual([]);
  });

  test("writes to stderr and never to STDOUT — which is the MCP wire itself", async () => {
    // For `mcp-stdio` this is not a style preference: stdout carries the
    // JSON-RPC framing. A log line there would corrupt the protocol.
    await callTool(failing, "mcp-stdio", "create_item", {});

    expect(logs.stderr().length).toBeGreaterThan(0);
    expect(logs.stdout()).toEqual([]);
  });
});

describe("the CLI direct binding", () => {
  test("logs an internal failure at ERROR while the envelope stays redacted", async () => {
    const binding = createDirectBinding({
      service: {
        call: async () => {
          throw new InternalError(new Error(`connect ECONNREFUSED ${SECRET}`));
        },
      },
    });

    const result = await binding.invoke("create_item", {});

    const record = oneRecord(logs.stderr(), "Command failed unexpectedly.");
    expect(record?.level).toBe("error");
    expect(record?.operation).toBe("create_item");
    expect(record?.transport).toBe("cli");
    expect(JSON.stringify(record)).toContain("ECONNREFUSED");
    // And what a person's terminal would be shown carries none of it.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  test("logs a refusal at DEBUG rather than at error", async () => {
    const binding = createDirectBinding({
      service: {
        call: async () => {
          throw new NotFoundError("No such item: x.");
        },
      },
    });

    await binding.invoke("get_item", {});

    expect(oneRecord(logs.stderr(), "Command refused.")?.level).toBe("debug");
    expect(oneRecord(logs.stderr(), "Command failed unexpectedly.")).toBeUndefined();
  });

  test("logs on STDERR, never stdout, because stdout is the command's output", async () => {
    // `standup ... --json | jq` must not receive a log line. This is the
    // adapter where mistaking one for a result is most likely.
    const binding = createDirectBinding({
      service: {
        call: async () => {
          throw new InternalError(new Error("boom"));
        },
      },
    });

    await binding.invoke("create_item", {});

    expect(logs.stderr().length).toBeGreaterThan(0);
    expect(logs.stdout()).toEqual([]);
  });

  test("writes NOTHING on a successful command", async () => {
    const binding = createDirectBinding({ service: { call: async () => ({ id: "x" }) } });

    const result = await binding.invoke("get_item", {});

    expect(result).toEqual({ ok: true, data: { id: "x" } });
    expect(logs.stderr()).toEqual([]);
  });
});

describe("the CLI http binding", () => {
  test("logs the connect failure whose text the terminal is never shown", async () => {
    // The withheld detail — the host, the port, what the connect error
    // actually said — is exactly what a person diagnosing this needs, and
    // until now it was discarded rather than merely hidden.
    const binding = createHttpBinding({
      baseUrl: "http://example.invalid",
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED ${SECRET}`);
      },
    });

    const result = await binding.invoke("get_item", { id: "x" });

    const record = oneRecord(logs.stderr(), "Could not reach the server.");
    expect(record?.level).toBe("error");
    expect(record?.operation).toBe("get_item");
    expect(JSON.stringify(record)).toContain("ECONNREFUSED");
    // The rendered message still names only the error's class.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  test("logs a server failure at ERROR and a server refusal at DEBUG", async () => {
    const respondWith = (status: number, body: unknown) =>
      createHttpBinding({
        baseUrl: "http://example.invalid",
        fetch: async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      });

    await respondWith(500, { error: { code: "internal", message: "boom", fields: [] } }).invoke(
      "get_item",
      { id: "x" },
    );
    expect(oneRecord(logs.stderr(), "The server failed or answered unrecognisably.")?.level).toBe(
      "error",
    );

    logs.restore();
    logs = captureLogs();

    await respondWith(404, { error: { code: "not_found", message: "nope", fields: [] } }).invoke(
      "get_item",
      { id: "x" },
    );
    const refused = oneRecord(logs.stderr(), "The server refused the command.");
    expect(refused?.level).toBe("debug");
    expect(refused?.code).toBe("not_found");
    expect(refused?.status).toBe(404);
  });

  test("logs an unrecognisable body as a failure, which the terminal cannot tell apart", async () => {
    // From the terminal this reads as "the server refused". Only the status
    // and the shape distinguish "the server broke" from "the rules said no",
    // so the log is the only place that distinction survives.
    const binding = createHttpBinding({
      baseUrl: "http://example.invalid",
      fetch: async () =>
        new Response(JSON.stringify({ unexpected: "shape" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await binding.invoke("get_item", { id: "x" });

    const record = oneRecord(logs.stderr(), "The server failed or answered unrecognisably.");
    expect(record?.status).toBe(502);
  });

  test("writes NOTHING on a successful call", async () => {
    const binding = createHttpBinding({
      baseUrl: "http://example.invalid",
      fetch: async () =>
        new Response(JSON.stringify({ item: { id: "x" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await binding.invoke("get_item", { id: "x" });

    expect(logs.stderr()).toEqual([]);
  });
});

describe("the CLI's last resort", () => {
  test("logs at FATAL what the rendered envelope reduces to a class name", async () => {
    // A throw reaching `main`'s catch escaped both bindings' normalisation,
    // so it is the least expected failure the command line has — and the
    // envelope below it keeps only the class. Without this line the only
    // record of what happened would be a stack nobody kept.
    const written: string[] = [];
    const exitCode = await main(["item", "get", "x"], {
      streams: { out: (text) => written.push(text), err: (text) => written.push(text) },
      loadService: () => {
        throw new Error(`could not load the service: ${SECRET}`);
      },
      env: { DATABASE_URL: "postgresql://ignored" },
      file: {},
    });

    const record = oneRecord(logs.stderr(), "The command failed outside the binding boundary.");
    expect(record?.level).toBe("fatal");
    expect(JSON.stringify(record)).toContain("could not load the service");
    // The rendered output names the class and nothing else.
    expect(written.join("")).not.toContain(SECRET);
    expect(exitCode).toBe(1);
  });
});
