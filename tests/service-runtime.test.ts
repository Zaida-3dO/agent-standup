// The service runtime's two structural guarantees: one settings snapshot
// per call, and one transaction per call that rolls back on a throw.
//
// Both are counted, not asserted-by-existence. A test that checks "a
// snapshot was available" passes just as happily when the runtime resolved
// four of them, and a test that runs a successful operation proves nothing
// about rollback — the interesting case is the one that fails halfway.
import { describe, expect, it } from "vitest";
import {
  ServiceRuntime,
  defineOperation,
  GuardRejectedError,
  InvalidInputError,
  isServiceError,
  type ServiceContext,
  type TransactionHandle,
} from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot, resolveSettings, type SettingsSnapshot } from "@/lib/settings";
import { z } from "zod";

/**
 * A transaction handle over an in-memory list, with the one property that
 * makes rollback observable: writes go to a scratch buffer and are only
 * merged into the committed state if the body resolves.
 *
 * That is what a database does, modelled just closely enough to tell
 * "committed" from "rolled back" without a database. The DB-backed proof of
 * the same claim is in `service-transaction-db.test.ts`; this one runs
 * everywhere and is the one that fails fast.
 */
class FakeDatabase {
  committed: string[] = [];
  /** How many transactions have been opened over this database's lifetime. */
  transactionsOpened = 0;
  commits = 0;
  rollbacks = 0;

  run = async <T>(body: (db: TransactionHandle) => Promise<T>): Promise<T> => {
    this.transactionsOpened += 1;
    const scratch = [...this.committed];
    const handle: TransactionHandle = {
      $queryRawUnsafe: async <R = unknown>(query: string): Promise<R> => {
        if (query === "rows") return scratch as unknown as R;
        throw new Error(`unexpected query: ${query}`);
      },
      $executeRawUnsafe: async (query: string, ...values: unknown[]): Promise<number> => {
        if (query !== "insert") throw new Error(`unexpected statement: ${query}`);
        scratch.push(String(values[0]));
        return 1;
      },
    };
    try {
      const result = await body(handle);
      this.committed = scratch;
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      // The scratch buffer is discarded, which is the rollback.
      throw error;
    }
  };
}

/** Counts how many times the runtime asked for a snapshot. */
function countingResolver(snapshot: SettingsSnapshot = defaultSnapshot()) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    resolve: async () => {
      calls += 1;
      return snapshot;
    },
  };
}

/**
 * An operation that writes twice and can be told to fail between the two
 * writes. The failure point is *between* them on purpose: if the boundary
 * were per-statement rather than per-operation, the first write would
 * survive and the test would see it.
 */
const writeTwice = defineOperation({
  name: "test_write_twice",
  kind: "write",
  summary: "Writes two rows, optionally failing between them.",
  input: z.object({ failBetween: z.boolean().default(false) }),
  async handler(ctx: ServiceContext, input: { failBetween: boolean }) {
    await ctx.db.$executeRawUnsafe("insert", "first");
    if (input.failBetween) {
      throw new GuardRejectedError("test.always_refuses", "Refused between the two writes.", {
        fields: ["failBetween"],
      });
    }
    await ctx.db.$executeRawUnsafe("insert", "second");
    return { written: 2 };
  },
});

/**
 * An operation that reads the snapshot several times from the context and
 * reports the object identity it saw each time.
 *
 * Identity, not value: two separately resolved snapshots of an unchanged
 * database hold equal values, so comparing values would pass even if the
 * runtime resolved a fresh one per read. Only identity distinguishes them.
 */
const observeSnapshot = defineOperation({
  name: "test_observe_snapshot",
  kind: "read",
  summary: "Reports the snapshot identity seen at three points in one call.",
  input: z.object({}).strict(),
  async handler(ctx: ServiceContext) {
    const first = ctx.settings;
    await Promise.resolve();
    const second = ctx.settings;
    await Promise.resolve();
    return { allSame: first === second && second === ctx.settings, seen: ctx.settings };
  },
});

