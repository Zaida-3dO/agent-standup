// The change highlight's bookkeeping — T17, part 3.
import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_MS,
  highlightAdded,
  highlightedIds,
  highlightsSwept,
  noHighlights,
} from "@/lib/live/highlight";

describe("highlightAdded", () => {
  it("marks each changed card with an expiry", () => {
    const marks = highlightAdded(noHighlights(), ["item-a", "item-b"], 1_000);
    expect(marks.get("item-a")).toBe(1_000 + HIGHLIGHT_MS);
    expect(marks.get("item-b")).toBe(1_000 + HIGHLIGHT_MS);
  });

  it("extends a card that changes again while still marked", () => {
    // Two moves two seconds apart are two things that happened; letting the
    // first mark's expiry end the second one's would make the later change
    // the invisible one.
    const first = highlightAdded(noHighlights(), ["item-a"], 1_000);
    const second = highlightAdded(first, ["item-a"], 1_500);
    expect(second.get("item-a")).toBe(1_500 + HIGHLIGHT_MS);
  });

  it("does not mutate the map it was given", () => {
    const first = highlightAdded(noHighlights(), ["item-a"], 1_000);
    highlightAdded(first, ["item-b"], 1_000);
    expect(first.has("item-b")).toBe(false);
  });

  it("returns the same reference for an empty slice", () => {
    const marks = highlightAdded(noHighlights(), ["item-a"], 1_000);
    expect(highlightAdded(marks, [], 2_000)).toBe(marks);
  });
});

describe("highlightsSwept", () => {
  it("drops a mark once it has expired", () => {
    const marks = highlightAdded(noHighlights(), ["item-a"], 1_000);
    expect(highlightsSwept(marks, 1_000 + HIGHLIGHT_MS).size).toBe(0);
  });

  it("keeps a mark that has not", () => {
    const marks = highlightAdded(noHighlights(), ["item-a"], 1_000);
    expect(highlightsSwept(marks, 1_500).has("item-a")).toBe(true);
  });

  it("keeps the unexpired ones while dropping the expired", () => {
    let marks = highlightAdded(noHighlights(), ["old"], 1_000);
    marks = highlightAdded(marks, ["new"], 2_000);
    const swept = highlightsSwept(marks, 1_000 + HIGHLIGHT_MS);
    expect(swept.has("old")).toBe(false);
    expect(swept.has("new")).toBe(true);
  });

  it("returns the same reference when nothing expired, so the board does not re-render", () => {
    // A sweep that allocated a new map every tick would re-render the whole
    // board several times a second for a value that did not change.
    const marks = highlightAdded(noHighlights(), ["item-a"], 1_000);
    expect(highlightsSwept(marks, 1_500)).toBe(marks);
  });
});

describe("highlightedIds", () => {
  it("is the set of marked ids", () => {
    const marks = highlightAdded(noHighlights(), ["item-a", "item-b"], 1_000);
    expect([...highlightedIds(marks)].sort()).toEqual(["item-a", "item-b"]);
  });

  it("is empty when nothing is marked", () => {
    expect(highlightedIds(noHighlights()).size).toBe(0);
  });
});
