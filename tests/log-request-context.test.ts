// Request context: the id minted at a boundary and threaded through
// (MILESTONES.md #97 — "the only part with real design in it").
//
// The claim under test is not "an id exists" but the properties that make
// it useful:
//
//   1. **Every call has one.** A caller that reaches the runtime without
//      crossing an adapter still produces correlated lines, because the
//      runtime mints one when the adapter did not.
//   2. **The adapter's own id wins.** An adapter mints at the boundary and
//      has lines of its own already stamped; the runtime must not overwrite
//      it, or the adapter's lines and the service's lines would carry
//      different ids for one call and correlate nothing.
//   3. **Two concurrent calls get different ids**, which is the entire
//      reason the id exists — telling interleaved failures apart.
//
// Plus the two rules the redaction boundary rests on: the `cause` reaches
// the log, and the input never does.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { newRequestId, REQUEST_ID_KEY } from "@/lib/log";
import {
  NotImplementedError,
  ServiceRuntime,
  defineOperation,
  type ServiceContext,
  type TransactionHandle,
} from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import { captureLogs, oneRecord, type CapturedLogs } from "./helpers/capture-logs";

/** A transaction handle that answers nothing — no test here issues a query. */
const NO_DB: TransactionHandle = {
  $queryRawUnsafe: async () => [] as never,
  $executeRawUnsafe: async () => 0,
};

/**
 * A runtime over scratch operations installed on the real registry for the
 * duration of one test.
 *
 * Mutating the real registry rather than injecting a fake one is the shape
 * `service-runtime.test.ts` established, and for its reason: it exercises
 * the same `getOperation` lookup production uses.
 */
function testRuntime(operations: Record<string, unknown>) {
  const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
  const installed = Object.keys(operations);
  for (const name of installed) registry[name] = operations[name];
  const runtime = new ServiceRuntime({
    transaction: (body) => body(NO_DB),
    resolveSnapshot: async () => defaultSnapshot(),
  });
  return {
    runtime,
    cleanup: () => {
      for (const name of installed) delete registry[name];
    },
  };
}

/** A scratch operation that hands its context back to the test. */
function observer(name: string, seen: { ctx?: ServiceContext }) {
  return defineOperation({
    name,
    kind: "read",
    summary: "Reports the context it was handed.",
    input: z.object({}).strict(),
    async handler(ctx: ServiceContext) {
      seen.ctx = ctx;
      return { ok: true };
    },
  });
}

/** A scratch operation that throws something outside the taxonomy. */
function thrower(name: string, message: string) {
  return defineOperation({
    name,
    kind: "read",
    summary: "Fails the way a driver would.",
    input: z.object({}).passthrough(),
    async handler() {
      throw new Error(message);
    },
  });
}

let logs: CapturedLogs;
let originalLevel: string | undefined;

