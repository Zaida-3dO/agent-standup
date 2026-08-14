// MILESTONES.md #88 — the local spool (`src/lib/hook/spool.ts`),
// DECISIONS.md §13f ("telemetry spools locally and flushes in batches").
//
// Three properties are worth more than the rest of this file put together,
// and each has a section below:
//
//   1. **A malformed line is skipped, never fatal.** Telemetry that refuses
//      to load because one line is torn is telemetry that gets deleted by
//      whoever hits it, and then there is none. The torn-line tests are the
//      whole reason the format is JSON Lines rather than a JSON array.
//   2. **A full spool drops the OLDEST, and says how many.** Dropping the
//      newest would make a full spool silently stop recording, which looks
//      exactly like a spool that is working.
//   3. **A blank line is not damage.** A trailing newline is the normal
//      state of an append-only file; counting it as corruption would report
//      a fault on every healthy spool, which is how a real signal gets
//      ignored.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_RECORDS,
  batches,
  parseRecord,
  readSpool,
  serialiseRecord,
  serialiseSpool,
  trimSpool,
} from "@/lib/hook/spool";
import type { SpooledToolCall } from "@/lib/hook/spool-record";

function record(overrides: Partial<SpooledToolCall> = {}): SpooledToolCall {
  return {
    sessionId: "session-a",
    ts: "2026-01-01T00:00:00.000Z",
    tool: "Bash",
    command: "git status",
    inputTokens: 1,
    outputTokens: 2,
    cacheWriteTokens: 3,
    cacheReadTokens: 4,
    ...overrides,
  };
}

describe("one record is one line", () => {
  it("serialises to a single newline-terminated line", () => {
    const line = serialiseRecord(record());
    expect(line.endsWith("\n")).toBe(true);
    // The property the whole format rests on: an append must not be able to
    // damage the line before it, which requires exactly one newline and
    // none embedded.
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });

  it("round-trips through parseRecord unchanged", () => {
    const original = record({ paths: ["src/a.ts"], model: "vendor-model-1" });
    expect(parseRecord(serialiseRecord(original).trim())).toEqual(original);
  });

  it("survives a command containing newlines and quotes", () => {
    // A heredoc is the common case and it is full of both. If this were
    // ever written unescaped the file would gain lines that parse as
    // nothing, corrupting records that were written correctly.
    const original = record({ command: 'printf "a\nb"\n' });
    const line = serialiseRecord(original);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(parseRecord(line.trim())).toEqual(original);
  });
});

describe("a malformed line is skipped, never fatal", () => {
  it("keeps every good record around a torn one and counts the loss", () => {
    // The crash case: a process killed mid-append leaves a partial line.
    const text = `${serialiseRecord(record({ tool: "Read" }))}{"sessionId":"a","ts":"x","to\n${serialiseRecord(record({ tool: "Grep" }))}`;
    const contents = readSpool(text);
    expect(contents.records.map((one) => one.tool)).toEqual(["Read", "Grep"]);
    expect(contents.skipped).toBe(1);
  });

  it("reads a spool of pure garbage as empty rather than throwing", () => {
    const contents = readSpool("not json\nalso not json\n");
    expect(contents.records).toEqual([]);
    expect(contents.skipped).toBe(2);
  });

  it("does not count blank lines as damage", () => {
    // A trailing newline is the normal state of an append-only file.
    const contents = readSpool(`${serialiseRecord(record())}\n\n`);
    expect(contents.records.length).toBe(1);
    expect(contents.skipped).toBe(0);
  });

  it("reads a missing or empty spool as empty, with nothing skipped", () => {
    expect(readSpool(undefined)).toEqual({ records: [], skipped: 0 });
    expect(readSpool("")).toEqual({ records: [], skipped: 0 });
  });

  it("rejects a line that is valid JSON but not a record", () => {
    // Each of these parses; none of them is a tool call. Accepting one
    // would put a record on the wire with a missing required column.
    expect(parseRecord("[]")).toBe(undefined);
    expect(parseRecord("null")).toBe(undefined);
    expect(parseRecord("42")).toBe(undefined);
    expect(parseRecord('"a string"')).toBe(undefined);
    expect(parseRecord("{}")).toBe(undefined);
    expect(parseRecord('{"sessionId":"a","ts":"b"}')).toBe(undefined);
    expect(parseRecord('{"sessionId":"","ts":"b","tool":"Bash"}')).toBe(undefined);
    expect(parseRecord('{"sessionId":"a","ts":"b","tool":""}')).toBe(undefined);
  });

  it("keeps a record written by a newer build that added a field", () => {
    // The upgrade case, and the reason the check is deliberately shallow:
    // a strict schema would discard real telemetry written by a later
    // version of the hook into the same file on the same machine.
    const parsed = parseRecord(
      '{"sessionId":"a","ts":"b","tool":"Bash","somethingNew":{"nested":true}}',
    );
    expect(parsed?.tool).toBe("Bash");
    expect((parsed as unknown as Record<string, unknown>).somethingNew).toEqual({ nested: true });
  });
});

