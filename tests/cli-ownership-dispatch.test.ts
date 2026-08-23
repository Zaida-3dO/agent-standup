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
    [["session", "progress"], "progress_report"],
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

  // Behaviour change: `--pid` now goes through the shared `numericFlag`
  // (src/lib/cli/args.ts) rather than a claim-local `Number()` coercion, so
  // a non-numeric value is refused here naming the flag that was typed
  // instead of being passed through for the schema to refuse as a type
  // error. The binding is never reached, which is the observable difference.
  it("refuses a non-numeric --pid, naming the flag, without reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["session", "claim", "item-1", "--pid", "not-a-number"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["pid"]);
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

describe("session progress — the report's own switch (MILESTONES.md #136)", () => {
  it("sends sessionId and includeCompleted false when the switch is absent", async () => {
    const binding = recorder();
    await runCommand(["session", "progress", "--session", "s1"], binding);
    expect(binding.calls).toEqual([
      { operation: "progress_report", input: { sessionId: "s1", includeCompleted: false } },
    ]);
  });

  // The finding this test exists for: `--include-completed` is a bare switch,
  // and `passThroughFlags` refuses a valueless flag outright. Without
  // `booleanFlag` reading it first, the flag has **no spelling that reaches
  // the operation** — bare is refused by the adapter, and `=true` arrives as
  // the string the strict schema then rejects. Fails if that wiring is
  // dropped, which is exactly how it shipped unreachable.
  it("sends includeCompleted true for the bare switch", async () => {
    const binding = recorder();
    await runCommand(["session", "progress", "--session", "s1", "--include-completed"], binding);
    expect(binding.calls).toEqual([
      { operation: "progress_report", input: { sessionId: "s1", includeCompleted: true } },
    ]);
  });

  // A switch that took a value would be a second spelling for the same
  // thing, and the one the schema rejects. Refused by the adapter instead,
  // where the message can say so.
  it("refuses a value on the switch rather than passing a string through", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["session", "progress", "--session", "s1", "--include-completed", "true"],
      binding,
    );
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  // The switch must not also arrive under its raw flag name — that is what
  // declaring it consumed prevents, and `.strict()` would refuse the call if
  // it leaked through.
  it("does not pass the raw flag name through beside the mapped field", async () => {
    const binding = recorder();
    await runCommand(["session", "progress", "--session", "s1", "--include-completed"], binding);
    const input = binding.calls[0]?.input as Record<string, unknown>;
    expect(input["include-completed"]).toBeUndefined();
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