/** A runtime over the test operations, so the real registry stays untouched. */
function testRuntime(
  operations: Record<string, unknown>,
  options: { snapshot?: SettingsSnapshot } = {},
) {
  const db = new FakeDatabase();
  const resolver = countingResolver(options.snapshot);
  // The runtime dispatches through the module registry, so the test
  // operations are installed on it for the duration of the test and
  // removed afterwards. Mutating the real object rather than injecting a
  // fake one is deliberate: it exercises the same lookup path production
  // uses, so a change to how `getOperation` resolves is caught here.
  const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
  const installed = Object.keys(operations);
  for (const name of installed) registry[name] = operations[name];
  const runtime = new ServiceRuntime({
    transaction: db.run,
    resolveSnapshot: resolver.resolve,
  });
  return {
    db,
    resolver,
    runtime,
    cleanup: () => {
      for (const name of installed) delete registry[name];
    },
  };
}

describe("one settings snapshot per call", () => {
  it("resolves exactly once, however many times the operation reads it", async () => {
    const { runtime, resolver, cleanup } = testRuntime({
      [observeSnapshot.name]: observeSnapshot,
    });
    try {
      const result = (await runtime.call(observeSnapshot.name, {})) as { allSame: boolean };
      expect(result.allSame).toBe(true);
      // The load-bearing assertion. A runtime that resolved per guard, or
      // re-resolved inside the transaction, reports more than one here.
      expect(resolver.calls).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("resolves once per call and not once per process", async () => {
    const { runtime, resolver, cleanup } = testRuntime({
      [observeSnapshot.name]: observeSnapshot,
    });
    try {
      await runtime.call(observeSnapshot.name, {});
      await runtime.call(observeSnapshot.name, {});
      await runtime.call(observeSnapshot.name, {});
      // Three calls, three resolutions — a runtime that cached one
      // snapshot for its own lifetime would report 1, and a settings
      // change would then never become visible to it.
      expect(resolver.calls).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("does not resolve a snapshot for a call it refuses before running", async () => {
    const { runtime, resolver, cleanup } = testRuntime({
      [observeSnapshot.name]: observeSnapshot,
    });
    try {
      // `.strict()` refuses the unknown key, so this never reaches a body.
      await expect(runtime.call(observeSnapshot.name, { nope: 1 })).rejects.toBeInstanceOf(
        InvalidInputError,
      );
      await expect(runtime.call("no_such_operation", {})).rejects.toThrow();
      expect(resolver.calls).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("hands the operation the snapshot the resolver returned, not a fresh default", async () => {
    // A snapshot with a non-default value, so "the operation saw *this*
    // one" is distinguishable from "the operation saw a default".
    const snapshot = resolveSettings({
      overrides: [{ key: "items.max_depth", value: 11 }],
      revision: 42n,
    });
    const { runtime, cleanup } = testRuntime(
      { [observeSnapshot.name]: observeSnapshot },
      { snapshot },
    );
    try {
      const result = (await runtime.call(observeSnapshot.name, {})) as {
        seen: SettingsSnapshot;
      };
      expect(result.seen).toBe(snapshot);
      expect(result.seen.values["items.max_depth"]).toBe(11);
      expect(result.seen.revision).toBe(42n);
    } finally {
      cleanup();
    }
  });
});

describe("one transaction per call", () => {
  it("opens exactly one transaction for one call", async () => {
    const { runtime, db, cleanup } = testRuntime({ [writeTwice.name]: writeTwice });
    try {
      await runtime.call(writeTwice.name, { failBetween: false });
      expect(db.transactionsOpened).toBe(1);
      expect(db.commits).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("rolls back the whole operation when it fails partway through", async () => {
    const { runtime, db, cleanup } = testRuntime({ [writeTwice.name]: writeTwice });
    try {
      await expect(runtime.call(writeTwice.name, { failBetween: true })).rejects.toBeInstanceOf(
        GuardRejectedError,
      );
      // The first write happened inside the operation and must not have
      // survived. A per-statement boundary leaves ["first"] here.
      expect(db.committed).toEqual([]);
      expect(db.rollbacks).toBe(1);
      expect(db.commits).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("commits everything or nothing, never half", async () => {
    const { runtime, db, cleanup } = testRuntime({ [writeTwice.name]: writeTwice });
    try {
      await runtime.call(writeTwice.name, { failBetween: false });
      expect(db.committed).toEqual(["first", "second"]);
      await expect(runtime.call(writeTwice.name, { failBetween: true })).rejects.toThrow();
      // The failed second call added nothing to what the first committed.
      expect(db.committed).toEqual(["first", "second"]);
    } finally {
      cleanup();
    }
  });

  it("resolves the snapshot before opening the transaction", async () => {
    const order: string[] = [];
    const db = new FakeDatabase();
    const runtime = new ServiceRuntime({
      transaction: (body) => {
        order.push("transaction");
        return db.run(body);
      },
      resolveSnapshot: async () => {
        order.push("resolve");
        return defaultSnapshot();
      },
    });
    const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
    registry[writeTwice.name] = writeTwice;
    try {
      await runtime.call(writeTwice.name, { failBetween: false });
      // Resolving inside the boundary would hold the transaction open
      // across a settings read, and on a cache miss would issue database
      // reads from inside a transaction opened for something else.
      expect(order).toEqual(["resolve", "transaction"]);
    } finally {
      delete registry[writeTwice.name];
    }
  });
});

describe("errors leaving the runtime", () => {
  it("refuses an unregistered operation name rather than dispatching it", async () => {
    const { runtime, db, cleanup } = testRuntime({});
    try {
      const error = await runtime.call("not_registered", {}).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("not_found");
      // And it never got as far as opening a transaction for it.
      expect(db.transactionsOpened).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("names the offending field when input fails the operation's schema", async () => {
    const needsTitle = defineOperation({
      name: "test_needs_title",
      kind: "write",
      summary: "Requires a non-empty title.",
      input: z.object({ title: z.string().min(1) }).strict(),
      async handler() {
        return { ok: true };
      },
    });
    const { runtime, cleanup } = testRuntime({ [needsTitle.name]: needsTitle });
    try {
      const error = (await runtime
        .call(needsTitle.name, { title: "" })
        .catch((e: unknown) => e)) as InvalidInputError;
      expect(error.code).toBe("invalid_input");
      // The field, not just the message — this is what conformance
      // compares across adapters.
      expect(error.fields).toEqual(["title"]);
    } finally {
      cleanup();
    }
  });

  it("wraps an unexpected throw as internal without leaking its message", async () => {
    const explodes = defineOperation({
      name: "test_explodes",
      kind: "read",
      summary: "Throws something that is not a service error.",
      input: z.object({}).strict(),
      async handler(): Promise<never> {
        throw new TypeError("connect ECONNREFUSED at postgres://someone:hunter2@host/db");
      },
    });
    const { runtime, cleanup } = testRuntime({ [explodes.name]: explodes });
    try {
      const error = (await runtime
        .call(explodes.name, {})
        .catch((e: unknown) => e)) as InvalidInputError;
      expect(isServiceError(error)).toBe(true);
      expect(error.code).toBe("internal");
      // The underlying text routinely carries a connection string; it must
      // stay in `cause` for the logs and never reach a caller's message.
      expect(error.message).not.toContain("ECONNREFUSED");
      expect(error.message).not.toContain("hunter2");
      expect((error.cause as Error).message).toContain("ECONNREFUSED");
    } finally {
      cleanup();
    }
  });

  it("passes a service error through unchanged rather than rewrapping it", async () => {
    const { runtime, cleanup } = testRuntime({ [writeTwice.name]: writeTwice });
    try {
      const error = (await runtime
        .call(writeTwice.name, { failBetween: true })
        .catch((e: unknown) => e)) as GuardRejectedError;
      expect(error).toBeInstanceOf(GuardRejectedError);
      expect(error.code).toBe("guard_rejected");
      // The rule identifier survives the boundary — §22's third assertion
      // is computed from exactly this value.
      expect(error.guard).toBe("test.always_refuses");
      expect(error.toRejection()).toEqual({
        code: "guard_rejected",
        fields: ["failBetween"],
        guard: "test.always_refuses",
      });
    } finally {
      cleanup();
    }
  });
});
