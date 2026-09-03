// Open loops as an event pair — SCHEMA.md §3a, src/lib/open-loops.ts.
// Pure units, no database: the fold that decides whether a loop is open is
// the whole behaviour, and it is decided in TypeScript, not in SQL.
import { describe, expect, it } from "vitest";
import {
  InvalidOpenLoopPayloadError,
  deriveOpenLoops,
  parseOpenLoopClosedPayload,
  parseOpenLoopPayload,
  type LoopEventLike,
} from "@/lib/open-loops";

const T0 = new Date("2026-01-01T10:00:00.000Z");
const T1 = new Date("2026-01-02T10:00:00.000Z");

function opened(id: number, loopId: string, text: string, ts: Date = T0): LoopEventLike {
  return { id: BigInt(id), ts, type: "open_loop", payload: { loopId, text } };
}

function closed(id: number, loopId: string, ts: Date = T1): LoopEventLike {
  return { id: BigInt(id), ts, type: "open_loop_closed", payload: { loopId } };
}

// The `OPEN_LOOP_EVENT_TYPES` case that stood here was removed with the
// constant: it asserted the array equalled its own literal, so it could only
// ever fail if someone edited both halves in the same breath. The list that
// survives is `LOOP_EVENT_TYPES`, and it is pinned where it is load-bearing —
// `tests/loop-lifecycle-fold.test.ts` for the fold, and the SQL built from it
// in `loop-shared.ts` / `search.ts`, which a real database rejects if a label
// drifts from the enum.

