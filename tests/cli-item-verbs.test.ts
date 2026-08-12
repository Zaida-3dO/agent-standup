// MILESTONES.md #81 — `standup item update|transition|complete`: the
// `buildInput` half of each new command entry, at the level
// `cli-dispatch.test.ts` already exercises `get`/`list`/`create` at. Needs
// #15, #21, #26, #27, #79 — all merged.
//
// This file proves what each command turns typed words and flags into
// *before* a binding is ever reached — the same split `cli-dispatch.test.ts`
// draws ("refuses ... before reaching the binding"). It does not re-prove
// dispatch, aliasing or the envelope/exit-code plumbing; those are #79's and
// stay covered there. `tests/cli-item-transition-dry-run.test.ts` covers
// `--dry-run` actually not mutating anything, which needs a binding and does
// not belong here.
import { describe, expect, it } from "vitest";
import { COMMANDS, HTTP_ROUTES, lookupCommand } from "@/lib/cli";

function commandFor(noun: string, verb: string) {
  const command = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!command) throw new Error(`no such command: ${noun} ${verb}`);
  return command;
}

describe("item update", () => {
  const update = commandFor("item", "update");

  it("refuses with no id, before any flag is read", () => {
    const built = update.buildInput([], { title: "renamed" });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["id"]);
  });

  it("puts the id from the words and the rest of the flags into one input object", () => {
    const built = update.buildInput(["item-1"], { title: "renamed", priority: "P1" });
    expect(built).toEqual({ ok: true, input: { id: "item-1", title: "renamed", priority: "P1" } });
  });

  it("drops the global flags, same as create", () => {
    const built = update.buildInput(["item-1"], { title: "renamed", json: true, as: "user-a" });
    expect(built).toEqual({ ok: true, input: { id: "item-1", title: "renamed" } });
  });

  it("still refuses a bare value-taking flag", () => {
    const built = update.buildInput(["item-1"], { title: true });
    expect(built.ok).toBe(false);
  });
});

describe("item transition", () => {
  const transition = commandFor("item", "transition");

  it("refuses with no id", () => {
    const built = transition.buildInput([], { to: "someday" });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["id"]);
  });

  it("refuses with no --to, naming the field", () => {
    const built = transition.buildInput(["item-1"], {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["to"]);
  });

  it("refuses a bare --to with no value, distinctly from --to being absent entirely", () => {
    const bareFlag = transition.buildInput(["item-1"], { to: true });
    expect(bareFlag.ok).toBe(false);
    if (bareFlag.ok) throw new Error("unreachable");
    expect(bareFlag.envelope.error.fields).toEqual(["to"]);
    // Distinguishes "you typed --to with nothing after it" (stringFlag's own
    // refusal) from "you never typed --to at all" (this command's fallback
    // below) — the two reach `ok: false` by different routes and a mutant
    // deleting the early `if (!to.ok) return to;` would collapse them.
    expect(bareFlag.envelope.error.message).toContain("needs a value");

    const missingFlag = transition.buildInput(["item-1"], {});
    if (missingFlag.ok) throw new Error("unreachable");
    expect(missingFlag.envelope.error.message).not.toContain("needs a value");
  });

  it("builds dryRun: false when --dry-run is absent", () => {
    const built = transition.buildInput(["item-1"], { to: "someday" });
    expect(built).toEqual({ ok: true, input: { id: "item-1", to: "someday", dryRun: false } });
  });

  it("builds dryRun: true for the bare --dry-run flag", () => {
    const built = transition.buildInput(["item-1"], { to: "someday", "dry-run": true });
    expect(built).toEqual({ ok: true, input: { id: "item-1", to: "someday", dryRun: true } });
  });

  it("refuses a --dry-run given a value — it is a boolean, not a string flag", () => {
    const built = transition.buildInput(["item-1"], { to: "someday", "dry-run": "true" });
    expect(built.ok).toBe(false);
  });

  it("parses --fields as JSON and attaches it, omitting the key entirely when absent", () => {
    const withFields = transition.buildInput(["item-1"], {
      to: "blocked",
      fields: '{"blocked_reason":"waiting on design"}',
    });
    expect(withFields).toEqual({
      ok: true,
      input: {
        id: "item-1",
        to: "blocked",
        dryRun: false,
        fields: { blocked_reason: "waiting on design" },
      },
    });

    const withoutFields = transition.buildInput(["item-1"], { to: "someday" });
    if (!withoutFields.ok) throw new Error("unreachable");
    expect("fields" in (withoutFields.input as Record<string, unknown>)).toBe(false);
  });

  it("refuses --fields that is not valid JSON, naming the field", () => {
    const built = transition.buildInput(["item-1"], { to: "blocked", fields: "{not json" });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["fields"]);
    expect(built.envelope.error.message).toContain("valid JSON");
  });

  it("refuses a bare --fields with no value, rather than silently treating it as absent", () => {
    // `jsonFlag`'s own early return on `stringFlag`'s refusal — without it,
    // a bare `--fields` (no value) reads as `raw.value === undefined` one
    // line down and is treated as "not given" instead of "given wrong".
    const built = transition.buildInput(["item-1"], { to: "someday", fields: true });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["fields"]);
  });
});

