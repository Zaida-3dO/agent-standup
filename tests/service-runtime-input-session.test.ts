// The session-id collapse at the dispatch seam — PR #423, `runtime.ts`'s
// `callerWithInputSession`.
//
// The seam exists because a session identifies itself in two different
// places depending on the transport. An HTTP MCP call proves one in the
// envelope (`X-Standup-Session`, read by `../mcp/http.ts`); a stdio call
// has no envelope at all and names itself only in the operation's own
// `sessionId` input field. Before this seam, the second kind reached the
// interventions deliverer with `caller.sessionId` undefined and was handed
// nothing back, however much had been found for it — the channel looked
// wired and was silent.
//
// **Why this file exists.** The behaviour shipped correct and completely
// untested: reverting the seam to `const caller = rawCaller` left the whole
// repository green (505 files / 10,729 tests), so the next refactor of
// `#dispatch` could delete it and nothing would notice. `callerWithInputSession`
// is module-private, so there is no unit surface either — these drive the
// public `call()` seam instead, which is the thing every adapter crosses.
//
// The assertions are made against the REAL deliverer (`createServiceDeliverer`)
// rather than a stub that re-implements the rule, so what is pinned is the
// production decision about whether a session gets its findings — not this
// file's own idea of one. `now` is injected so the digest's five-minute
// clock is deterministic and nothing here waits.
import { describe, expect, it } from "vitest";
import { ServiceRuntime, defineOperation, type ServiceContext } from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import { createServiceDeliverer } from "@/lib/interventions/service-delivery";
import type { InterventionFinding } from "@/lib/interventions/types";
import { isServiceError } from "@/lib/service";
import { z } from "zod";

/** One finding, shaped as the registry produces them. */
const FINDING: InterventionFinding = {
  id: "input-session-finding",
  source: "builtin",
  phase: "post",
  audience: "orchestrator",
  level: "nudge",
  timing: "digest",
  messages: { plain: "plain text", prominent: "prominent text" },
};

/**
 * An operation that DECLARES `sessionId` as an ordinary input field — the
 * shape every session-scoped op in the registry has (`note`, `checkpoint`,
 * `heartbeat`), and the shape the seam exists to serve.
 *
 * It returns what the runtime put in `ctx.caller`, so a test can read the
 * collapsed identity the handler actually saw rather than inferring it.
 */
const declaresSession = defineOperation({
  name: "test_input_session_declares",
  kind: "write",
  summary: "Declares sessionId as an input field, and reports the caller it saw.",
  input: z.object({ sessionId: z.string().nullable().optional() }).strict(),
  async handler(ctx: ServiceContext) {
    return { sawSessionId: ctx.caller.sessionId ?? null };
  },
});

/**
 * An operation that declares NO `sessionId`. Its schema is `.strict()`,
 * like every operation schema in the registry, which is what makes the
 * smuggling case below a refusal rather than a silent identity change.
 */
const declaresNothing = defineOperation({
  name: "test_input_session_declares_not",
  kind: "write",
  summary: "Declares no sessionId at all.",
  input: z.object({}).strict(),
  async handler(ctx: ServiceContext) {
    return { sawSessionId: ctx.caller.sessionId ?? null };
  },
});

/** A runtime wired to the real deliverer, with a frozen clock. */
function harness() {
  const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
  registry[declaresSession.name] = declaresSession;
  registry[declaresNothing.name] = declaresNothing;

  const now = 1_700_000_000_000;
  const deliverer = createServiceDeliverer({ now: () => now });

  const runtime = new ServiceRuntime({
    transaction: async <T>(body: (db: never) => Promise<T>): Promise<T> =>
      await body({
        $queryRawUnsafe: async <R = unknown>(): Promise<R> => [] as unknown as R,
        $executeRawUnsafe: async (): Promise<number> => 0,
      } as never),
    resolveSnapshot: async () => defaultSnapshot(),
    deliverInterventions: deliverer,
  });

  return {
    runtime,
    deliverer,
    now,
    cleanup: () => {
      delete registry[declaresSession.name];
      delete registry[declaresNothing.name];
    },
  };
}

