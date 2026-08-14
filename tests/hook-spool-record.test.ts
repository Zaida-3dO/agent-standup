// MILESTONES.md #88 — building the telemetry record
// (`src/lib/hook/spool-record.ts`), SCHEMA.md §10 (`tool_calls`).
//
// What these tests exist to protect, in order of how expensive getting it
// wrong would be:
//
//   1. **A malformed report can never poison arithmetic.** Token counts are
//      summed into costs downstream, and one `NaN` in a sum makes the whole
//      sum `NaN` — so a single bad report from one tool version would
//      destroy the cost figure for every call it aggregates with. The
//      normalisation tests below are the guard on that, and they are the
//      reason `countOf` exists as a named function rather than a `?? 0`.
//   2. **"Not reported" and "zero" are different for a budget reading and
//      the same for a token count.** They are deliberately handled by two
//      functions, and several tests here do nothing but hold them apart.
//   3. **A cap always leaves a trace.** A truncation nobody can see turns a
//      measurement into a quiet lie.
import { describe, expect, it } from "vitest";
import * as SHARED_CAPS from "@/lib/telemetry/contract";
import {
  MAX_COMMAND_CHARS,
  MAX_PATHS,
  MAX_PATH_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_TOOL_CHARS,
  TRUNCATION_MARKER,
  buildRecord,
  capPaths,
  capText,
  countOf,
  readingOf,
} from "@/lib/hook/spool-record";
import type { HookEvent } from "@/lib/hook/payload";

const NOW = 1_700_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

function event(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    eventType: "PostToolUse",
    sessionId: "session-a",
    tool: "Bash",
    command: "git status",
    ...overrides,
  };
}

describe("buildRecord shapes one tool call for the ingest", () => {
  it("carries every field the table needs", () => {
    const record = buildRecord({
      event: event(),
      now: NOW,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheWriteTokens: 30,
        cacheReadTokens: 40,
        model: "vendor-model-1",
        effort: "high",
        usage5h: 12.5,
        usageWeekly: 44,
      },
      paths: ["src/a.ts"],
    });

    expect(record).toEqual({
      sessionId: "session-a",
      ts: NOW_ISO,
      tool: "Bash",
      command: "git status",
      paths: ["src/a.ts"],
      inputTokens: 10,
      outputTokens: 20,
      cacheWriteTokens: 30,
      cacheReadTokens: 40,
      model: "vendor-model-1",
      effort: "high",
      usage5h: 12.5,
      usageWeekly: 44,
    });
  });

  it("keeps the four token counts separate rather than totalling them", () => {
    // §10: "Prices ~5× input — never fold into a single total." A record
    // that summed these would pass every other test in this file.
    const record = buildRecord({
      event: event(),
      now: NOW,
      usage: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 4, cacheReadTokens: 8 },
    });
    expect(record?.inputTokens).toBe(1);
    expect(record?.outputTokens).toBe(2);
    expect(record?.cacheWriteTokens).toBe(4);
    expect(record?.cacheReadTokens).toBe(8);
  });

  it("spools nothing for an event that names no tool", () => {
    // A `Stop` has no tool, and §10's table is one row per tool call — a
    // row here would have to invent the column.
    expect(buildRecord({ event: event({ eventType: "Stop", tool: undefined }), now: NOW })).toBe(
      undefined,
    );
  });

  it("spools a tool call that carries no command", () => {
    // A Read has no command, and it is still a tool call worth measuring:
    // the read-to-write ratio (#54) is computed from exactly these.
    const record = buildRecord({
      event: event({ tool: "Read", command: undefined }),
      now: NOW,
    });
    expect(record?.tool).toBe("Read");
    expect(record?.command).toBe(undefined);
  });

  it("reports zero counts when the tool reported no usage at all", () => {
    // The record still exists: "this call happened and nothing was reported
    // about it" is true and useful, and losing the tool name to preserve a
    // missing token count would be the wrong trade.
    const record = buildRecord({ event: event(), now: NOW });
    expect(record?.inputTokens).toBe(0);
    expect(record?.outputTokens).toBe(0);
    expect(record?.model).toBe(undefined);
    expect(record?.usage5h).toBe(undefined);
  });

  it("stamps the injected clock rather than reading one", () => {
    const record = buildRecord({ event: event(), now: 0 });
    expect(record?.ts).toBe(new Date(0).toISOString());
  });
});

