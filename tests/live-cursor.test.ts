// The live cursor's arithmetic — T17.
//
// The property under test is the one the row names: **no missed and no
// duplicated events**. The server side of that (`readSinceBounded`'s
// `txId < visibilityHorizon` bound) is already proven elsewhere; what these
// assert is the client's half, which is narrower and entirely about not
// undoing the server's work — carry the cursor back verbatim, never rewind
// it, and never round it.
import { describe, expect, it } from "vitest";
import { advanceCursor, compareCursors, isCursor, INITIAL_CURSOR } from "@/lib/live/cursor";

describe("isCursor", () => {
  it("accepts a decimal string", () => {
    expect(isCursor("0")).toBe(true);
    expect(isCursor("918273645")).toBe(true);
  });

  it("rejects anything that is not one", () => {
    expect(isCursor("")).toBe(false);
    expect(isCursor("12a")).toBe(false);
    expect(isCursor("-1")).toBe(false);
    expect(isCursor("1.5")).toBe(false);
    expect(isCursor(12)).toBe(false);
    expect(isCursor(null)).toBe(false);
    expect(isCursor(undefined)).toBe(false);
  });
});

describe("compareCursors", () => {
  it("orders by numeric value, not by string order", () => {
    // The case a naive `a < b` gets wrong: "9" sorts after "10" as a string.
    expect(compareCursors("9", "10")).toBeLessThan(0);
    expect(compareCursors("10", "9")).toBeGreaterThan(0);
  });

  it("is exact past 2^53, where a JSON number would have rounded", () => {
    // 9007199254740993 is 2^53 + 1; as a double it is indistinguishable from
    // 2^53. Comparing these as numbers reports them equal, which is the
    // silent-skip defect the string cursor exists to prevent.
    const a = "9007199254740992";
    const b = "9007199254740993";
    expect(Number(a) === Number(b)).toBe(true);
    expect(compareCursors(b, a)).toBeGreaterThan(0);
  });

  it("treats leading zeros as the same number", () => {
    expect(compareCursors("007", "7")).toBe(0);
  });

  it("reports equality as zero", () => {
    expect(compareCursors("42", "42")).toBe(0);
  });
});

describe("advanceCursor", () => {
  it("moves forward to a newer cursor", () => {
    expect(advanceCursor("10", "25")).toBe("25");
  });

  it("refuses to rewind — an out-of-order response cannot replay a slice", () => {
    // Two polls in flight: the slower one started earlier and answers later,
    // carrying an older cursor. Obeying it would re-read and re-apply
    // everything between, which is the duplicate half of the row's criterion.
    expect(advanceCursor("25", "10")).toBe("25");
  });

  it("holds the cursor when the response has none, rather than resetting to zero", () => {
    // Resetting would re-read the whole ledger from the start — one bad
    // response turned into a flood.
    expect(advanceCursor("25", undefined)).toBe("25");
    expect(advanceCursor("25", null)).toBe("25");
    expect(advanceCursor("25", "not-a-number")).toBe("25");
    expect(advanceCursor("25", 30)).toBe("25");
  });

  it("starts from zero", () => {
    expect(INITIAL_CURSOR).toBe("0");
    expect(advanceCursor(INITIAL_CURSOR, "1")).toBe("1");
  });
});