describe("item complete", () => {
  const complete = commandFor("item", "complete");

  const summaryJson = JSON.stringify({
    shipped: ["did the thing"],
    not_done: [],
    user_facing: false,
    watch_for: [],
  });

  it("refuses with no id", () => {
    const built = complete.buildInput([], { to: "merged", summary: summaryJson });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["id"]);
  });

  it("refuses with no --to, distinctly from a bare --to with no value", () => {
    const missingFlag = complete.buildInput(["item-1"], { summary: summaryJson });
    expect(missingFlag.ok).toBe(false);
    if (missingFlag.ok) throw new Error("unreachable");
    expect(missingFlag.envelope.error.fields).toEqual(["to"]);
    expect(missingFlag.envelope.error.message).not.toContain("needs a value");

    const bareFlag = complete.buildInput(["item-1"], { to: true, summary: summaryJson });
    if (bareFlag.ok) throw new Error("unreachable");
    expect(bareFlag.envelope.error.fields).toEqual(["to"]);
    expect(bareFlag.envelope.error.message).toContain("needs a value");
  });

  it("refuses with no --summary, naming the field", () => {
    const built = complete.buildInput(["item-1"], { to: "merged" });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["summary"]);
  });

  it("refuses --summary that is not valid JSON", () => {
    const built = complete.buildInput(["item-1"], { to: "merged", summary: "{not json" });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["summary"]);
    expect(built.envelope.error.message).toContain("valid JSON");
  });

  it("refuses a bare --fields with no value", () => {
    const built = complete.buildInput(["item-1"], {
      to: "merged",
      summary: summaryJson,
      fields: true,
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["fields"]);
  });

  it("refuses --fields that is not valid JSON", () => {
    const built = complete.buildInput(["item-1"], {
      to: "merged",
      summary: summaryJson,
      fields: "{not json",
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["fields"]);
  });

  it("builds the parsed summary object, with no dryRun field at all", () => {
    const built = complete.buildInput(["item-1"], { to: "merged", summary: summaryJson });
    expect(built).toEqual({
      ok: true,
      input: {
        id: "item-1",
        to: "merged",
        summary: JSON.parse(summaryJson),
      },
    });
    if (!built.ok) throw new Error("unreachable");
    expect("dryRun" in (built.input as Record<string, unknown>)).toBe(false);
    // Omitted entirely, not set to `undefined` — the same distinction
    // `create_item`'s own optional fields keep (row #79's `flagsToInput`).
    expect("fields" in (built.input as Record<string, unknown>)).toBe(false);
  });

  it("attaches --fields alongside the summary when given", () => {
    const built = complete.buildInput(["item-1"], {
      to: "merged",
      summary: summaryJson,
      fields: '{"commit_sha":"abc123"}',
    });
    if (!built.ok) throw new Error("unreachable");
    expect((built.input as Record<string, unknown>).fields).toEqual({ commit_sha: "abc123" });
  });
});

describe("dispatch resolves the new verbs to their operations (SCHEMA.md §20)", () => {
  it.each([
    ["update", "update_item"],
    ["transition", "transition_item"],
    ["complete", "complete_item"],
  ])("`item %s` resolves to %s", (verb, operation) => {
    const found = lookupCommand(["item", verb, "item-1"]);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe(operation);
  });
});

describe("every new operation has an HTTP route, so `direct` and `http` reach the same set", () => {
  // The generic version of this ("routes every operation the command table
  // calls") lives in `cli-http-binding.test.ts`; this is the same property
  // named explicitly for the three operations this row adds, so a reviewer
  // sees it here without cross-referencing that file.
  it.each(["update_item", "transition_item", "complete_item"])("%s is routed", (operation) => {
    expect(HTTP_ROUTES[operation]).toBeDefined();
  });
});
