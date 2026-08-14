// MILESTONES.md #99's command-line surface — `standup sweep` (and its long
// form `standup session sweep`) and `standup session takeover`: dispatch and
// input building, driven through `runCommand` exactly like
// tests/cli-ownership-dispatch.test.ts drives row #82's own commands.
//
// No database: the binding is a recorder that never reaches a service, so
// what is under test is purely "does this row's command table turn argv into
// the right operation name and the right input object". The rules those inputs
// are then judged by are tests/takeover.test.ts's subject.
import { describe, expect, it } from "vitest";
import { ALIASES, COMMANDS, EXIT, lookupCommand, runCommand } from "@/lib/cli";
import type { Binding } from "@/lib/cli";

/** Records every call and always accepts — same shape as tests/cli-ownership-dispatch.test.ts's. */
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

describe("dispatch", () => {
  it.each([
    [["session", "sweep"], "sweep"],
    [["session", "takeover", "item-1"], "takeover"],
  ])("%j resolves to operation %s", (words, operation) => {
    const found = lookupCommand(words);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe(operation);
  });

  it("`standup sweep` is aliased to the same command as `standup session sweep`", () => {
    // The milestone asks for a `standup sweep` verb specifically, because the
    // caller is a scheduler configuration read long after it was written.
    expect(ALIASES.sweep).toEqual(["session", "sweep"]);
    const viaAlias = lookupCommand(["session", "sweep"]);
    expect(viaAlias.ok).toBe(true);
  });

  it("`takeover` is deliberately NOT a bare alias", () => {
    // A one-word form is exactly what makes a dangerous command easy to fire
    // absent-mindedly. If someone adds one, this goes red and they have to
    // argue for it in review rather than slipping it in.
    expect(ALIASES.takeover).toBeUndefined();
  });

  it("adds no duplicate noun/verb pair", () => {
    const pairs = COMMANDS.map((c) => `${c.noun} ${c.verb}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

describe("standup sweep — sends an empty input", () => {
  it("calls sweep with no fields at all", async () => {
    const binding = recorder();
    await runCommand(["sweep"], binding);
    expect(binding.calls).toEqual([{ operation: "sweep", input: {} }]);
  });

  it("does NOT swallow a stray flag — it is forwarded so the schema can refuse it", async () => {
    // `sweep`'s schema is `.strict()`, so a forwarded unknown field becomes
    // an `invalid_input` naming the field. Dropping it here would leave the
    // caller believing `--now` did something.
    const binding = recorder();
    await runCommand(["sweep", "--now", "2020-01-01"], binding);
    expect(binding.calls).toEqual([{ operation: "sweep", input: { now: "2020-01-01" } }]);
  });

  it("still drops the GLOBAL flags, which are the dispatcher's own", async () => {
    const binding = recorder();
    await runCommand(["sweep", "--json", "--direct"], binding);
    expect(binding.calls).toEqual([{ operation: "sweep", input: {} }]);
  });
});

describe("standup session takeover — builds the full operation input", () => {
  it("sends itemId from the positional and every other field from its exact camelCase flag", async () => {
    const binding = recorder();
    await runCommand(
      [
        "session",
        "takeover",
        "item-1",
        "--fromSessionId",
        "session-old",
        "--bySessionId",
        "session-new",
        "--holderType",
        "agent",
        "--holderId",
        "holder-b",
      ],
      binding,
    );
    expect(binding.calls).toEqual([
      {
        operation: "takeover",
        input: {
          itemId: "item-1",
          fromSessionId: "session-old",
          bySessionId: "session-new",
          holderType: "agent",
          holderId: "holder-b",
        },
      },
    ]);
  });

  it("a bare --force becomes the boolean true, not the string 'true'", async () => {
    // The one place this row needs a coercion: the parser reports a valueless
    // flag as `true`, and `passThroughFlags` would otherwise refuse it with
    // "--force needs a value" — which for a boolean is backwards.
    const binding = recorder();
    await runCommand(
      [
        "session",
        "takeover",
        "item-1",
        "--fromSessionId",
        "session-old",
        "--bySessionId",
        "session-new",
        "--holderType",
        "agent",
        "--holderId",
        "holder-b",
        "--force",
        "--reason",
        "told to",
      ],
      binding,
    );
    const input = binding.calls[0]!.input as Record<string, unknown>;
    expect(input.force).toBe(true);
    expect(input.reason).toBe("told to");
  });

  it("omits `force` entirely when the flag was never given", async () => {
    // A call that never mentioned forcing should not be recorded as having
    // explicitly declined to force — the schema declares it optional.
    const binding = recorder();
    await runCommand(
      [
        "session",
        "takeover",
        "item-1",
        "--fromSessionId",
        "session-old",
        "--bySessionId",
        "session-new",
        "--holderType",
        "agent",
        "--holderId",
        "holder-b",
      ],
      binding,
    );
    const input = binding.calls[0]!.input as Record<string, unknown>;
    expect("force" in input).toBe(false);
  });

  it("REFUSES `--force yes` rather than forwarding a string to a boolean field", async () => {
    const binding = recorder();
    const result = await runCommand(
      [
        "session",
        "takeover",
        "item-1",
        "--fromSessionId",
        "session-old",
        "--bySessionId",
        "session-new",
        "--holderType",
        "agent",
        "--holderId",
        "holder-b",
        "--force",
        "yes",
      ],
      binding,
    );
    // `MALFORMED` (2), not a generic failure: the command itself was written
    // wrongly, which is what that exit code means.
    expect(result.exitCode).toBe(EXIT.MALFORMED);
    // Refused before reaching the binding — nothing was called.
    expect(binding.calls).toEqual([]);
  });

  it("REFUSES a takeover with no item id, naming itemId", async () => {
    const binding = recorder();
    const result = await runCommand(["session", "takeover"], binding);
    expect(result.exitCode).toBe(EXIT.MALFORMED);
    expect(result.envelope).toMatchObject({ error: { fields: ["itemId"] } });
    expect(binding.calls).toEqual([]);
  });
});
