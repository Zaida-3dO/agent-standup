// Numeric flags arrive as strings, and the operations that declare them
// `z.number()` refuse a string — so `standup item search --limit 5` failed
// with `invalid_input` naming a field the person had typed correctly.
//
// These tests drive the **argv path**, not `buildInput` directly: the defect
// was that a raw `"5"` survived all the way to the binding, and a test that
// called `buildInput` with a pre-made flag object would have proved the
// conversion while missing whether the command actually consumed the flag.
// Asserting `typeof === "number"` on what the binding receives is what
// distinguishes the fix from the bug — `expect(input.limit).toBe(5)` alone
// would pass on the string `"5"` under a loose comparison, so the type
// assertion is load-bearing.
import { describe, expect, it } from "vitest";
import { EXIT, runCommand } from "@/lib/cli";
import type { Binding } from "@/lib/cli";

/** A binding that records every call and always accepts. */
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

async function inputFor(argv: readonly string[]) {
  const binding = recorder();
  const outcome = await runCommand(argv, binding);
  return {
    binding,
    outcome,
    input: binding.calls[0]?.input as Record<string, unknown> | undefined,
  };
}

// The three commands whose `limit` is a plain `z.number()` and so could not
// be set from the command line at all before this change. `item loops` is
// deliberately absent: its schema uses `z.coerce.number()`, so it already
// worked, and is covered below as the contrast case.
describe.each([
  { argv: ["item", "search", "hook", "--limit", "5"], operation: "search" },
  { argv: ["item", "list", "--limit", "5"], operation: "list_items" },
  { argv: ["item", "orientation", "item-1", "--limit", "5"], operation: "orientation" },
])("$operation --limit", ({ argv, operation }) => {
  it("reaches the binding as a number, not the string the shell produced", async () => {
    const { input, binding } = await inputFor(argv);
    expect(binding.calls[0]?.operation).toBe(operation);
    expect(input?.limit).toBe(5);
    // The assertion that fails on the pre-fix code: `"5"` is not a number.
    expect(typeof input?.limit).toBe("number");
  });

  it("accepts the --limit=5 spelling too", async () => {
    const equals = [...argv.slice(0, -2), `${argv.at(-2)}=${argv.at(-1)}`];
    const { input } = await inputFor(equals);
    expect(input?.limit).toBe(5);
    expect(typeof input?.limit).toBe("number");
  });

  it("refuses a non-numeric value, naming the flag, without reaching the binding", async () => {
    const { outcome, binding } = await inputFor([...argv.slice(0, -1), "abc"]);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["limit"]);
  });

  it("refuses an empty --limit rather than reading it as zero", async () => {
    // `Number("")` is `0`, which several of these schemas accept as an
    // integer — so without the empty check this would silently mean
    // something rather than being refused.
    const { outcome, binding } = await inputFor([...argv.slice(0, -1), ""]);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });

  it("omits limit entirely when the flag is absent, leaving the schema default", async () => {
    const { input } = await inputFor(argv.slice(0, -2));
    expect(input).not.toHaveProperty("limit");
  });
});

describe("the flags each command already handled keep working alongside --limit", () => {
  it("item search still carries the query and --open-only", async () => {
    const { input } = await inputFor([
      "item",
      "search",
      "hook",
      "script",
      "--open-only",
      "--limit",
      "3",
    ]);
    expect(input).toMatchObject({ query: "hook script", openOnly: true, limit: 3 });
  });

  it("item list still carries --all and --full", async () => {
    const { input } = await inputFor(["item", "list", "--all", "--full", "--limit", "7"]);
    expect(input).toMatchObject({ includeTerminal: true, full: true, limit: 7 });
  });

  it("item list still passes non-numeric filters through as strings", async () => {
    const { input } = await inputFor(["item", "list", "--state", "executing", "--limit", "2"]);
    expect(input).toMatchObject({ state: "executing", limit: 2 });
    expect(typeof input?.state).toBe("string");
  });

  it("item orientation still carries its item id", async () => {
    const { input } = await inputFor(["item", "orientation", "item-9", "--limit", "4"]);
    expect(input).toMatchObject({ itemId: "item-9", limit: 4 });
  });
});

describe("session claim --pid", () => {
  it("reaches the binding as a number", async () => {
    const { input } = await inputFor(["session", "claim", "item-1", "--pid", "4242"]);
    expect(input?.pid).toBe(4242);
    expect(typeof input?.pid).toBe("number");
  });

  it("refuses a non-numeric --pid rather than passing the string through", async () => {
    const { outcome, binding } = await inputFor([
      "session",
      "claim",
      "item-1",
      "--pid",
      "not-a-number",
    ]);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["pid"]);
  });
});

describe("session register --hook-version", () => {
  it("still converts, now via the shared helper rather than a private copy", async () => {
    const { input } = await inputFor([
      "session",
      "register",
      "--session",
      "s-1",
      "--hook-version",
      "2",
    ]);
    expect(input?.hookVersion).toBe(2);
    expect(typeof input?.hookVersion).toBe("number");
  });
});

describe("the commands whose schema already coerces are left alone", () => {
  // `loop_list.limit` and `record_artifact.round` are `z.coerce.number()`,
  // so the string converts inside the schema every adapter shares. Coercing
  // in the CLI as well would be a second, adapter-local conversion — the
  // thing `commands-artifacts.ts`'s header warns will drift the day the
  // schema changes what it accepts. These assert the string is still what
  // the adapter sends, so a later "tidy-up" that coerces them here fails.
  it("item loops sends --limit as the string its schema coerces", async () => {
    const { input } = await inputFor(["item", "loops", "item-1", "--limit", "5"]);
    expect(input?.limit).toBe("5");
  });

  it("item artifact sends --round as the string its schema coerces", async () => {
    const { input } = await inputFor([
      "item",
      "artifact",
      "item-1",
      "--kind",
      "review",
      "--round",
      "2",
    ]);
    expect(input?.round).toBe("2");
  });
});
