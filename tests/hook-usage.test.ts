// MILESTONES.md #88 — reading reported usage off the payload
// (`src/lib/hook/usage.ts`), SCHEMA.md §11 ("the hook reports model and
// effort on every call").
//
// **The property this file exists to hold: reading usage never fails.**
// `parseHookPayload` refuses anything it cannot understand, because it
// answers a guard's question and an unreadable question denies. This module
// answers a meter's question, where the opposite is true — a token count
// this build cannot read must never refuse a tool call. The two contracts
// are why they are separate functions, and the tests below are what stops a
// later edit from folding them back together.
import { describe, expect, it } from "vitest";
import { readReportedPaths, readReportedUsage } from "@/lib/hook/usage";

describe("reading usage never fails", () => {
  it("returns an empty report for a payload with nothing in it", () => {
    expect(readReportedUsage({})).toEqual({});
  });

  it("returns an empty report rather than throwing for a non-object", () => {
    // Everything a broken tool version could hand over. Each must be a
    // measurement of nothing, never an exception on the critical path.
    for (const value of [undefined, null, 42, "text", [], true]) {
      expect(readReportedUsage(value)).toEqual({});
    }
  });

  it("ignores a field whose type is wrong instead of carrying it", () => {
    // A string token count is not a token count. Carrying it would push a
    // non-number into a field the record's normaliser would then zero —
    // same outcome, but the wrongness would be invisible one layer later.
    expect(readReportedUsage({ input_tokens: "120", model: 7 })).toEqual({});
  });
});

describe("the vendor spellings are read", () => {
  it("reads snake_case token counts at the top level", () => {
    expect(
      readReportedUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      }),
    ).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheWriteTokens: 3,
      cacheReadTokens: 4,
    });
  });

  it("reads camelCase as well", () => {
    expect(readReportedUsage({ inputTokens: 5, cacheWriteTokens: 6 })).toEqual({
      inputTokens: 5,
      cacheWriteTokens: 6,
    });
  });

  it("reads a nested usage object", () => {
    expect(readReportedUsage({ usage: { input_tokens: 9, output_tokens: 8 } })).toEqual({
      inputTokens: 9,
      outputTokens: 8,
    });
  });

  it("prefers the nested container over a stale top-level copy", () => {
    // A tool reporting both is far more likely to have a stale top-level
    // copy: the nested object is the shape the vendor APIs emit.
    expect(readReportedUsage({ input_tokens: 1, usage: { input_tokens: 99 } })).toEqual({
      inputTokens: 99,
    });
  });

  it("reads model and effort, which #11 needs to cut runs", () => {
    expect(readReportedUsage({ model: "vendor-model-1", reasoning_effort: "high" })).toEqual({
      model: "vendor-model-1",
      effort: "high",
    });
  });

  it("reads the two budget snapshots", () => {
    expect(readReportedUsage({ usage_5h: 12.5, usage_weekly: 44 })).toEqual({
      usage5h: 12.5,
      usageWeekly: 44,
    });
  });

  it("keeps a reported zero rather than treating it as absent", () => {
    // `usage_5h: 0` is a real reading — a fresh window — and the difference
    // between it and "not reported" is the whole reason the record has two
    // normalisers.
    expect(readReportedUsage({ usage_5h: 0 })).toEqual({ usage5h: 0 });
  });

  it("does not meter against an unrelated numeric field", () => {
    // The reason spellings are listed rather than scanned for: a scan for
    // "any numeric property whose name contains tokens" eventually picks up
    // something that is not a token count and meters against it.
    expect(readReportedUsage({ max_tokens: 4096, tokens_remaining: 10 })).toEqual({});
  });
});

describe("reading the paths a call touched", () => {
  it("reads a single file path as a one-element list", () => {
    // A spread of one is a real measurement, not an absence.
    expect(readReportedPaths({ tool_input: { file_path: "src/a.ts" } })).toEqual(["src/a.ts"]);
  });

  it("reads a list when the tool reported one", () => {
    expect(readReportedPaths({ tool_input: { paths: ["src/a.ts", "src/b.ts"] } })).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("prefers a list over a single path when both are present", () => {
    expect(
      readReportedPaths({ tool_input: { paths: ["src/a.ts"], file_path: "src/b.ts" } }),
    ).toEqual(["src/a.ts"]);
  });

  it("drops non-string entries from a reported list", () => {
    expect(readReportedPaths({ tool_input: { paths: ["src/a.ts", 7, null] } })).toEqual([
      "src/a.ts",
    ]);
  });

  it("reports nothing for a tool that touched no path", () => {
    expect(readReportedPaths({ tool_input: { command: "git status" } })).toBe(undefined);
    expect(readReportedPaths({})).toBe(undefined);
    expect(readReportedPaths(undefined)).toBe(undefined);
  });

  it("falls back to the top level when there is no tool input", () => {
    expect(readReportedPaths({ file_path: "src/a.ts" })).toEqual(["src/a.ts"]);
  });
});

describe("a field the harness wraps in an object is still read", () => {
  // Measured against a live Claude Code PostToolUse payload on 2026-09-14:
  // `effort` arrives as `{"level":"high"}`, NOT as `"high"`. Read with a
  // bare string test that object fails `typeof value === "string"` and is
  // discarded, which is why every spooled record carried no effort at all
  // while the harness was reporting one on every single call. The value was
  // there the whole time; the reader was looking at the wrong shape.
  it("reads effort from the {level} wrapper the harness actually sends", () => {
    // Fails the moment `labelled` is reduced back to `text`.
    expect(readReportedUsage({ effort: { level: "high" } })).toEqual({ effort: "high" });
  });

  it("still reads a bare string, so the wrapper is additive", () => {
    // The unwrapping must not cost the plain spelling: another agent tool
    // reporting `effort: "low"` has to keep working.
    expect(readReportedUsage({ effort: "low" })).toEqual({ effort: "low" });
  });

  it("reads a wrapped model too", () => {
    expect(readReportedUsage({ model: { level: "claude-opus-4-8" } })).toEqual({
      model: "claude-opus-4-8",
    });
  });

  it("ignores a wrapper whose inner value is not a string", () => {
    // A number under `level` is not a label. Carrying it would push a
    // non-string into a field the record's normaliser then drops anyway —
    // same outcome, but the wrongness becomes invisible one layer later.
    expect(readReportedUsage({ effort: { level: 7 } })).toEqual({});
  });

  it("does not unwrap an arbitrary key, only the named ones", () => {
    // Deliberately NOT "take the first string in the object". A wrong
    // label is worse than a missing one here: a missing effort is visibly
    // unreported, while a wrong one silently cuts a run boundary and
    // re-attributes that run's cost.
    //
    // Fails if WRAPPER_KEYS is replaced by a scan over Object.values.
    expect(readReportedUsage({ effort: { tier: "high" } })).toEqual({});
  });
});
