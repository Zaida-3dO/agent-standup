// The producer on the ordinary service response — MILESTONES.md #128.
//
// `service-runtime-interventions.test.ts` covers the delivery half: a payload
// attaches, the deliverer runs after the transaction closes, a throw is
// swallowed. This covers the half that had nothing behind it — the producer
// that supplies the findings the deliverer decides about.
//
// The properties below are the ones that make a producer safe to run on every
// write in the system, and each is the answer to a way this could go wrong:
//
//   - it runs INSIDE the transaction, because it is the only thing on this
//     path with a database handle to ask item-state questions through;
//   - it runs AFTER the handler, so it sees the world the caller just changed
//     rather than the one a moment before;
//   - it does not run on reads, which is what keeps the lookups off the
//     highest-volume path;
//   - it does not run for a caller with no session, because every entry it
//     can fire is about the item a session holds;
//   - a rehearsal that rolled back delivers nothing, because its findings
//     describe a state the transaction abandoned;
//   - a producer that throws cannot fail the write it rode in on;
//   - a build without one behaves exactly as though this never shipped.
import { describe, expect, it } from "vitest";
import {
  ServiceRuntime,
  defineOperation,
  type ServiceContext,
  type TransactionHandle,
} from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import type { InterventionFinding } from "@/lib/interventions/types";
import { z } from "zod";
import { RehearsalRollback } from "@/lib/service/operations/rehearsal-rollback";
import type { TransitionOutcome } from "@/lib/service/state-machine/transition";

/** The empty input both test operations take. */
const EMPTY = z.object({}).strict();

/** One finding, shaped as the registry produces them. */
const NUDGE: InterventionFinding = {
  id: "test-finding",
  source: "builtin",
  phase: "post",
  audience: "orchestrator",
  level: "nudge",
  // `immediate`, so the assertions here are about the producer and the
  // wiring rather than about the digest's five-minute clock, which
  // `interventions-digest.test.ts` already owns.
  timing: "immediate",
  messages: { plain: "plain text", prominent: "prominent text" },
};

const write = defineOperation({
  name: "test_producer_write",
  kind: "write",
  summary: "A write, so the producer is eligible.",
  input: EMPTY,
  async handler(_ctx: ServiceContext) {
    return { wrote: true };
  },
});

const read = defineOperation({
  name: "test_producer_read",
  kind: "read",
  summary: "A read, so the producer must stay off it.",
  input: EMPTY,
  async handler(_ctx: ServiceContext) {
    return { read: true };
  },
});

/**
 * A write that rehearses: it throws the rollback sentinel the runtime
 * unwraps, exactly as `transition_item`'s `dryRun` branch does.
 */
const rehearses = defineOperation({
  name: "test_producer_rehearsal",
  kind: "write",
  summary: "A write that abandons its transaction the way a dryRun does.",
  input: EMPTY,
  async handler(_ctx: ServiceContext) {
    throw new RehearsalRollback({ allowed: true } as unknown as TransitionOutcome);
  },
});

interface Recorded {
  /** Whether the transaction was open each time the producer ran. */
  readonly openWhenProduced: boolean[];
  /** Whether the handler had already returned each time it ran. */
  readonly handlerDoneWhenProduced: boolean[];
  /** The sessions the producer was asked about. */
  readonly sessions: string[];
}

