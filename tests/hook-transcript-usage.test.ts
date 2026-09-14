// MILESTONES.md #88, SCHEMA.md §10 — recovering token counts from the
// session transcript (`src/lib/hook/transcript-usage.ts`).
//
// **Why this module exists at all**, restated here because it is the fact
// that makes the tests below the right tests: the Claude Code hook payload
// carries NO token usage under any key. That was measured against a live
// session on 2026-09-14 (a dump hook on PostToolUse/Stop/SessionEnd) and
// agrees with the vendor's hooks reference. The counts do exist in the file
// `transcript_path` names, so this module reads them from there.
//
// Two properties dominate:
//
//   1. **It never throws.** It runs on the critical path of every tool
//      call, behind a hook whose job is deciding whether a command may run.
//   2. **The reading is cumulative and the caller takes a delta.** The
//      transcript is re-read from the top on every call, so anything that
//      summed per-call readings would count one assistant turn once per
//      tool call in that turn and inflate a bill several-fold.
import { describe, expect, it } from "vitest";
import { emptyTranscriptUsage, readTranscriptUsage, usageDelta } from "@/lib/hook/transcript-usage";

/** One assistant line in the shape the transcript actually uses, measured. */
function assistantLine(usage: Record<string, unknown>, model = "claude-opus-4-8"): string {
  return JSON.stringify({ type: "assistant", message: { model, usage } });
}

describe("reading a transcript never fails", () => {
  it("reads an empty transcript as a measurement of nothing", () => {
    expect(readTranscriptUsage("")).toEqual(emptyTranscriptUsage());
  });

  it("skips a malformed trailing line instead of losing the whole file", () => {
    // The transcript is appended to asynchronously, so a partial final line
    // is the ORDINARY state, not corruption. Aborting the scan on it would
    // discard a whole session's usage for a byte that is about to arrive.
    //
    // Fails if the `continue` in the JSON.parse catch becomes a `return`
    // or a throw: the first line's 11 input tokens would be lost.
    const contents = assistantLine({ input_tokens: 11 }) + '\n{"type":"assist';
    expect(readTranscriptUsage(contents).inputTokens).toBe(11);
  });

  it("ignores a line that carries no usage block", () => {
    const contents = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "queue-operation", operation: "x" }),
    ].join("\n");
    expect(readTranscriptUsage(contents)).toEqual(emptyTranscriptUsage());
  });

  it("treats a non-numeric count as zero rather than poisoning the sum", () => {
    // One NaN admitted into the accumulator would make the total NaN, and
    // then every delta computed from it NaN — one malformed line breaking a
    // whole session's metering.
    //
    // Fails if `count()` drops its Number.isFinite/typeof guard.
    const contents = [
      assistantLine({ input_tokens: "120", output_tokens: 5 }),
      assistantLine({ input_tokens: 7 }),
    ].join("\n");
    const usage = readTranscriptUsage(contents);
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(5);
    expect(Number.isNaN(usage.inputTokens)).toBe(false);
  });
});

describe("the four counts are read under the vendor's spellings", () => {
  it("reads the exact keys a real transcript carries", () => {
    // These four spellings are what was measured on a live transcript. A
    // rename here silently returns zero for that count forever.
    //
    // Fails on changing any one of the four key strings in the module.
    const usage = readTranscriptUsage(
      assistantLine({
        input_tokens: 3500,
        output_tokens: 260,
        cache_creation_input_tokens: 24885,
        cache_read_input_tokens: 12,
      }),
    );
    expect(usage).toEqual({
      inputTokens: 3500,
      outputTokens: 260,
      cacheWriteTokens: 24885,
      cacheReadTokens: 12,
      model: "claude-opus-4-8",
    });
  });

  it("sums across every assistant message in the file", () => {
    // Fails if the accumulator assigns (`=`) instead of adding (`+=`),
    // which would report only the last message and undercount a whole
    // session down to one turn.
    const contents = [
      assistantLine({ input_tokens: 10, output_tokens: 1 }),
      assistantLine({ input_tokens: 20, output_tokens: 2 }),
      assistantLine({ input_tokens: 30, output_tokens: 3 }),
    ].join("\n");
    const usage = readTranscriptUsage(contents);
    expect(usage.inputTokens).toBe(60);
    expect(usage.outputTokens).toBe(6);
  });

  it("reports the LAST model seen, so a mid-session switch is visible", () => {
    // Last rather than first: a session that switched model should report
    // the one in force now. Fails if the assignment is guarded to only set
    // the model when it is still undefined.
    const contents = [
      assistantLine({ input_tokens: 1 }, "claude-sonnet-4-5"),
      assistantLine({ input_tokens: 1 }, "claude-opus-4-8"),
    ].join("\n");
    expect(readTranscriptUsage(contents).model).toBe("claude-opus-4-8");
  });

  it("omits the model entirely when no message named one", () => {
    // Absent must stay absent rather than becoming an empty string: the
    // ingest maps "nothing reported" onto a run-boundary decision that
    // ADOPTS into the open run, while a value that differs CUTS a new one.
    const usage = readTranscriptUsage(JSON.stringify({ message: { usage: { input_tokens: 4 } } }));
    expect(usage.model).toBeUndefined();
    expect("model" in usage).toBe(false);
  });
});

describe("the delta is what gets attributed", () => {
  it("subtracts what was already counted", () => {
    // The property the whole design rests on. Fails if `usageDelta`
    // returns `current` unchanged — which is exactly the bug that would
    // multiply a session's tokens by its tool-call count.
    const previous = {
      inputTokens: 100,
      outputTokens: 10,
      cacheWriteTokens: 5,
      cacheReadTokens: 1,
    };
    const current = { inputTokens: 130, outputTokens: 14, cacheWriteTokens: 5, cacheReadTokens: 9 };
    expect(usageDelta(current, previous)).toEqual({
      inputTokens: 30,
      outputTokens: 4,
      cacheWriteTokens: 0,
      cacheReadTokens: 8,
    });
  });

  it("clamps a backwards reading to zero instead of crediting the bill", () => {
    // A cumulative total can legitimately go backwards — a resumed session
    // against a fresh transcript, a compaction, a rotated file. A negative
    // token count flowing into a cost is a CREDIT: one rotation would
    // silently cancel out spend that had already been recorded.
    //
    // Fails if `positive()` becomes a bare subtraction.
    const previous = {
      inputTokens: 500,
      outputTokens: 50,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    const current = { inputTokens: 20, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0 };
    const delta = usageDelta(current, previous);
    expect(delta.inputTokens).toBe(0);
    expect(delta.outputTokens).toBe(0);
  });

  it("carries the model through even when no new tokens were counted", () => {
    // A call that consumed no NEW tokens was still served by a model, and
    // the model is what lets the run be priced at all. Fails if the model
    // is dropped whenever the delta is zero.
    const same = { inputTokens: 9, outputTokens: 9, cacheWriteTokens: 0, cacheReadTokens: 0 };
    const delta = usageDelta({ ...same, model: "claude-opus-4-8" }, same);
    expect(delta.model).toBe("claude-opus-4-8");
    expect(delta.inputTokens).toBe(0);
  });
});
