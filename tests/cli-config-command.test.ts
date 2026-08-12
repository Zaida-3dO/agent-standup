// MILESTONES.md #83 — `standup config`: list, get, set, clear, describe,
// rendering label/help/category from the registry via the existing
// `get_settings`/`get_setting`/`put_setting`/`delete_setting` operations
// (#78); `sensitive`/`irreversible` keys require `--confirm`.
//
// The confirmation gate is the highest-value thing here (task brief): every
// gate test below asserts BOTH the refusal (exit code, fields, message) AND
// that the binding was never called — a gate that "refuses" after already
// calling the binding would have refused nothing that mattered.
import { describe, expect, it } from "vitest";
import { helpText, nouns, runCommand, verbsFor } from "@/lib/cli";
import type { Binding } from "@/lib/cli";
import { getDefinition } from "@/lib/settings";

/** A binding that records every call and always accepts. */
function recorder(): Binding & { calls: { operation: string; input: unknown }[] } {
  const calls: { operation: string; input: unknown }[] = [];
  return {
    name: "direct",
    calls,
    async invoke(operation, input) {
      calls.push({ operation, input });
      return { ok: true, data: { operation, input } };
    },
  };
}

describe("standup config — wired into the shared command table", () => {
  it("registers `config` as a noun with all five verbs, discoverable via help", () => {
    expect(nouns()).toContain("config");
    expect(verbsFor("config")).toEqual(["clear", "describe", "get", "list", "set"]);
    expect(helpText().commands.some((line) => line.startsWith("config list —"))).toBe(true);
  });
});

describe("standup config — dispatch", () => {
  it("`config list` calls get_settings with no input", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "list"], binding);
    expect(outcome.exitCode).toBe(0);
    expect(binding.calls).toEqual([{ operation: "get_settings", input: {} }]);
  });

  it("`config get <key>` calls get_setting with the key", async () => {
    const binding = recorder();
    await runCommand(["config", "get", "items.max_depth"], binding);
    expect(binding.calls).toEqual([
      { operation: "get_setting", input: { key: "items.max_depth" } },
    ]);
  });

  it("refuses `config get` with no key, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "get"], binding);
    expect(outcome.exitCode).toBe(2); // EXIT.MALFORMED
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["key"]);
    expect(outcome.envelope.error.message).toBe("`standup config get` needs a setting key.");
  });

  it("`config describe <key>` calls the same operation as `get`, with the same input", async () => {
    const binding = recorder();
    await runCommand(["config", "describe", "items.max_depth"], binding);
    expect(binding.calls).toEqual([
      { operation: "get_setting", input: { key: "items.max_depth" } },
    ]);
  });

  it("refuses `config describe` with no key, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "describe"], binding);
    expect(outcome.exitCode).toBe(2);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["key"]);
    expect(outcome.envelope.error.message).toBe("`standup config describe` needs a setting key.");
  });

  it("`config set <key> <value>` on a non-sensitive key calls put_setting with the parsed value", async () => {
    const binding = recorder();
    await runCommand(["config", "set", "items.max_depth", "8"], binding);
    expect(binding.calls).toEqual([
      { operation: "put_setting", input: { key: "items.max_depth", value: 8 } },
    ]);
  });

  it("refuses `config set` with no key, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "set"], binding);
    expect(outcome.exitCode).toBe(2);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["key"]);
    expect(outcome.envelope.error.message).toBe(
      "`standup config set` needs a setting key and a value.",
    );
  });

  it("refuses `config set <key>` with no value, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "set", "items.max_depth"], binding);
    expect(outcome.exitCode).toBe(2);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["value"]);
    expect(outcome.envelope.error.message).toBe(
      "`standup config set items.max_depth` needs a value.",
    );
  });

  it("`config clear <key>` on a non-sensitive key calls delete_setting with the key", async () => {
    const binding = recorder();
    await runCommand(["config", "clear", "items.max_depth"], binding);
    expect(binding.calls).toEqual([
      { operation: "delete_setting", input: { key: "items.max_depth" } },
    ]);
  });

  it("refuses `config clear` with no key, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "clear"], binding);
    expect(outcome.exitCode).toBe(2);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["key"]);
    expect(outcome.envelope.error.message).toBe("`standup config clear` needs a setting key.");
  });
});

describe("standup config set — value parsing (JSON first, raw string fallback)", () => {
  it.each([
    ["8", 8],
    ["true", true],
    ["false", false],
    ["null", null],
    ["[1,2]", [1, 2]],
    ['"quoted"', "quoted"],
    ["/docs/notify.md", "/docs/notify.md"], // not valid JSON — falls back to the raw string
    ["pre-approved", "pre-approved"], // not valid JSON either
  ])("parses %s as %j", async (raw, expected) => {
    const binding = recorder();
    await runCommand(["config", "set", "items.max_depth", raw], binding);
    expect(binding.calls[0]?.input).toEqual({ key: "items.max_depth", value: expected });
  });
});

