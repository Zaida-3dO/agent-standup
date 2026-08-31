// The three-case split behind the refusal a call makes when it holds no live
// assignment (checkpoint / heartbeat / release).
//
// These assert that the three cases are DISTINGUISHABLE, which is the whole
// deliverable. A test that asserted merely "a refusal happened" would pass
// for all three and prove nothing — it is the shape that let the original
// defect ship, and the shape a regression would restore.
import { describe, expect, it } from "vitest";
import {
  describeAssignmentRefusal,
  type AssignmentRefusalInputs,
} from "@/lib/service/items/assignment-refusal";

function inputs(overrides: Partial<AssignmentRefusalInputs> = {}): AssignmentRefusalInputs {
  return {
    sessionId: "mine",
    itemId: "item-1",
    action: "a checkpoint",
    prior: null,
    currentHolder: null,
    ...overrides,
  };
}

const HELD_AND_RELEASED = { releasedAt: new Date("2026-08-31T12:00:00Z"), liveness: "dead" };
const OTHER_HOLDER = { sessionId: "theirs", role: "builder" };

describe("describeAssignmentRefusal — the three cases are distinguishable", () => {
  it("never held: routes to note or claim, and does NOT claim anything was released", () => {
    const refusal = describeAssignmentRefusal(inputs());
    expect(refusal.case).toBe("never_held");
    expect(refusal.message).toContain("never held an assignment");
    expect(refusal.message).toContain("note");
    // The distinguishing negative: this caller lost nothing, so telling it
    // its assignment "was released" would send it looking for a takeover
    // that never happened.
    expect(refusal.message).not.toContain("was released");
  });

  it("released and free: says re-claiming is safe, and says so explicitly", () => {
    const refusal = describeAssignmentRefusal(inputs({ prior: HELD_AND_RELEASED }));
    expect(refusal.case).toBe("released_free");
    expect(refusal.message).toContain("was released");
    expect(refusal.message).toContain("safe");
    expect(refusal.message).toContain("No other session holds this item");
    // Must NOT carry the case-3 warning, or the reader is warned off the
    // recovery that is correct here.
    expect(refusal.message).not.toContain("Do NOT");
  });

  it("taken over: warns AGAINST re-claiming and names the session that holds it", () => {
    const refusal = describeAssignmentRefusal(
      inputs({ prior: HELD_AND_RELEASED, currentHolder: OTHER_HOLDER }),
    );
    expect(refusal.case).toBe("taken_over");
    expect(refusal.message).toContain("Do NOT claim");
    expect(refusal.message).toContain("theirs");
    expect(refusal.message).toContain("builder");
    // The harmful-guess guard: case 3 must never tell the reader that
    // claiming is safe. This is the single assertion that would have
    // prevented the reported near-miss.
    expect(refusal.message).not.toContain("safe");
  });

  it("all three messages differ from each other pairwise", () => {
    const never = describeAssignmentRefusal(inputs()).message;
    const free = describeAssignmentRefusal(inputs({ prior: HELD_AND_RELEASED })).message;
    const taken = describeAssignmentRefusal(
      inputs({ prior: HELD_AND_RELEASED, currentHolder: OTHER_HOLDER }),
    ).message;
    expect(new Set([never, free, taken]).size).toBe(3);
  });

  it("a current holder wins over the never-held reading, and still warns", () => {
    // Someone else holds it and this session never did: still case 3,
    // because the harmful move (claiming it away from them) is available
    // here too.
    const refusal = describeAssignmentRefusal(inputs({ currentHolder: OTHER_HOLDER }));
    expect(refusal.case).toBe("taken_over");
    expect(refusal.message).toContain("Do NOT claim");
    expect(refusal.message).toContain("holds no assignment");
  });

  it("names the action it was asked about, so the message suits its caller", () => {
    const refusal = describeAssignmentRefusal(inputs({ action: "a heartbeat" }));
    expect(refusal.message).toContain("a heartbeat");
    expect(refusal.message).not.toContain("a checkpoint");
  });

  it("a holder with no role reads cleanly rather than emitting 'as null'", () => {
    const refusal = describeAssignmentRefusal(
      inputs({ currentHolder: { sessionId: "theirs", role: null } }),
    );
    expect(refusal.message).toContain("theirs");
    expect(refusal.message).not.toContain("as null");
    expect(refusal.message).not.toContain("undefined");
  });
});
