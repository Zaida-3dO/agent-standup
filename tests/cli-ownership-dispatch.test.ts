// MILESTONES.md #82 — `standup session claim/release/heartbeat/checkpoint/
// my-work`, `standup item note/orientation`, `standup crew name`: dispatch
// and input building, driven through `runCommand` exactly like
// tests/cli-dispatch.test.ts drives row #79's own commands. No database is
// needed here — the binding is a recorder that never reaches a service, so
// what's under test is purely "does this row's command table turn argv into
// the right operation name and the right input object", the same scope
// tests/cli-dispatch.test.ts covers for `item get`/`item list`/`item create`.
import { describe, expect, it } from "vitest";
import { ALIASES, COMMANDS, EXIT, lookupCommand, runCommand } from "@/lib/cli";
import type { Binding } from "@/lib/cli";

/** A binding that records every call and always accepts — same shape as tests/cli-dispatch.test.ts's `recorder()`. */
function recorder(): Binding & { calls: { operation: string; input: unknown }[] } {
  const calls: { operation: string; input: unknown }[] = [];
  return {
    name: "direct",
    calls,
    async invoke(operation, input) {
      calls.push({ operation, input });
      return { ok: true, data: { operation } };
    },
  };
}

describe("<noun> <verb> resolves to the right operation", () => {
  it.each([
    [["session", "claim", "item-1"], "claim"],
    [["session", "release", "item-1"], "release"],
    [["session", "heartbeat", "item-1"], "heartbeat"],
    [["session", "checkpoint", "item-1"], "checkpoint"],
    [["session", "my-work"], "my_work"],
    [["item", "note", "item-1"], "note"],
    [["item", "orientation", "item-1"], "orientation"],
    [["crew", "name"], "get_crew_name"],
  ])("%j resolves to operation %s", (words, operation) => {
    const found = lookupCommand(words);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe(operation);
  });

  it("registers exactly one command per noun/verb pair added here (no accidental duplicate)", () => {
    const pairs = COMMANDS.map((c) => `${c.noun} ${c.verb}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

describe("session claim — builds the full operation input", () => {
  it("sends itemId from the positional and every other field from its exact camelCase flag", async () => {
    const binding = recorder();
    await runCommand(
      [
        "session",
        "claim",
        "item-1",
        "--role",
        "builder",
        "--holderType",
        "agent",
        "--holderId",
        "crew-a",
        "--session",
        "s1",
        "--machine",
        "laptop",
      ],
      binding,
    );
    expect(binding.calls).toEqual([
      {
        operation: "claim",
        input: {
          itemId: "item-1",
          role: "builder",
          holderType: "agent",
          holderId: "crew-a",
          sessionId: "s1",
          machine: "laptop",
        },
      },
    ]);
  });

  it("refuses with no item id, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["session", "claim"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["itemId"]);
  });

  it("coerces --pid to a number, the one non-string field in this schema", async () => {
    const binding = recorder();
    await runCommand(["session", "claim", "item-1", "--role", "builder", "--pid", "4242"], binding);
    const input = binding.calls[0]?.input as Record<string, unknown>;
    expect(input.pid).toBe(4242);
    expect(typeof input.pid).toBe("number");
  });

  it("leaves a non-numeric --pid as the raw string, for the operation's own schema to refuse", async () => {
    const binding = recorder();
    await runCommand(["session", "claim", "item-1", "--pid", "not-a-number"], binding);
    const input = binding.calls[0]?.input as Record<string, unknown>;
    expect(input.pid).toBe("not-a-number");
  });

  it("keeps --json and --as out of the operation's input, same as item create does", async () => {
    const binding = recorder();
    await runCommand(
      ["session", "claim", "item-1", "--role", "builder", "--json", "--as", "user-a"],
      binding,
    );
    expect(binding.calls[0]?.input).toEqual({ itemId: "item-1", role: "builder" });
  });

  it("refuses a bare value-taking flag rather than sending true as a value", async () => {
    const binding = recorder();
    const outcome = await runCommand(["session", "claim", "item-1", "--role"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });
});

describe("session release / session heartbeat — { itemId, sessionId } only", () => {
  it.each([
    ["release", "release"],
    ["heartbeat", "heartbeat"],
  ])("standup session %s sends exactly itemId and sessionId", async (verb, operation) => {
    const binding = recorder();
    await runCommand(["session", verb, "item-1", "--session", "s1"], binding);
    expect(binding.calls).toEqual([{ operation, input: { itemId: "item-1", sessionId: "s1" } }]);
  });

  it("session release with no item id refuses before the binding, naming itemId", async () => {
    const binding = recorder();
    const outcome = await runCommand(["session", "release"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["itemId"]);
    expect(binding.calls).toEqual([]);
  });

  it("an unrecognised flag still reaches the operation input rather than being silently dropped", async () => {
    // §20's own contract: "field validation is not done here." A stray flag
    // must travel through to the operation, which is the one place that
    // refuses it — proving this command does not quietly swallow a typo.
    const binding = recorder();
    await runCommand(
      ["session", "heartbeat", "item-1", "--session", "s1", "--bogus", "x"],
      binding,
    );
    expect(binding.calls[0]?.input).toEqual({ itemId: "item-1", sessionId: "s1", bogus: "x" });
  });
});

describe("session checkpoint — itemId, sessionId and body", () => {
  it("passes --body straight through, alongside itemId and sessionId", async () => {
    const binding = recorder();
    await runCommand(
      ["session", "checkpoint", "item-1", "--session", "s1", "--body", "tried X, ruled out Y"],
      binding,
    );
    expect(binding.calls).toEqual([
      {
        operation: "checkpoint",
        input: { itemId: "item-1", sessionId: "s1", body: "tried X, ruled out Y" },
      },
    ]);
  });
});

describe("session my-work — sessionId only, no positional", () => {
  it("sends sessionId from --session and nothing else", async () => {
    const binding = recorder();
    await runCommand(["session", "my-work", "--session", "s1"], binding);
    expect(binding.calls).toEqual([{ operation: "my_work", input: { sessionId: "s1" } }]);
  });

  it("sends an empty input when --session is not given — the operation's own schema is what refuses it", async () => {
    const binding = recorder();
    await runCommand(["session", "my-work"], binding);
    expect(binding.calls).toEqual([{ operation: "my_work", input: {} }]);
  });
});

describe("item note — sessionId optional, unlike the session-noun verbs", () => {
  it("builds body, actorType and actorId, all pass-through", async () => {
    const binding = recorder();
    await runCommand(
      [
        "item",
        "note",
        "item-1",
        "--body",
        "a remark",
        "--actorType",
        "person",
        "--actorId",
        "user-a",
      ],
      binding,
    );
    expect(binding.calls).toEqual([
      {
        operation: "note",
        input: { itemId: "item-1", body: "a remark", actorType: "person", actorId: "user-a" },
      },
    ]);
  });

  it("omits sessionId entirely when --session is not given, rather than sending it as undefined", async () => {
    const binding = recorder();
    await runCommand(["item", "note", "item-1", "--body", "x"], binding);
    const input = binding.calls[0]?.input as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(input, "sessionId")).toBe(false);
  });
});

describe("item orientation — itemId and optional --since, no session field at all", () => {
  it("builds itemId alone when --since is omitted", async () => {
    const binding = recorder();
    await runCommand(["item", "orientation", "item-1"], binding);
    expect(binding.calls).toEqual([{ operation: "orientation", input: { itemId: "item-1" } }]);
  });

  it("passes --since through as the raw string (the schema wants a decimal-integer string, not a number)", async () => {
    const binding = recorder();
    await runCommand(["item", "orientation", "item-1", "--since", "42"], binding);
    expect(binding.calls).toEqual([
      { operation: "orientation", input: { itemId: "item-1", since: "42" } },
    ]);
  });

  it("ignores a --session flag entirely — orientation's schema has no session field", async () => {
    const binding = recorder();
    await runCommand(["item", "orientation", "item-1", "--session", "s1"], binding);
    expect(binding.calls).toEqual([{ operation: "orientation", input: { itemId: "item-1" } }]);
  });
});

describe("crew name — sessionId only, no positional", () => {
  it("sends sessionId from --session", async () => {
    const binding = recorder();
    await runCommand(["crew", "name", "--session", "s1"], binding);
    expect(binding.calls).toEqual([{ operation: "get_crew_name", input: { sessionId: "s1" } }]);
  });
});

describe("the `claim` alias — PLAN.md's own daily-use example", () => {
  it("resolves to session claim, the same command as the long form", () => {
    const viaAlias = lookupCommand(["claim", "item-1"]);
    const viaLongForm = lookupCommand(["session", "claim", "item-1"]);
    if (!viaAlias.ok || !viaLongForm.ok) throw new Error("unreachable");
    expect(viaAlias.match.command).toBe(viaLongForm.match.command);
    expect(viaAlias.match.rest).toEqual(viaLongForm.match.rest);
  });

  it("is registered in ALIASES pointing at a command that exists", () => {
    expect(ALIASES.claim).toEqual(["session", "claim"]);
    const [noun, verb] = ALIASES.claim as readonly [string, string];
    expect(COMMANDS.some((c) => c.noun === noun && c.verb === verb)).toBe(true);
  });

  it("records which alias was typed without changing the operation or input", async () => {
    const binding = recorder();
    await runCommand(["claim", "item-1", "--session", "s1"], binding);
    await runCommand(["session", "claim", "item-1", "--session", "s1"], binding);
    expect(binding.calls).toEqual([
      { operation: "claim", input: { itemId: "item-1", sessionId: "s1" } },
      { operation: "claim", input: { itemId: "item-1", sessionId: "s1" } },
    ]);
  });
});
