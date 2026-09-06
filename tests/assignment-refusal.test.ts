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

  // The three sentences below are the ones an operation overrides when the
  // shared default would describe a write it does not make. Each asserts the
  // override lands AND that the default it replaced is gone — a substitution
  // that only appended would leave both sentences in one message, which is
  // worse than either alone.
  it("a caller that writes no event can replace the 'attribute to' consequence", () => {
    const refusal = describeAssignmentRefusal(
      inputs({ action: "a heartbeat", consequence: "has no assignment row to stamp" }),
    );
    expect(refusal.message).toContain("a heartbeat has no assignment row to stamp");
    // The default describes attributing a write to an assignment. An
    // operation that appends nothing must not claim it was going to.
    expect(refusal.message).not.toContain("nothing to attribute to");
  });

  it("the consequence override reaches the released_free case too, not just never_held", () => {
    // Both cases interpolate it, and a fix applied to one branch only is
    // exactly the divergence this module exists to stop.
    const refusal = describeAssignmentRefusal(
      inputs({
        action: "a heartbeat",
        consequence: "has no assignment row to stamp",
        prior: HELD_AND_RELEASED,
      }),
    );
    expect(refusal.case).toBe("released_free");
    expect(refusal.message).toContain("has no assignment row to stamp");
    expect(refusal.message).not.toContain("nothing to attribute to");
  });

  it("a caller carrying nothing to record can replace the note advice in the taken-over case", () => {
    const refusal = describeAssignmentRefusal(
      inputs({
        action: "a release",
        currentHolder: OTHER_HOLDER,
        takenOverAdvice: "There is nothing here for you to give up — leave it alone.",
      }),
    );
    expect(refusal.case).toBe("taken_over");
    expect(refusal.message).toContain("nothing here for you to give up");
    // Directing a caller with no content to write a note sends it to
    // invent some. The override must displace that, not sit beside it.
    expect(refusal.message).not.toContain("Use note to record what you have");
    // The warning itself is not the caller's to override — whatever advice
    // follows it, the harmful move must still be named.
    expect(refusal.message).toContain("Do NOT claim");
  });

  it("a caller with a better answer than note can replace the never-held alternative", () => {
    const refusal = describeAssignmentRefusal(
      inputs({
        action: "a release",
        neverHeldAlternative: ", and holding nothing is already the outcome a release produces",
      }),
    );
    expect(refusal.case).toBe("never_held");
    expect(refusal.message).toContain("already the outcome a release produces");
    expect(refusal.message).not.toContain("use note instead");
  });

  it("every override is optional — the defaults still serve the caller that passes none", () => {
    // The regression this guards: making the fields required, or dropping
    // the `??` defaults, would silently render "undefined" into a refusal.
    const refusal = describeAssignmentRefusal(inputs({ currentHolder: OTHER_HOLDER }));
    expect(refusal.message).toContain("Use note to record what you have");
    expect(refusal.message).not.toContain("undefined");
    const free = describeAssignmentRefusal(inputs({ prior: HELD_AND_RELEASED }));
    expect(free.message).toContain("nothing to attribute to");
    expect(free.message).not.toContain("undefined");
    const never = describeAssignmentRefusal(inputs());
    expect(never.message).toContain("use note instead");
    expect(never.message).not.toContain("undefined");
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