describe("standup config — the confirmation gate (MILESTONES.md #83, SCHEMA.md §17.8)", () => {
  it("registry keys used below are actually sensitive/irreversible as this suite assumes", () => {
    // A guard against the fixture rotting silently: if the registry ever
    // stopped declaring these two as dangerous, every refusal test below
    // would still pass for the wrong reason (no key would be gated at all).
    expect(getDefinition("items.default_merge_authority").sensitive).toBe(true);
    expect(getDefinition("items.default_merge_authority").irreversible).toBe(false);
    expect(getDefinition("retention.tool_calls_days").sensitive).toBe(true);
    expect(getDefinition("retention.tool_calls_days").irreversible).toBe(true);
    expect(getDefinition("items.max_depth").sensitive).toBe(false);
    expect(getDefinition("items.max_depth").irreversible).toBe(false);
  });

  it("refuses `config set` on a sensitive key without --confirm, never reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["config", "set", "items.default_merge_authority", "pre-approved"],
      binding,
    );
    expect(binding.calls).toEqual([]);
    expect(outcome.exitCode).toBe(2); // EXIT.MALFORMED
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["confirm"]);
    expect(outcome.envelope.error.message).toBe(
      "items.default_merge_authority is sensitive — it relaxes something this build enforces. " +
        "Re-run with --confirm to set it.",
    );
  });

  it("accepts `config set` on a sensitive key WITH --confirm, reaching the binding with the value", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["config", "set", "items.default_merge_authority", "pre-approved", "--confirm"],
      binding,
    );
    expect(outcome.exitCode).toBe(0);
    expect(binding.calls).toEqual([
      {
        operation: "put_setting",
        input: { key: "items.default_merge_authority", value: "pre-approved" },
      },
    ]);
  });

  it("refuses `config set` on an irreversible key without --confirm, never reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "set", "retention.tool_calls_days", "14"], binding);
    expect(binding.calls).toEqual([]);
    expect(outcome.exitCode).toBe(2);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["confirm"]);
    expect(outcome.envelope.error.message).toBe(
      "retention.tool_calls_days is irreversible — it can destroy data that cannot be recreated. " +
        "Re-run with --confirm to set it.",
    );
  });

  it("accepts `config set` on an irreversible key WITH --confirm", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["config", "set", "retention.tool_calls_days", "14", "--confirm"],
      binding,
    );
    expect(outcome.exitCode).toBe(0);
    expect(binding.calls).toEqual([
      { operation: "put_setting", input: { key: "retention.tool_calls_days", value: 14 } },
    ]);
  });

  it("refuses `config clear` on a sensitive key without --confirm, never reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "clear", "items.default_merge_authority"], binding);
    expect(binding.calls).toEqual([]);
    expect(outcome.exitCode).toBe(2);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["confirm"]);
    expect(outcome.envelope.error.message).toBe(
      "items.default_merge_authority is sensitive — it relaxes something this build enforces. " +
        "Re-run with --confirm to clear it.",
    );
  });

  it("accepts `config clear` on a sensitive key WITH --confirm", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["config", "clear", "items.default_merge_authority", "--confirm"],
      binding,
    );
    expect(outcome.exitCode).toBe(0);
    expect(binding.calls).toEqual([
      { operation: "delete_setting", input: { key: "items.default_merge_authority" } },
    ]);
  });

  it("does not gate a key that is neither sensitive nor irreversible", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "set", "items.max_depth", "10"], binding);
    expect(outcome.exitCode).toBe(0);
    expect(binding.calls).toEqual([
      { operation: "put_setting", input: { key: "items.max_depth", value: 10 } },
    ]);
  });

  it("does not invent a gate for a key this build does not declare — the service refuses it centrally", async () => {
    // The CLI cannot know whether an unrecognised name would have been
    // sensitive, so it does not guess either way; `requireSettingKey` inside
    // `put_setting` (settings-shared.ts) is what actually refuses this, with
    // `not_found` — this test only proves the CLI's own gate stays out of
    // the way and lets the call through to be refused there.
    const binding = recorder();
    const outcome = await runCommand(["config", "set", "not.a.real.key", "1"], binding);
    expect(outcome.exitCode).toBe(0); // the fake binding always accepts
    expect(binding.calls).toEqual([
      { operation: "put_setting", input: { key: "not.a.real.key", value: 1 } },
    ]);
  });

  it("refuses --confirm given a value, the same way every other boolean flag does", async () => {
    const binding = recorder();
    const outcome = await runCommand(
      ["config", "set", "items.default_merge_authority", "pre-approved", "--confirm=yes"],
      binding,
    );
    expect(binding.calls).toEqual([]);
    expect(outcome.exitCode).toBe(2);
    if (outcome.envelope.ok) throw new Error("unreachable");
    // The gate hands `booleanFlag`'s own refusal straight back rather than
    // building its own — a different message ("--confirm does not take a
    // value.") from the gate's own ("… is sensitive … --confirm to set
    // it.") proves that path, not the "no --confirm given at all" path, ran.
    expect(outcome.envelope.error.message).toBe("--confirm does not take a value.");
    expect(outcome.envelope.error.fields).toEqual(["confirm"]);
  });

  it("names irreversibility specifically, not just 'sensitive', in the refusal message", async () => {
    const binding = recorder();
    const outcome = await runCommand(["config", "set", "retention.tool_calls_days", "30"], binding);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.message).toContain("irreversible");
  });
});