describe("the ceiling drops the oldest and reports how many", () => {
  it("keeps everything when under the ceiling", () => {
    const records = [record({ tool: "a" }), record({ tool: "b" })];
    expect(trimSpool(records, 10)).toEqual({ records, dropped: 0 });
  });

  it("keeps exactly the ceiling at the boundary, dropping nothing", () => {
    const records = [record({ tool: "a" }), record({ tool: "b" })];
    expect(trimSpool(records, 2).dropped).toBe(0);
  });

  it("drops from the front, keeping the newest", () => {
    // The direction is the point. A `slice(0, max)` would pass a length
    // assertion and keep precisely the wrong records.
    const records = [record({ tool: "a" }), record({ tool: "b" }), record({ tool: "c" })];
    const trimmed = trimSpool(records, 2);
    expect(trimmed.records.map((one) => one.tool)).toEqual(["b", "c"]);
    expect(trimmed.dropped).toBe(1);
  });

  it("treats a ceiling of zero as keeping nothing, and counts it all as dropped", () => {
    const records = [record(), record()];
    expect(trimSpool(records, 0)).toEqual({ records: [], dropped: 2 });
  });

  it("has a default ceiling large enough to hold days of outage", () => {
    // Guards the constant against being edited to something that would make
    // the drop path routine rather than exceptional.
    expect(DEFAULT_MAX_RECORDS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("batching", () => {
  it("splits into full batches and one remainder", () => {
    const records = Array.from({ length: 5 }, (_, index) => record({ tool: `t${index}` }));
    const grouped = batches(records, 2);
    expect(grouped.map((one) => one.length)).toEqual([2, 2, 1]);
  });

  it("preserves order across batch boundaries", () => {
    // Records are sent in the order they happened; a batcher that reversed
    // or interleaved would still produce correctly-sized batches.
    const records = Array.from({ length: 5 }, (_, index) => record({ tool: `t${index}` }));
    expect(
      batches(records, 2)
        .flat()
        .map((one) => one.tool),
    ).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("produces no batches for no records", () => {
    expect(batches([], 10)).toEqual([]);
  });

  it("does not loop forever on a non-positive batch size", () => {
    // Reachable from configuration. A `size` of zero would slice
    // zero-length batches indefinitely, hanging the flush.
    const records = [record({ tool: "a" }), record({ tool: "b" })];
    expect(batches(records, 0).map((one) => one.length)).toEqual([1, 1]);
    expect(batches(records, -3).map((one) => one.length)).toEqual([1, 1]);
  });

  it("has a default batch size that is neither one nor unbounded", () => {
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(1);
    expect(DEFAULT_BATCH_SIZE).toBeLessThan(DEFAULT_MAX_RECORDS);
  });
});

describe("the spool round-trips as a whole", () => {
  it("serialises and reads back the same records", () => {
    const records = [record({ tool: "a" }), record({ tool: "b", command: undefined })];
    expect(readSpool(serialiseSpool(records)).records).toEqual(records);
  });

  it("serialises an empty set to an empty string, not a stray newline", () => {
    // A stray newline is harmless to `readSpool` but means an "empty" spool
    // file is not byte-empty, which makes an emptiness check elsewhere
    // subtly wrong.
    expect(serialiseSpool([])).toBe("");
  });

  it("appending is concatenation, so no read is needed to write", () => {
    // The performance property stated in the module header, asserted rather
    // than trusted: if serialisation ever became context-dependent, the
    // append-only write path would silently stop being correct.
    const first = record({ tool: "a" });
    const second = record({ tool: "b" });
    expect(serialiseSpool([first, second])).toBe(serialiseRecord(first) + serialiseRecord(second));
  });
});