describe("a session named only in an operation's input reaches the delivery seam", () => {
  // The acceptance criterion of PR #423, as a test rather than a manual
  // observation against a dev server that no longer exists.
  //
  // The digest is held for SESSION-X BEFORE the call, and the call names
  // SESSION-X only in its input — no envelope session anywhere. If the seam
  // is reverted, the deliverer sees `sessionId: undefined`, returns the
  // result untouched, and this fails on the missing `interventions` key.
  it("delivers a held digest to a session that named itself only in the input field", async () => {
    const { runtime, deliverer, now, cleanup } = harness();
    try {
      // Held five minutes earlier so the digest is due at `now`.
      deliverer.hold("SESSION-X", [FINDING], now - 5 * 60_000);
      expect(deliverer.pendingCount("SESSION-X")).toBe(1);

      const response = (await runtime.call(declaresSession.name, { sessionId: "SESSION-X" })) as {
        interventions?: { digest?: { findings?: { id: string }[] } };
      };

      expect(response).toHaveProperty("interventions");
      expect(response.interventions?.digest?.findings?.[0]?.id).toBe("input-session-finding");
    } finally {
      cleanup();
    }
  });

  // The "fills, never overwrites" rule. An envelope session is something the
  // transport PROVED; an input field is something the caller SAID. If the
  // input could overwrite the envelope, a caller could claim to be another
  // session by typing its id — so the precedence is the security-shaped half
  // of this seam, and it is guaranteed by one `if` with nothing watching it.
  it("lets a proved envelope session outrank a self-reported input one", async () => {
    const { runtime, cleanup } = harness();
    try {
      const response = (await runtime.call(
        declaresSession.name,
        { sessionId: "FROM-INPUT" },
        { caller: { sessionId: "FROM-HEADER" } },
      )) as { sawSessionId: string | null };

      expect(response.sawSessionId).toBe("FROM-HEADER");
    } finally {
      cleanup();
    }
  });

  // AC4 — `null` and omitted are both "no session", and neither throws.
  // The distinction was made deliberately in the seam (`typeof fromInput
  // !== "string"` covers null) and nothing pinned it. A caller that passes
  // an explicit null must not be given some other session's digest, and must
  // not be refused either.
  it("treats an explicit null sessionId exactly like an omitted one", async () => {
    const { runtime, deliverer, now, cleanup } = harness();
    try {
      // Something IS waiting, keyed by a real session — so a seam that
      // collapsed null into some key would have a digest available to leak.
      deliverer.hold("SESSION-X", [FINDING], now - 5 * 60_000);

      const withNull = (await runtime.call(declaresSession.name, { sessionId: null })) as {
        sawSessionId: string | null;
      };
      const omitted = (await runtime.call(declaresSession.name, {})) as {
        sawSessionId: string | null;
      };

      expect(withNull.sawSessionId).toBeNull();
      expect(omitted.sawSessionId).toBeNull();
      expect(withNull).not.toHaveProperty("interventions");
      expect(omitted).not.toHaveProperty("interventions");
      // Nothing was consumed on either call.
      expect(deliverer.pendingCount("SESSION-X")).toBe(1);
    } finally {
      cleanup();
    }
  });

  // The seam reads `parsed.data`, which is the output of the operation's own
  // `.strict()` schema — so an operation that declares no `sessionId` cannot
  // have one smuggled in. This is what stops the seam widening into "any
  // call may assert any identity".
  it("refuses a sessionId an operation does not declare, rather than adopting it", async () => {
    const { runtime, cleanup } = harness();
    try {
      const error = await runtime
        .call(declaresNothing.name, { sessionId: "SMUGGLED" })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(error).not.toBeNull();
      expect(isServiceError(error)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