beforeEach(() => {
  originalLevel = process.env.LOG_LEVEL;
  // `debug` so the per-call lines are emitted at all; the default `info`
  // deliberately withholds them, which is asserted separately below.
  process.env.LOG_LEVEL = "debug";
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

describe("newRequestId", () => {
  test("mints a different id every time", () => {
    // A per-process counter would collide across replicas — the application
    // ships as an image and can sit behind a proxy — and colliding ids
    // correlate the wrong lines, which is worse than having none.
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
    expect(ids.size).toBe(100);
  });

  test("is a non-empty string under the key every layer agrees on", () => {
    expect(REQUEST_ID_KEY).toBe("requestId");
    expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("ServiceRuntime request context", () => {
  test("MINTS an id when the caller supplied none, so no line is unlabelled", async () => {
    const seen: { ctx?: ServiceContext } = {};
    const op = observer("scratch_mints", seen);
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await runtime.call(op.name, {});
      expect(seen.ctx?.caller.requestId).toMatch(/^[0-9a-f-]{36}$/);
      // The line the runtime wrote carries the same id the operation saw —
      // the two being equal is the whole correlation.
      expect(oneRecord(logs.stderr(), "Service call started.")?.requestId).toBe(
        seen.ctx?.caller.requestId,
      );
    } finally {
      cleanup();
    }
  });

  test("KEEPS the adapter's id rather than minting a second one", async () => {
    // The adapter is where the call began and it has already stamped lines
    // with its own id. Overwriting it here would give one call two ids and
    // correlate neither half to the other.
    const seen: { ctx?: ServiceContext } = {};
    const op = observer("scratch_keeps", seen);
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await runtime.call(op.name, {}, { caller: { requestId: "from-the-adapter" } });
      expect(seen.ctx?.caller.requestId).toBe("from-the-adapter");
      expect(oneRecord(logs.stderr(), "Service call started.")?.requestId).toBe("from-the-adapter");
    } finally {
      cleanup();
    }
  });

  test("preserves the rest of the caller while adding the id", async () => {
    const seen: { ctx?: ServiceContext } = {};
    const op = observer("scratch_caller", seen);
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await runtime.call(
        op.name,
        {},
        { caller: { transport: "mcp-stdio", sessionId: "s-1", actor: "a-1" } },
      );
      expect(seen.ctx?.caller.transport).toBe("mcp-stdio");
      expect(seen.ctx?.caller.sessionId).toBe("s-1");
      expect(seen.ctx?.caller.actor).toBe("a-1");
      expect(seen.ctx?.caller.requestId).toBeTypeOf("string");
    } finally {
      cleanup();
    }
  });

  test("gives two CONCURRENT calls different ids", async () => {
    // The reason the id exists at all. If these ever matched, two
    // simultaneous failures would read as one request failing twice.
    const ids: (string | undefined)[] = [];
    const op = defineOperation({
      name: "scratch_concurrent",
      kind: "read",
      summary: "Yields, then reports its request id.",
      input: z.object({}).strict(),
      async handler(ctx: ServiceContext) {
        // Yield, so the two calls genuinely interleave rather than running
        // to completion one after the other.
        await new Promise((resolve) => setTimeout(resolve, 5));
        ids.push(ctx.caller.requestId);
        return { ok: true };
      },
    });
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await Promise.all([runtime.call(op.name, {}), runtime.call(op.name, {})]);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBeTypeOf("string");
      expect(ids[0]).not.toBe(ids[1]);
    } finally {
      cleanup();
    }
  });
});

describe("ServiceRuntime logging", () => {
  test("writes to STDERR and never to stdout", async () => {
    // stdout is where a command's output goes. A log line there would be
    // read as a result by anything parsing the stream.
    const seen: { ctx?: ServiceContext } = {};
    const op = observer("scratch_stream", seen);
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await runtime.call(op.name, {});
      expect(logs.stderr().length).toBeGreaterThan(0);
      expect(logs.stdout()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("logs an internal failure at ERROR, with the cause the client never sees", async () => {
    // #97's motivating failure, at the layer that produces it: the client
    // gets `{"code":"internal"}` and the log gets the reason.
    const op = thrower("scratch_boom", "connect ECONNREFUSED to the database");
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await expect(runtime.call(op.name, {})).rejects.toThrow();
      const failed = oneRecord(logs.stderr(), "Service call failed unexpectedly.");
      expect(failed?.level).toBe("error");
      expect(failed?.operation).toBe("scratch_boom");
      expect(failed?.requestId).toBeTypeOf("string");
      // The cause reached the log, which is the entire point of the row.
      expect(JSON.stringify(failed)).toContain("ECONNREFUSED");
      // And the fault axis names it as the server's, with the coarse
      // bucket beneath it — the fields that make "is anything broken"
      // answerable as a query rather than by reading stacks.
      expect(failed?.fault).toBe("server");
      expect(failed?.internalKind).toBe("unexpected");
    } finally {
      cleanup();
    }
  });

  test("logs a refusal at DEBUG, so it cannot bury the failures that need a human", async () => {
    // A 404 is the system working. At `error`, a thousand of them would
    // hide the one `internal` that means something is actually wrong.
    const { runtime, cleanup } = testRuntime({});
    try {
      await expect(runtime.call("no_such_operation_at_all", {})).rejects.toThrow();
      const refused = oneRecord(logs.stderr(), "Service call refused.");
      expect(refused?.level).toBe("debug");
      expect(refused?.code).toBe("not_found");
      expect(refused?.fault).toBe("caller");
      // And crucially NOT at error.
      expect(oneRecord(logs.stderr(), "Service call failed unexpectedly.")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("NEVER logs the input, at any level", async () => {
    // `put_setting` carries a value whose key may be marked `sensitive`, a
    // rule the runtime cannot consult. Logging the operation is what an
    // operator needs; logging what the caller sent is how a credential ends
    // up in an aggregator.
    const op = thrower("scratch_secret", "boom");
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await expect(runtime.call(op.name, { password: "hunter2-do-not-log-me" })).rejects.toThrow();
      expect(JSON.stringify(logs.stderr())).not.toContain("hunter2-do-not-log-me");
    } finally {
      cleanup();
    }
  });

  test("logs a NOT_IMPLEMENTED at error, not on the caller-refusal branch", async () => {
    // `not_implemented` is unfixable by the caller — `EXIT_BY_CODE` says
    // so by putting it on EXIT.FAILURE — so a build answering a call it
    // cannot serve is an operator's problem. On the `debug` branch it
    // would be invisible at the default threshold, which is why the fault
    // axis and not the bare code decides the level.
    const op = defineOperation({
      name: "scratch_unimplemented",
      kind: "read",
      summary: "Not built yet.",
      input: z.object({}).passthrough(),
      async handler() {
        throw new NotImplementedError("This build does not serve that.");
      },
    });
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await expect(runtime.call(op.name, {})).rejects.toThrow();
      const failed = oneRecord(logs.stderr(), "Service call failed unexpectedly.");
      expect(failed?.level).toBe("error");
      expect(failed?.fault).toBe("server");
      // No sub-bucket: there is no wrapped cause to classify, and an
      // invented one would claim a database failure that did not happen.
      expect(failed).not.toHaveProperty("internalKind");
      expect(oneRecord(logs.stderr(), "Service call refused.")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("the DEFAULT threshold withholds the per-call lines but keeps the failure", async () => {
    // `info` is what a deployment that sets nothing gets. One line per call
    // is the highest-volume thing here; the failure is what needs a human.
    process.env.LOG_LEVEL = "info";
    const op = thrower("scratch_default_level", "boom");
    const { runtime, cleanup } = testRuntime({ [op.name]: op });
    try {
      await expect(runtime.call(op.name, {})).rejects.toThrow();
      expect(oneRecord(logs.stderr(), "Service call started.")).toBeUndefined();
      expect(oneRecord(logs.stderr(), "Service call failed unexpectedly.")).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