describe("a malformed report cannot poison the arithmetic", () => {
  it("normalises NaN, Infinity, negatives and non-numbers to zero", () => {
    // The case this exists for: one NaN summed into a cost makes every
    // aggregate containing it NaN.
    expect(countOf(Number.NaN)).toBe(0);
    expect(countOf(Number.POSITIVE_INFINITY)).toBe(0);
    expect(countOf(-5)).toBe(0);
    expect(countOf("120")).toBe(0);
    expect(countOf(null)).toBe(0);
    expect(countOf(undefined)).toBe(0);
  });

  it("floors a fractional count rather than storing it", () => {
    // `tool_calls.input_tokens` is an `int`; a fraction would be rounded by
    // the database anyway, and rounding here means what is on the spool is
    // what lands.
    expect(countOf(12.9)).toBe(12);
  });

  it("keeps a legitimate zero and a legitimate large count", () => {
    expect(countOf(0)).toBe(0);
    expect(countOf(1_000_000)).toBe(1_000_000);
  });

  it("carries a NaN token count through buildRecord as zero", () => {
    const record = buildRecord({
      event: event(),
      now: NOW,
      usage: { inputTokens: Number.NaN, outputTokens: 7 },
    });
    expect(record?.inputTokens).toBe(0);
    expect(record?.outputTokens).toBe(7);
  });
});

describe("a budget reading distinguishes absent from zero", () => {
  it("keeps zero as a real reading", () => {
    // A budget of zero means "nothing used" and the planner acts on it.
    // Collapsing it to `undefined` would make a fresh window unreportable.
    expect(readingOf(0)).toBe(0);
  });

  it("keeps a fraction, because a percentage of a window is not an integer", () => {
    expect(readingOf(44.5)).toBe(44.5);
  });

  it("reports undefined for anything unusable", () => {
    expect(readingOf(Number.NaN)).toBe(undefined);
    expect(readingOf(-1)).toBe(undefined);
    expect(readingOf("44")).toBe(undefined);
    expect(readingOf(undefined)).toBe(undefined);
  });

  it("a reported zero budget survives into the record as zero, not absent", () => {
    // The pair that proves the two normalisers are genuinely different: the
    // same literal zero is a count of zero and a reading of zero, and if
    // `readingOf` were `countOf` this would still pass — so the absent case
    // below is asserted alongside it.
    const reported = buildRecord({ event: event(), now: NOW, usage: { usage5h: 0 } });
    expect(reported?.usage5h).toBe(0);

    const absent = buildRecord({ event: event(), now: NOW, usage: {} });
    expect(absent?.usage5h).toBe(undefined);
  });
});

