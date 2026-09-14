// The filesystem half of transcript usage — `src/lib/cli/transcript-file.ts`,
// MILESTONES.md #88, SCHEMA.md §10.
//
// `tests/hook-transcript-usage.test.ts` covers the pure reading. What this
// file adds is the part no pure test can reach: that the baseline actually
// PERSISTS between calls, and that a failure to read anything is a missing
// measurement rather than a thrown exception in a hook.
//
// The baseline is the load-bearing piece. The hook is a fresh process per
// tool call and the transcript reports cumulative totals, so without a
// persisted baseline every call would re-report the whole session and
// multiply its tokens by the number of tool calls in it. These cases are
// what stop that regression coming back.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselinePath, readTranscriptDelta } from "@/lib/cli/transcript-file";

let dir: string;
let spoolFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "standup-transcript-"));
  spoolFile = path.join(dir, "spool", "telemetry.jsonl");
  mkdirSync(path.dirname(spoolFile), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a transcript with one assistant message carrying `usage`. */
function writeTranscript(name: string, usages: Record<string, unknown>[]): string {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    usages
      .map((usage) => JSON.stringify({ type: "assistant", message: { model: "m-1", usage } }))
      .join("\n"),
    "utf-8",
  );
  return file;
}

describe("reading a transcript from disk never throws", () => {
  it("returns nothing when no transcript path was given", () => {
    expect(readTranscriptDelta(undefined, spoolFile)).toBeUndefined();
    expect(readTranscriptDelta("   ", spoolFile)).toBeUndefined();
  });

  it("returns nothing for a transcript that is not there", () => {
    // A hook must never deny a tool call because a telemetry file was
    // missing. Fails if the readFileSync catch is removed.
    expect(readTranscriptDelta(path.join(dir, "absent.jsonl"), spoolFile)).toBeUndefined();
  });
});

describe("the baseline makes the reading a delta across processes", () => {
  it("reports the full reading the first time it sees a transcript", () => {
    const file = writeTranscript("a.jsonl", [{ input_tokens: 100, output_tokens: 10 }]);
    const first = readTranscriptDelta(file, spoolFile);
    expect(first?.inputTokens).toBe(100);
    expect(first?.outputTokens).toBe(10);
  });

  it("reports NO NEW TOKENS on an unchanged transcript, rather than re-reporting them", () => {
    // THE regression this design exists to prevent. Many tool calls happen
    // inside one assistant turn; each re-reads the same file. Without the
    // baseline every one of them would re-report the same 100 tokens, and a
    // session's bill would be multiplied by its tool-call count.
    //
    // Note what a settled transcript still returns: zero counts WITH the
    // model. That is deliberate and is not a re-report — the tokens are
    // attributed exactly once, while the model is what lets the run those
    // calls belong to be priced at all, and it has to survive every call in
    // the turn rather than only the one that happened to grow the file.
    //
    // Fails if the baseline write is removed, or if `usageDelta` is
    // bypassed and the cumulative reading returned directly: the second and
    // third reads would report 100 again.
    const file = writeTranscript("b.jsonl", [{ input_tokens: 100 }]);
    expect(readTranscriptDelta(file, spoolFile)?.inputTokens).toBe(100);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const again = readTranscriptDelta(file, spoolFile);
      expect(again?.inputTokens ?? 0).toBe(0);
      expect(again?.model).toBe("m-1");
    }
  });

  it("reports only what was ADDED when the transcript grows", () => {
    const file = writeTranscript("c.jsonl", [{ input_tokens: 100 }]);
    expect(readTranscriptDelta(file, spoolFile)?.inputTokens).toBe(100);

    writeTranscript("c.jsonl", [{ input_tokens: 100 }, { input_tokens: 45 }]);
    // 145 cumulative, 100 already attributed — so 45, not 145.
    expect(readTranscriptDelta(file, spoolFile)?.inputTokens).toBe(45);
  });

  it("keeps two concurrent sessions' baselines apart", () => {
    // One machine runs several sessions at once. A single shared baseline
    // would let one session's reading blank out the other's, which reads as
    // "that session used nothing".
    //
    // Fails if the baseline stops being keyed by transcript path.
    const one = writeTranscript("one.jsonl", [{ input_tokens: 10 }]);
    const two = writeTranscript("two.jsonl", [{ input_tokens: 20 }]);

    expect(readTranscriptDelta(one, spoolFile)?.inputTokens).toBe(10);
    expect(readTranscriptDelta(two, spoolFile)?.inputTokens).toBe(20);
    // Neither consumed the other's baseline: both are now settled, so a
    // re-read of either reports no NEW tokens. A shared baseline would have
    // made the second read of `one` report 10 again (it would have been
    // compared against `two`'s reading), which is the cross-contamination
    // this keying exists to prevent.
    expect(readTranscriptDelta(one, spoolFile)?.inputTokens ?? 0).toBe(0);
    expect(readTranscriptDelta(two, spoolFile)?.inputTokens ?? 0).toBe(0);
  });

  it("re-baselines instead of crediting when a transcript shrinks", () => {
    // A rotated or compacted transcript makes the cumulative total go
    // backwards. A negative delta would be a credit against real recorded
    // spend, so it clamps to zero.
    const file = writeTranscript("d.jsonl", [{ input_tokens: 500 }]);
    expect(readTranscriptDelta(file, spoolFile)?.inputTokens).toBe(500);

    writeTranscript("d.jsonl", [{ input_tokens: 5 }]);
    const after = readTranscriptDelta(file, spoolFile);
    // Zero tokens, never -495. The model still comes through.
    expect(after?.inputTokens ?? 0).toBe(0);
  });

  it("survives a corrupt baseline file by starting over", () => {
    // Fails if readBaselines lets a JSON error escape — which would be a
    // thrown exception on the critical path of every tool call.
    writeFileSync(baselinePath(spoolFile), "{not json", "utf-8");
    const file = writeTranscript("e.jsonl", [{ input_tokens: 7 }]);
    expect(readTranscriptDelta(file, spoolFile)?.inputTokens).toBe(7);
  });

  it("writes the baseline where baselinePath says it is", () => {
    const file = writeTranscript("f.jsonl", [{ input_tokens: 3 }]);
    readTranscriptDelta(file, spoolFile);
    const stored: unknown = JSON.parse(readFileSync(baselinePath(spoolFile), "utf-8"));
    expect(Object.keys(stored as Record<string, unknown>)).toContain(file);
  });
});
