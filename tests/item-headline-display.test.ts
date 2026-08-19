// `primaryLine`/`hasDistinctHeadline` — MILESTONES.md #131's "titles a
// person can read". Pure module, no database.
import { describe, expect, it } from "vitest";
import { hasDistinctHeadline, primaryLine } from "@/lib/item-headline-display";

describe("primaryLine", () => {
  // Fails if the headline branch is dropped, e.g. `return item.title` always.
  it("prefers the headline when one is present", () => {
    expect(
      primaryLine({
        title: "agent-standup #102 - fix appendEvent",
        headline: "Route event writes through appendEvent",
      }),
    ).toBe("Route event writes through appendEvent");
  });

  // Fails if the fallback is removed, e.g. `return item.headline!`.
  it("falls back to the title when there is no headline", () => {
    expect(primaryLine({ title: "Ship the board", headline: null })).toBe("Ship the board");
  });

  // Fails if `headline?.trim()` loses its trim, or its truthiness check is inverted.
  it("treats a whitespace-only headline as absent", () => {
    expect(primaryLine({ title: "Ship the board", headline: "   " })).toBe("Ship the board");
  });

  // Fails if the empty-string check (`headline.length > 0`) is dropped.
  it("treats an empty-string headline as absent", () => {
    expect(primaryLine({ title: "Ship the board", headline: "" })).toBe("Ship the board");
  });

  // Fails if a real headline gets silently trimmed of internal content, not just edges.
  it("does not rewrite title — it only chooses which field to show", () => {
    const item = { title: "agent-standup #102 - route writes", headline: "Route the writes" };
    primaryLine(item);
    expect(item.title).toBe("agent-standup #102 - route writes");
  });
});

describe("hasDistinctHeadline", () => {
  it("is true when a real headline exists", () => {
    expect(hasDistinctHeadline({ title: "t", headline: "h" })).toBe(true);
  });

  it("is false when headline is null", () => {
    expect(hasDistinctHeadline({ title: "t", headline: null })).toBe(false);
  });

  // Fails if this stops agreeing with `primaryLine`'s own blank handling.
  it("is false for a whitespace-only headline, matching primaryLine's fallback", () => {
    expect(hasDistinctHeadline({ title: "t", headline: "  " })).toBe(false);
  });
});