describe("the big fields are capped, and the cap leaves a trace", () => {
  it("keeps a command that fits, untouched", () => {
    const command = "x".repeat(MAX_COMMAND_CHARS);
    expect(capText(command, MAX_COMMAND_CHARS)).toBe(command);
  });

  it("marks a command one character over the cap, counting the marker inside it", () => {
    // The boundary in both directions: an off-by-one here either truncates
    // everything or nothing, and neither shows up in a mid-range test.
    //
    // **The marker is inside the cap, not added on top of it**, so the cap
    // is a real bound on what is stored rather than an approximate one.
    // That matters because the same limits are applied again at the ingest:
    // a client that appended the marker past the bound would produce a
    // value the server then re-truncates, leaving the marker stranded in
    // the *middle* of the stored text — a wrong measurement rather than a
    // partial one.
    const capped = capText("x".repeat(MAX_COMMAND_CHARS + 1), MAX_COMMAND_CHARS);
    expect(capped.length).toBe(MAX_COMMAND_CHARS);
    expect(capped.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("caps a heredoc-sized command inside buildRecord", () => {
    // The real case: a Bash call whose command text is a whole source file.
    const record = buildRecord({
      event: event({ command: "y".repeat(500_000) }),
      now: NOW,
    });
    expect(record?.command?.length).toBe(MAX_COMMAND_CHARS);
    expect(record?.command?.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("re-capping an already-capped value is a no-op, so the ingest cannot strand the marker", () => {
    // The property that makes sharing one caps module worth doing, stated
    // as a test: the client caps, the server caps the same value again, and
    // the second pass must change nothing. If the two used different
    // numbers — or counted the marker differently — this is where it would
    // show, and nothing else in either codebase would notice.
    const once = capText("z".repeat(50_000), MAX_COMMAND_CHARS);
    expect(capText(once, MAX_COMMAND_CHARS)).toBe(once);
    expect(once.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("caps how many paths are kept and how long each may be", () => {
    const many = Array.from({ length: MAX_PATHS + 10 }, (_, index) => `src/file-${index}.ts`);
    expect(capPaths(many)?.length).toBe(MAX_PATHS);

    const long = capPaths(["z".repeat(MAX_PATH_CHARS + 1)]);
    expect(long?.[0]?.length).toBe(MAX_PATH_CHARS);
    expect(long?.[0]?.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("uses the shared limits rather than a second set of its own", () => {
    // The client and the ingest bound these fields by the *same* numbers,
    // from one module. Two independent sets is the shape where the client
    // trims to one bound and the server re-trims to a tighter one — and
    // each side looks correct in isolation while the stored value is wrong.
    //
    // Asserted against the shared module's own exports rather than against
    // literals, so this fails if the hook ever stops importing them; a
    // literal here would happily agree with a divergence.
    expect(MAX_COMMAND_CHARS).toBe(SHARED_CAPS.MAX_COMMAND_CHARS);
    expect(MAX_PATHS).toBe(SHARED_CAPS.MAX_PATHS);
    expect(MAX_PATH_CHARS).toBe(SHARED_CAPS.MAX_PATH_CHARS);
    expect(TRUNCATION_MARKER).toBe(SHARED_CAPS.TRUNCATION_MARKER);
  });

  it("caps the tool name and the session id, which are index keys server-side", () => {
    const record = buildRecord({
      event: { ...event(), sessionId: "s".repeat(MAX_SESSION_ID_CHARS + 50) },
      now: NOW,
    });
    expect(record?.sessionId.length).toBe(MAX_SESSION_ID_CHARS);

    const longTool = buildRecord({
      event: event({ tool: "T".repeat(MAX_TOOL_CHARS + 50) }),
      now: NOW,
    });
    expect(longTool?.tool.length).toBe(MAX_TOOL_CHARS);
  });

  it("keeps the first paths rather than the last", () => {
    // Order matters for a spread measurement: keeping an arbitrary end
    // would be fine, but keeping a *different* end than documented would
    // silently change what #54 measures.
    const many = Array.from({ length: MAX_PATHS + 5 }, (_, index) => `f${index}`);
    expect(capPaths(many)?.[0]).toBe("f0");
    expect(capPaths(many)?.[MAX_PATHS - 1]).toBe(`f${MAX_PATHS - 1}`);
  });

  it("drops non-string path entries instead of stringifying them", () => {
    // `[object Object]` is not a path, and one on the spool corrupts a
    // spread measurement with a value that can never match anything.
    expect(capPaths(["src/a.ts", { a: 1 }, 7, null, "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports undefined for a path list that is empty or not a list", () => {
    expect(capPaths([])).toBe(undefined);
    expect(capPaths("src/a.ts")).toBe(undefined);
    expect(capPaths(undefined)).toBe(undefined);
    expect(capPaths([""])).toBe(undefined);
  });

  it("trims whitespace-only strings out rather than keeping them", () => {
    // A tool that reports `"   "` for a path is reporting nothing; keeping
    // it would inflate a spread count with an entry that names no file.
    expect(capPaths(["  ", "src/a.ts"])).toEqual(["src/a.ts"]);
    expect(buildRecord({ event: event({ tool: "   " }), now: NOW })).toBe(undefined);
  });
});