describe("deriving which loops are still open", () => {
  it("reports a loop that was opened and never closed", () => {
    const loops = deriveOpenLoops([opened(1, "loop-a", "the retry path is untested")]);
    expect(loops).toEqual([
      {
        loopId: "loop-a",
        // A payload with no `kind` — every loop written before the field
        // existed — folds to `work`. This is the whole of the "no migration
        // and nothing breaks" claim, asserted rather than assumed.
        kind: "work",
        text: "the retry path is untested",
        openedAt: T0.toISOString(),
        eventId: "1",
      },
    ]);
  });

  it("does NOT report a loop that was closed", () => {
    // The rejection half, and the reason the whole module exists. Single-
    // character mutation this catches: dropping the `if (closed.has(loopId))
    // continue;` guard in deriveOpenLoops, or negating it.
    const loops = deriveOpenLoops([opened(1, "loop-a", "untested"), closed(2, "loop-a")]);
    expect(loops).toEqual([]);
  });

  it("closes the right loop when several are open at once", () => {
    const loops = deriveOpenLoops([
      opened(1, "loop-a", "a"),
      opened(2, "loop-b", "b"),
      opened(3, "loop-c", "c"),
      closed(4, "loop-b"),
    ]);
    expect(loops.map((l) => l.loopId)).toEqual(["loop-a", "loop-c"]);
  });

  it("resolves a close that arrives BEFORE its open in the stream", () => {
    // Not hypothetical: `events.id` is allocated before commit, so sequence
    // order is not commit order (SCHEMA.md §3), and an import writes rows in
    // whatever order the source listed them. A single-pass fold that only
    // cancelled loops it had already seen opened would report this loop as
    // open. Single-character mutation this catches: collapsing the two
    // passes in deriveOpenLoops into one.
    const loops = deriveOpenLoops([closed(2, "loop-a"), opened(1, "loop-a", "untested")]);
    expect(loops).toEqual([]);
  });

  it("ignores a close for a loop it cannot see the open of", () => {
    // A read of a slice of the ledger can legitimately contain a close whose
    // open is older than the slice. Raising on it would make "catch me up"
    // fail on an ordinary window.
    const loops = deriveOpenLoops([closed(9, "loop-from-last-week"), opened(10, "loop-a", "a")]);
    expect(loops.map((l) => l.loopId)).toEqual(["loop-a"]);
  });

  it("treats the same loop opened twice as one loop, dated from the first time", () => {
    const loops = deriveOpenLoops([
      opened(1, "loop-a", "first wording", T0),
      opened(2, "loop-a", "second wording", T1),
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.openedAt).toBe(T0.toISOString());
    expect(loops[0]!.text).toBe("first wording");
  });

  it("skips a malformed row rather than throwing, because this is the read path", () => {
    // Opposite posture from the parsers below on purpose: one bad row
    // written at any point in history would otherwise make orientation
    // permanently unusable for that item.
    const loops = deriveOpenLoops([
      { id: 1n, ts: T0, type: "open_loop", payload: null },
      { id: 2n, ts: T0, type: "open_loop", payload: { text: "no loopId" } },
      { id: 3n, ts: T0, type: "open_loop", payload: { loopId: "loop-b" } },
      { id: 4n, ts: T0, type: "open_loop", payload: { loopId: "  ", text: "blank id" } },
      opened(5, "loop-ok", "survives"),
    ]);
    expect(loops.map((l) => l.loopId)).toEqual(["loop-ok"]);
  });

  it("ignores events that are neither an open nor a close", () => {
    // Single-character mutation this catches: changing either `!==` in
    // deriveOpenLoops's two type filters to `===` — a checkpoint would then
    // be read as a loop, or every real loop would be skipped.
    const loops = deriveOpenLoops([
      { id: 1n, ts: T0, type: "checkpoint", payload: { loopId: "loop-a", text: "not a loop" } },
      opened(2, "loop-a", "the real one"),
      { id: 3n, ts: T1, type: "note", payload: { loopId: "loop-a" } },
    ]);
    expect(loops.map((l) => l.loopId)).toEqual(["loop-a"]);
  });

  it("accepts a string timestamp as well as a Date", () => {
    const loops = deriveOpenLoops([
      {
        id: 1n,
        ts: "2026-01-01T10:00:00.000Z",
        type: "open_loop",
        payload: { loopId: "a", text: "t" },
      },
    ]);
    expect(loops[0]!.openedAt).toBe(T0.toISOString());
  });

  it("returns an empty list for an empty stream", () => {
    expect(deriveOpenLoops([])).toEqual([]);
  });
});

describe("validating what may be written as a loop", () => {
  it("accepts a well-formed open and a well-formed close", () => {
    expect(parseOpenLoopPayload({ loopId: "loop-a", text: "untested" })).toEqual({
      loopId: "loop-a",
      text: "untested",
    });
    // A close carries an optional reason, so a payload without one reads as
    // `null` — which is every loop closed before the field existed, and
    // every close that simply did not explain itself.
    expect(parseOpenLoopClosedPayload({ loopId: "loop-a", extra: "ignored" })).toEqual({
      loopId: "loop-a",
      reason: null,
    });
  });

  // Row fa83f2b9-3ce6-4e89-a930-aaf949720f8e. Breaks if the parser stops
  // reading `reason` off the payload — the read half of the closure reason
  // being kept rather than accepted and discarded.
  it("reads a closing reason where one was recorded, and null where none was", () => {
    expect(
      parseOpenLoopClosedPayload({ loopId: "loop-a", reason: "resolved by the migration" }),
    ).toEqual({ loopId: "loop-a", reason: "resolved by the migration" });

    // Blank and non-string reasons are "no reason", not a reason of "". The
    // same rule `parseOpenLoopDeletedPayload` applies, so the two terminal
    // events cannot disagree about what an empty explanation means.
    for (const reason of ["", "   ", 7, null]) {
      expect(parseOpenLoopClosedPayload({ loopId: "loop-a", reason }), String(reason)).toEqual({
        loopId: "loop-a",
        reason: null,
      });
    }
  });

  it("refuses an open with no loopId — it could never be closed", () => {
    expect(() => parseOpenLoopPayload({ text: "untested" })).toThrow(InvalidOpenLoopPayloadError);
    expect(() => parseOpenLoopPayload({ loopId: "", text: "untested" })).toThrow(/loopId/);
    expect(() => parseOpenLoopPayload({ loopId: "   ", text: "untested" })).toThrow(/loopId/);
    expect(() => parseOpenLoopPayload({ loopId: 7, text: "untested" })).toThrow(/loopId/);
  });

  it("refuses an open with no text — an unlabelled loop tells a resuming session nothing", () => {
    expect(() => parseOpenLoopPayload({ loopId: "loop-a" })).toThrow(/text/);
    expect(() => parseOpenLoopPayload({ loopId: "loop-a", text: "  " })).toThrow(/text/);
  });

  it("refuses a payload that is not an object at all", () => {
    expect(() => parseOpenLoopPayload(null)).toThrow(/must be an object/);
    expect(() => parseOpenLoopPayload(["loop-a"])).toThrow(/must be an object/);
    expect(() => parseOpenLoopClosedPayload("loop-a")).toThrow(/must be an object/);
  });

  it("refuses a close with no loopId", () => {
    expect(() => parseOpenLoopClosedPayload({})).toThrow(/loopId/);
    expect(() => parseOpenLoopClosedPayload({ loopId: "" })).toThrow(/loopId/);
  });
});
