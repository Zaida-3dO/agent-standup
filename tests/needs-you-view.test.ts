// src/lib/needs-you/view.ts — ordering, the waiting-age label, and the
// per-reason presentation of the respond controls. Pure functions over
// plain data, so these run with no DOM and no database.
import { describe, expect, it } from "vitest";
import {
  DECISION_LABELS,
  REASON_LABELS,
  REASON_PROMPTS,
  canDecide,
  linksToReviews,
  shortSha,
  sortByWaiting,
  waitingFor,
} from "@/lib/needs-you/view";
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
    needsVisualReview: false,
    tipCommitSha: null,
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

describe("canDecide", () => {
  it("is true for plan_review, which pins no commit", () => {
    expect(canDecide(item({ reason: "plan_review" }))).toBe(true);
  });

  it("is true for a commit-pinning reason once a commit exists", () => {
    expect(canDecide(item({ reason: "needs_approval", tipCommitSha: "abc1234" }))).toBe(true);
    expect(canDecide(item({ reason: "needs_visual_review", tipCommitSha: "abc1234" }))).toBe(true);
  });

  it("is false for a commit-pinning reason with no commit — record_artifact would refuse it", () => {
    expect(canDecide(item({ reason: "needs_approval", tipCommitSha: null }))).toBe(false);
    expect(canDecide(item({ reason: "needs_visual_review", tipCommitSha: null }))).toBe(false);
  });
});

describe("linksToReviews", () => {
  it("sends every reason but blocked_on_you to the Reviews tab", () => {
    expect(linksToReviews(item({ reason: "needs_approval" }))).toBe(true);
    expect(linksToReviews(item({ reason: "needs_visual_review" }))).toBe(true);
    expect(linksToReviews(item({ reason: "plan_review" }))).toBe(true);
  });

  it("sends blocked_on_you to the item — it has no review artifact to point at", () => {
    expect(linksToReviews(item({ reason: "blocked_on_you" }))).toBe(false);
  });
});

describe("shortSha", () => {
  it("abbreviates to seven characters", () => {
    expect(shortSha("a1b2c3d4e5f6a7b8c9d0")).toBe("a1b2c3d");
  });

  it("passes null through, so a row with no commit shows nothing", () => {
    expect(shortSha(null)).toBeNull();
  });
});

describe("REASON_LABELS", () => {
  it("names all four reasons distinctly", () => {
    const labels = Object.values(REASON_LABELS);
    expect(labels).toHaveLength(4);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("does not call the merge authorisation a review", () => {
    // The label a person reads before authorising a merge must not describe
    // the act as reviewing code — that conflation is the defect this screen
    // was rebuilt to remove.
    expect(REASON_LABELS.needs_approval.toLowerCase()).not.toContain("review");
  });
});

describe("REASON_PROMPTS", () => {
  it("explains every reason", () => {
    expect(Object.keys(REASON_PROMPTS)).toHaveLength(4);
    for (const prompt of Object.values(REASON_PROMPTS)) {
      expect(prompt.length).toBeGreaterThan(0);
    }
  });
});

describe("DECISION_LABELS", () => {
  it("gives each decision reason its own verb rather than a shared Approve", () => {
    const approves = Object.values(DECISION_LABELS).map((pair) => pair.approve);
    expect(new Set(approves).size).toBe(approves.length);
  });

  it("offers no rejecting control for needs_approval — approval is withheld, not refused", () => {
    expect(DECISION_LABELS.needs_approval?.reject).toBeNull();
  });

  it("offers a rejecting control for the reasons that have one", () => {
    expect(DECISION_LABELS.needs_visual_review?.reject).not.toBeNull();
    expect(DECISION_LABELS.plan_review?.reject).not.toBeNull();
  });
});
