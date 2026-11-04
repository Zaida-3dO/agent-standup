// The one plain line the item page says about each document an item carries
// ("notes: 12 entries, 9 KB"). Pure, so no database: the claims are about
// how a count and a size are worded, and about what happens at the edges of
// each unit, where a formatter is usually wrong.
import { describe, expect, it } from "vitest";
import { documentLine, formatDocumentSize } from "@/lib/item-detail/documents";

describe("formatDocumentSize", () => {
  it("says bytes below a thousand, singular for exactly one", () => {
    expect(formatDocumentSize(0)).toBe("0 bytes");
    expect(formatDocumentSize(1)).toBe("1 byte");
    expect(formatDocumentSize(999)).toBe("999 bytes");
  });

  it("uses decimal kilobytes, so 9,000 bytes reads as 9 KB and not 8.8", () => {
    // Killed by dividing by 1024 instead of 1000.
    expect(formatDocumentSize(9_000)).toBe("9 KB");
    expect(formatDocumentSize(1000)).toBe("1 KB");
  });

  it("keeps one decimal under 10 KB and drops it when it would be .0", () => {
    expect(formatDocumentSize(1500)).toBe("1.5 KB");
    expect(formatDocumentSize(9_960)).toBe("10 KB");
    expect(formatDocumentSize(2000)).toBe("2 KB");
  });

  it("rounds to whole kilobytes from 10 KB up", () => {
    expect(formatDocumentSize(10_400)).toBe("10 KB");
    expect(formatDocumentSize(10_600)).toBe("11 KB");
  });

  it("switches to megabytes at a million bytes", () => {
    expect(formatDocumentSize(1_000_000)).toBe("1 MB");
    expect(formatDocumentSize(2_500_000)).toBe("2.5 MB");
  });
});

describe("documentLine", () => {
  it("reads as the name, the entries and the size", () => {
    expect(documentLine({ doc: "notes", entries: 12, bytes: 9_000 })).toBe(
      "notes: 12 entries, 9 KB",
    );
  });

  it("is singular for one entry", () => {
    expect(documentLine({ doc: "plan", entries: 1, bytes: 420 })).toBe("plan: 1 entry, 420 bytes");
  });

  it("carries no value, only the name and two numbers", () => {
    // The summary type has no place for a value, so none can reach the page.
    const line = documentLine({ doc: "notes", entries: 2, bytes: 3000 });
    expect(line).toBe("notes: 2 entries, 3 KB");
  });
});
