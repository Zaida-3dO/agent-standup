// src/lib/needs-you/view.ts — ordering, the waiting-age label, and which
// reasons are decidable in place. Pure functions over plain data, so these
// run with no DOM and no database.
import { describe, expect, it } from "vitest";
import { REASON_LABELS, isDecidable, sortByWaiting, waitingFor } from "@/lib/needs-you/view";
import type { NeedsYouItem } from "@/lib/needs-you/types";

function item(overrides: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: "item-a",
    title: "Item A",
    headline: null,
    state: "blocked",
    reason: "blocked_on_you",
    blockedReason: null,
    updatedAt: "2026-08-18T10:00:00.000Z",
    mergeAuthority: "agent_judgement",
    ...overrides,
  };
}

describe("sortByWaiting", () => {
  it("orders oldest-first by updatedAt", () => {
    const newer = item({ id: "newer", updatedAt: "2026-08-18T12:00:00.000Z" });
    const older = item({ id: "older", updatedAt: "2026-08-18T08:00:00.000Z" });
    expect(sortByWaiting([newer, older])).toEqual([older, newer]);
  });

  it("breaks a tie on updatedAt by id, so the order is deterministic", () => {
    const a = item({ id: "a", updatedAt: "2026-08-18T10:00:00.000Z" });
    const b = item({ id: "b", updatedAt: "2026-08-18T10:00:00.000Z" });
    expect(sortByWaiting([b, a])).toEqual([a, b]);
  });

  it("sorts a copy, leaving the input array untouched", () => {
    const newer = item({ id: "newer", updatedAt: "2026-08-18T12:00:00.000Z" });
    const older = item({ id: "older", updatedAt: "2026-08-18T08:00:00.000Z" });
    const input = [newer, older];
    sortByWaiting(input);
    expect(input).toEqual([newer, older]);
  });
});

describe("waitingFor", () => {
  it("reports a short age with no trailing 'ago'", () => {
    const now = Date.parse("2026-08-18T13:00:00.000Z");
    const threeHoursAgo = item({ updatedAt: "2026-08-18T10:00:00.000Z" });
    expect(waitingFor(threeHoursAgo, now)).toBe("3h");
  });
});

describe("isDecidable", () => {
  it("is true for plan_review and needs_approval", () => {
    expect(isDecidable(item({ reason: "plan_review" }))).toBe(true);
    expect(isDecidable(item({ reason: "needs_approval" }))).toBe(true);
  });

  it("is false for blocked_on_you — no single unblock transition exists to approve or deny", () => {
    expect(isDecidable(item({ reason: "blocked_on_you" }))).toBe(false);
  });
});

describe("REASON_LABELS", () => {
  it("names all three reasons distinctly", () => {
    const labels = Object.values(REASON_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
