// `hook_decision` service operation — MILESTONES.md #41: "The hook decision
// as a service call". Runs through the real `ServiceRuntime` (input parsing,
// settings resolution, the transaction boundary) but against a modelled,
// in-memory transaction handle rather than Postgres — this operation reads
// no table (same posture as `service_info`), so a real database proves
// nothing extra here. `tests/hook-decision.test.ts` covers the matching
// logic itself; this file covers the operation wiring around it: settings
// actually reach the handler, `Stop` events with no command are handled,
// input validation happens before the handler runs, and the operation never
// touches `ctx.db`.
import { describe, expect, it } from "vitest";
import { ServiceRuntime } from "@/lib/service/runtime";
import type { TransactionHandle } from "@/lib/service/context";
import { InvalidInputError } from "@/lib/service/errors";
import { resolveSettings, defaultSnapshot } from "@/lib/settings";

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

function runtimeWithSnapshot(snapshot: ReturnType<typeof defaultSnapshot>): ServiceRuntime {
  return new ServiceRuntime({
    transaction: (body) => body(untouchableHandle()),
    resolveSnapshot: async () => snapshot,
  });
}

describe("hook_decision operation", () => {
  it("allows a PostToolUse command matching the configured allow-list", async () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "hook.allow_patterns", value: ["^git status$"] }],
      revision: 1n,
    });
    const runtime = runtimeWithSnapshot(snapshot);
    const result = (await runtime.call("hook_decision", {
      eventType: "PostToolUse",
      sessionId: "s1",
      tool: "Bash",
      command: "git status",
    })) as { decision: string };
    expect(result.decision).toBe("allow");
  });

  it("asks for a command matching the configured ask-list", async () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "hook.ask_patterns", value: ["^rm "] }],
      revision: 1n,
    });
    const runtime = runtimeWithSnapshot(snapshot);
    const result = (await runtime.call("hook_decision", {
      eventType: "PreToolUse",
      sessionId: "s1",
      tool: "Bash",
      command: "rm -rf dist",
    })) as { decision: string };
    expect(result.decision).toBe("ask");
  });

  it("denies a command matching neither configured list — the default with nothing set", async () => {
    // Uses the plain default snapshot: both pattern lists default to `[]`,
    // so this proves the *installed default* is fail-closed, not merely
    // that the matcher is when handed empty lists directly.
    const runtime = runtimeWithSnapshot(defaultSnapshot());
    const result = (await runtime.call("hook_decision", {
      eventType: "PreToolUse",
      sessionId: "s1",
      tool: "Bash",
      command: "curl https://example.invalid",
    })) as { decision: string };
    expect(result.decision).toBe("deny");
  });

  it("allows a Stop event with no command — nothing to be unsure about", async () => {
    const runtime = runtimeWithSnapshot(defaultSnapshot());
    const result = (await runtime.call("hook_decision", {
      eventType: "Stop",
      sessionId: "s1",
    })) as { decision: string; matchedList: unknown };
    expect(result.decision).toBe("allow");
    expect(result.matchedList).toBeNull();
  });

  it("rejects a missing sessionId before the handler runs, as invalid_input", async () => {
    const runtime = runtimeWithSnapshot(defaultSnapshot());
    const error = await runtime
      .call("hook_decision", { eventType: "PreToolUse", tool: "Bash", command: "ls" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).fields).toContain("sessionId");
  });

  it("rejects an unrecognised eventType as invalid_input rather than silently allowing", async () => {
    const runtime = runtimeWithSnapshot(defaultSnapshot());
    const error = await runtime
      .call("hook_decision", {
        eventType: "SomethingElse",
        sessionId: "s1",
        command: "ls",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInputError);
  });

  it("rejects an unknown extra field — schema is strict, like every other operation", async () => {
    const runtime = runtimeWithSnapshot(defaultSnapshot());
    const error = await runtime
      .call("hook_decision", {
        eventType: "PreToolUse",
        sessionId: "s1",
        command: "ls",
        extra: true,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInputError);
  });

  it("reads the settings snapshot the runtime resolved, not a fresh default", async () => {
    // Same allow-pattern proof as the first test, but phrased to catch a
    // handler that ignored `ctx.settings` and read some other source
    // (e.g. a module-level default) instead: an empty-list snapshot must
    // deny the exact command an overridden one would allow.
    const emptySnapshot = defaultSnapshot();
    const overriddenSnapshot = resolveSettings({
      overrides: [{ key: "hook.allow_patterns", value: ["^git status$"] }],
      revision: 7n,
    });

    const withEmpty = runtimeWithSnapshot(emptySnapshot);
    const withOverride = runtimeWithSnapshot(overriddenSnapshot);

    const input = {
      eventType: "PostToolUse" as const,
      sessionId: "s1",
      tool: "Bash",
      command: "git status",
    };

    const deniedResult = (await withEmpty.call("hook_decision", input)) as { decision: string };
    const allowedResult = (await withOverride.call("hook_decision", input)) as {
      decision: string;
    };

    expect(deniedResult.decision).toBe("deny");
    expect(allowedResult.decision).toBe("allow");
  });
});
