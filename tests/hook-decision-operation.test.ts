// `hook_decision` service operation — MILESTONES.md #125.
//
// Runs through the real `ServiceRuntime` (input parsing, settings
// resolution, the transaction boundary) but against a modelled, in-memory
// transaction handle rather than Postgres — this operation reads no table
// (same posture as `service_info`), so a real database proves nothing extra
// here.
//
// **What is worth pinning, now that nothing blocks yet.** A suite over an
// operation that always answers `allow` is trivially green, so the
// assertions that actually carry weight are the ones about the *shape* of
// the contract rather than the verdict:
//
//   - **`canBlock` tracks the phase and only the phase.** This is the
//     server's half of "a post entry cannot block" — the hook enforces the
//     same rule independently, so the invariant survives either side being
//     wrong, but not both.
//   - **The input schema is strict and validates before the handler runs.**
//     The hook is the highest-volume caller in the system and the one most
//     likely to drift; a field it starts sending that this schema does not
//     know about must fail loudly rather than be dropped.
//   - **The database is never touched.** Asserted with a handle that throws,
//     so this cannot pass by accident.
import { describe, expect, it } from "vitest";
import { ServiceRuntime } from "@/lib/service/runtime";
import type { TransactionHandle } from "@/lib/service/context";
import { InvalidInputError } from "@/lib/service/errors";
import { defaultSnapshot } from "@/lib/settings";

/** A transaction handle that fails loudly if the operation ever queries it. */
function untouchableHandle(): TransactionHandle {
  return {
    $queryRawUnsafe: async () => {
      throw new Error("hook_decision must not touch the database");
    },
    $executeRawUnsafe: async () => {
      throw new Error("hook_decision must not touch the database");
    },
  };
}

function runtime(): ServiceRuntime {
  return new ServiceRuntime({
    transaction: (body) => body(untouchableHandle()),
    resolveSnapshot: async () => defaultSnapshot(),
  });
}

type Answer = { decision: string; reason: string | null; canBlock: boolean };

async function call(input: Record<string, unknown>): Promise<Answer> {
  return (await runtime().call("hook_decision", input)) as Answer;
}

describe("what the operation answers", () => {
  it("allows a pre-tool call, because nothing gates yet", async () => {
    // Not a permissive default that could be misconfigured — there is no
    // configuration here to get wrong. Gating returns with #128, and this
    // assertion is what will have to change when it does.
    const answer = await call({
      eventType: "PreToolUse",
      sessionId: "s1",
      tool: "Bash",
      command: "git push --force",
    });

    expect(answer.decision).toBe("allow");
    expect(answer.reason).toBeNull();
  });

  it("allows a post-tool call", async () => {
    const answer = await call({
      eventType: "PostToolUse",
      sessionId: "s1",
      tool: "Bash",
      command: "ls",
      toolResult: "a.ts b.ts",
    });

    expect(answer.decision).toBe("allow");
  });

  it("allows a Stop, which carries no tool or command at all", async () => {
    const answer = await call({ eventType: "Stop", sessionId: "s1" });
    expect(answer.decision).toBe("allow");
  });
});

describe("canBlock tracks the phase", () => {
  it("is true for PreToolUse", async () => {
    expect((await call({ eventType: "PreToolUse", sessionId: "s1" })).canBlock).toBe(true);
  });

  it("is false for PostToolUse", async () => {
    // The server's half of the invariant. A change that made this true
    // would let a future gating row emit a block on a call that already
    // ran — which only the hook's own `canBlock` would then catch.
    expect((await call({ eventType: "PostToolUse", sessionId: "s1" })).canBlock).toBe(false);
  });

  it("is false for Stop", async () => {
    expect((await call({ eventType: "Stop", sessionId: "s1" })).canBlock).toBe(false);
  });

  it("does not depend on the tool or the command", async () => {
    // The rule is about the phase and nothing else. A `pre` call with no
    // command is still a moment at which something could be refused.
    expect((await call({ eventType: "PreToolUse", sessionId: "s1" })).canBlock).toBe(true);
    expect(
      (await call({ eventType: "PostToolUse", sessionId: "s1", tool: "Bash", command: "rm -rf /" }))
        .canBlock,
    ).toBe(false);
  });
});

describe("input validation happens before the handler", () => {
  it("rejects an unrecognised event type", async () => {
    await expect(call({ eventType: "BeforeToolUse", sessionId: "s1" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("rejects a missing session id", async () => {
    await expect(call({ eventType: "PreToolUse" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects an empty session id", async () => {
    await expect(call({ eventType: "PreToolUse", sessionId: "" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("rejects an unknown field rather than dropping it", async () => {
    // `.strict()`. The hook is the caller most likely to drift, and a field
    // it starts sending that is silently discarded is a change nobody sees
    // until the behaviour it was meant to drive never arrives.
    await expect(
      call({ eventType: "PreToolUse", sessionId: "s1", matchedList: "ask" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects a tool result past the operation's own ceiling", async () => {
    // The hook truncates before sending. This bound exists because an
    // operation must not trust its caller to have applied a limit the
    // caller could change.
    await expect(
      call({
        eventType: "PostToolUse",
        sessionId: "s1",
        toolResult: "x".repeat(8001),
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("accepts a tool result at the ceiling", async () => {
    const answer = await call({
      eventType: "PostToolUse",
      sessionId: "s1",
      toolResult: "x".repeat(8000),
    });
    expect(answer.decision).toBe("allow");
  });

  it("accepts an empty command, which is different from an absent one", async () => {
    const answer = await call({ eventType: "PreToolUse", sessionId: "s1", command: "" });
    expect(answer.decision).toBe("allow");
  });

  it("rejects an empty tool name", async () => {
    await expect(
      call({ eventType: "PreToolUse", sessionId: "s1", tool: "" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("the operation touches no table", () => {
  it("completes against a transaction handle that throws on any query", async () => {
    // The handle above throws on both raw methods, so this passing at all
    // is the assertion — a decision made on every tool call is the
    // highest-volume path in the system and must stay a dumb pipe.
    for (const eventType of ["PreToolUse", "PostToolUse", "Stop"]) {
      await expect(call({ eventType, sessionId: "s1" })).resolves.toMatchObject({
        decision: "allow",
      });
    }
  });
});