function harness(options: {
  produce?: (o: {
    db: TransactionHandle;
    sessionId: string;
  }) => Promise<readonly InterventionFinding[]>;
  operation?: { name: string };
}) {
  const recorded: Recorded = { openWhenProduced: [], handlerDoneWhenProduced: [], sessions: [] };
  let open = false;
  let handlerDone = false;

  const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
  registry[write.name] = {
    ...write,
    async handler(ctx: ServiceContext, input: never) {
      const out = await write.handler(ctx, input);
      handlerDone = true;
      return out;
    },
  };
  registry[read.name] = read;
  registry[rehearses.name] = rehearses;

  const runtime = new ServiceRuntime({
    transaction: async <T>(body: (db: TransactionHandle) => Promise<T>): Promise<T> => {
      open = true;
      handlerDone = false;
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
    // Passes the produced findings straight through, so an assertion below
    // reads what the producer supplied rather than what a digest decided.
    deliverInterventions: (result, _caller, findings) =>
      findings.length === 0 ? result : { result, interventions: { findings } },
    ...(options.produce === undefined
      ? {}
      : {
          produceInterventions: async (o) => {
            recorded.openWhenProduced.push(open);
            recorded.handlerDoneWhenProduced.push(handlerDone);
            recorded.sessions.push(o.sessionId);
            return await options.produce!(o);
          },
        }),
  });

  return {
    runtime,
    recorded,
    cleanup: () => {
      delete registry[write.name];
      delete registry[read.name];
      delete registry[rehearses.name];
    },
  };
}

const oneFinding = async () => [NUDGE];

describe("the producer behind the service-delivery channel", () => {
  it("attaches what the producer found to the response", async () => {
    const { runtime, cleanup } = harness({ produce: oneFinding });
    try {
      const response = await runtime.call(write.name, {}, { caller: { sessionId: "s1" } });
      expect(response).toEqual({ result: { wrote: true }, interventions: { findings: [NUDGE] } });
    } finally {
      cleanup();
    }
  });

  // The property the whole design rests on. The deliverer is synchronous and
  // holds no handle, deliberately — so if the producer did not run in here,
  // nothing on this path could ask an item-state question at all, and every
  // entry it serves would be permanently silent while looking wired.
  it("runs the producer inside the transaction", async () => {
    const { runtime, cleanup, recorded } = harness({ produce: oneFinding });
    try {
      await runtime.call(write.name, {}, { caller: { sessionId: "s1" } });
      expect(recorded.openWhenProduced).toEqual([true]);
    } finally {
      cleanup();
    }
  });

  // Asking before the handler would report the world as it was one moment
  // before the caller changed it — so a session that had just recorded its
  // pull request would be told to open one.
  it("runs the producer after the operation's own handler", async () => {
    const { runtime, cleanup, recorded } = harness({ produce: oneFinding });
    try {
      await runtime.call(write.name, {}, { caller: { sessionId: "s1" } });
      expect(recorded.handlerDoneWhenProduced).toEqual([true]);
    } finally {
      cleanup();
    }
  });

  // The cost gate. These are real queries on the seam every call crosses, and
  // every entry they serve describes a fact only a write can change — so a
  // read would pay for an answer identical to the last write's.
  it("does not run the producer on a read", async () => {
    const { runtime, cleanup, recorded } = harness({ produce: oneFinding });
    try {
      const response = await runtime.call(read.name, {}, { caller: { sessionId: "s1" } });
      expect(recorded.sessions).toEqual([]);
      expect(response).toEqual({ read: true });
    } finally {
      cleanup();
    }
  });

  // Every entry on this path is about the item a session holds, and there is
  // no such thing for a call that names none.
  it("does not run the producer for a caller with no session", async () => {
    const { runtime, cleanup, recorded } = harness({ produce: oneFinding });
    try {
      const response = await runtime.call(write.name, {});
      expect(recorded.sessions).toEqual([]);
      expect(response).toEqual({ wrote: true });
    } finally {
      cleanup();
    }
  });

  // A session with nothing to say gets exactly the object it always got —
  // by identity, not a copy — which is what makes this safe on every write.
  it("returns the result untouched when the producer finds nothing", async () => {
    const { runtime, cleanup } = harness({ produce: async () => [] });
    try {
      const response = await runtime.call(write.name, {}, { caller: { sessionId: "s1" } });
      expect(response).toEqual({ wrote: true });
      expect(response).not.toHaveProperty("interventions");
    } finally {
      cleanup();
    }
  });

  // An advisory message is never worth failing a write the caller asked for
  // and the database has already done the work for. This one matters more
  // than the deliverer's equivalent, because it throws INSIDE the
  // transaction: an escape would roll the write back.
  it("commits the write and returns it when the producer throws", async () => {
    const { runtime, cleanup } = harness({
      produce: async () => {
        throw new Error("producer exploded");
      },
    });
    try {
      const response = await runtime.call(write.name, {}, { caller: { sessionId: "s1" } });
      expect(response).toEqual({ wrote: true });
    } finally {
      cleanup();
    }
  });

  // A `dryRun` abandons its transaction on purpose, so nothing observed
  // inside it may ride the response.
  //
  // **What this proves, precisely.** The sentinel is thrown from inside the
  // handler, so the producer — which runs on the line after the handler
  // returns — never runs at all on this path. That is the mechanism doing
  // the work here, not the `produced = []` reset in the catch, which is
  // defensive against a future rehearsal that threw later. Mutation testing
  // established the difference: deleting that reset leaves this test green.
  // It is named rather than papered over, because a test whose comment
  // claims a guarantee it does not exercise is the false confidence this
  // whole change is about.
  it("delivers nothing from a rehearsal that rolled back", async () => {
    const { runtime, cleanup, recorded } = harness({ produce: oneFinding });
    try {
      const response = await runtime.call(rehearses.name, {}, { caller: { sessionId: "s1" } });
      expect(response).toEqual({ outcome: { allowed: true } });
      expect(response).not.toHaveProperty("interventions");
      // The mechanism, asserted rather than assumed: the producer was never
      // reached, which is why nothing could be delivered.
      expect(recorded.sessions).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // A runtime built without a producer behaves exactly as one built before
  // the parameter existed — the same default the deliverer already takes,
  // and the reason no existing construction site needed changing.
  it("behaves as though the feature never shipped when no producer is configured", async () => {
    const { runtime, cleanup } = harness({});
    try {
      expect(await runtime.call(write.name, {}, { caller: { sessionId: "s1" } })).toEqual({
        wrote: true,
      });
    } finally {
      cleanup();
    }
  });
});
