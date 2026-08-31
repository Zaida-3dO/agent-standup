// The intervention payload on the ordinary service response - MILESTONES.md
// #128 ("they ride back on the ordinary service response ... not only
// through the hook").
//
// The runtime is the seam every call crosses on every adapter, so attaching
// here is what makes `transition_item`, `record_artifact`, `note` and
// `claim` carry the field without any of them knowing the feature exists.
// That breadth is also the risk, and these are the properties that keep it
// safe to sit on every response in the system:
//
//   - a call that triggers nothing returns exactly what it returned before,
//   - the deliverer never runs inside the transaction, so it cannot query,
//   - a deliverer that throws cannot fail a call that already committed,
//   - a runtime built without one behaves as though this never shipped.
import { describe, expect, it } from "vitest";
import {
  ServiceRuntime,
  defineOperation,
  type ServiceContext,
  type TransactionHandle,
} from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import { z } from "zod";

/** An operation that reads one row, so a transaction is genuinely opened. */
const readsOneRow = defineOperation({
  name: "test_interventions_read",
  kind: "read",
  summary: "Reads a row so the transaction is real.",
  input: z.object({}).strict(),
  async handler(ctx: ServiceContext) {
    await ctx.db.$queryRawUnsafe("rows");
    return { id: "item-1" };
  },
});

interface Harness {
  readonly runtime: ServiceRuntime;
  readonly cleanup: () => void;
  /** Whether the transaction was still open when the deliverer ran. */
  readonly openWhenDelivered: boolean[];
}

function harness(
  deliverer?: (result: unknown, caller: { sessionId?: string }) => unknown,
): Harness {
  const openWhenDelivered: boolean[] = [];
  let open = false;

  const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
  registry[readsOneRow.name] = readsOneRow;

  const runtime = new ServiceRuntime({
    transaction: async <T>(body: (db: TransactionHandle) => Promise<T>): Promise<T> => {
      open = true;
      try {
        return await body({
          $queryRawUnsafe: async <R = unknown>(): Promise<R> => [] as unknown as R,
          $executeRawUnsafe: async (): Promise<number> => 0,
        });
      } finally {
        open = false;
      }
    },
    resolveSnapshot: async () => defaultSnapshot(),
    ...(deliverer === undefined
      ? {}
      : {
          deliverInterventions: (result: unknown, caller: { sessionId?: string }) => {
            openWhenDelivered.push(open);
            return deliverer(result, caller);
          },
        }),
  });

  return {
    runtime,
    openWhenDelivered,
    cleanup: () => {
      delete registry[readsOneRow.name];
    },
  };
}

describe("the intervention payload on an ordinary service response", () => {
  // A runtime built before this parameter existed, and one built without it
  // now, must be indistinguishable. Roughly forty construction sites pass no
  // deliverer, and none of them were changed.
  it("returns the operation's own output when no deliverer is configured", async () => {
    const { runtime, cleanup } = harness();
    try {
      expect(await runtime.call(readsOneRow.name, {})).toEqual({ id: "item-1" });
    } finally {
      cleanup();
    }
  });

  it("returns the operation's own output when the deliverer attaches nothing", async () => {
    const { runtime, cleanup } = harness((result) => result);
    try {
      expect(await runtime.call(readsOneRow.name, {})).toEqual({ id: "item-1" });
    } finally {
      cleanup();
    }
  });

  it("attaches the payload the deliverer produced", async () => {
    const { runtime, cleanup } = harness((result) => ({
      result,
      interventions: { findings: [] },
    }));
    try {
      expect(await runtime.call(readsOneRow.name, {})).toEqual({
        result: { id: "item-1" },
        interventions: { findings: [] },
      });
    } finally {
      cleanup();
    }
  });

  // The cost rule, structurally. `hook_decision` touches no table on the
  // ordinary path and a test pins that; attaching a payload to every
  // response must not be the thing that undoes it. The deliverer runs after
  // the transaction has closed, so there is no handle for it to query
  // through even if a later change tried to give it one.
  it("runs the deliverer only after the transaction has closed", async () => {
    const { runtime, cleanup, openWhenDelivered } = harness((result) => result);
    try {
      await runtime.call(readsOneRow.name, {});
      expect(openWhenDelivered).toEqual([false]);
    } finally {
      cleanup();
    }
  });

  it("hands the caller's session to the deliverer so a batch can be keyed by it", async () => {
    const seen: (string | undefined)[] = [];
    const { runtime, cleanup } = harness((result, caller) => {
      seen.push(caller.sessionId);
      return result;
    });
    try {
      await runtime.call(readsOneRow.name, {}, { caller: { sessionId: "s1" } });
      expect(seen).toEqual(["s1"]);
    } finally {
      cleanup();
    }
  });

  // An advisory field is never worth failing a call that already committed.
  // The transaction is closed by the time this runs, so throwing here would
  // report a failure for work that actually succeeded - the caller would
  // retry a write that had already landed.
  it("returns the result unchanged when the deliverer throws", async () => {
    const { runtime, cleanup } = harness(() => {
      throw new Error("deliverer exploded");
    });
    try {
      expect(await runtime.call(readsOneRow.name, {})).toEqual({ id: "item-1" });
    } finally {
      cleanup();
    }
  });
});
