// The override channel — `src/lib/hook/override.ts` and its use in
// `src/lib/hook/decide.ts`.
//
// What these tests are protecting is a distinction that did not exist
// before: `block-overridable` and `hard-block` used to behave identically,
// because nothing carried an override. So the assertions come in pairs —
// for every "an override lets this through", there is a "and this one it
// must not", because a channel that opened everything would pass a test
// suite that only checked the happy path.

import { describe, expect, it } from "vitest";
import {
  MAX_OVERRIDE_REASON_LENGTH,
  MIN_OVERRIDE_REASON_LENGTH,
  overrideApplies,
  overrideRemedy,
  readOverrideClaim,
} from "@/lib/hook/override";

/** A reason comfortably over the floor, so length is never the variable. */
const GOOD_REASON = "Nothing changed since review except the changelog wording.";

describe("overrideApplies", () => {
  it("honours a well-formed override of a block-overridable finding", () => {
    const outcome = overrideApplies(
      { entryId: "broad-process-kill", reason: GOOD_REASON },
      "broad-process-kill",
      "block-overridable",
    );
    expect(outcome.applies).toBe(true);
    expect(outcome.reason).toBe(GOOD_REASON);
  });

  it("records the reason rather than discarding it", () => {
    // The entire value of this tier is the recorded reason (#128's
    // block-and-record). An implementation that returned `applies: true`
    // and dropped the text would satisfy every other test here.
    const outcome = overrideApplies(
      { entryId: "e", reason: GOOD_REASON },
      "e",
      "block-overridable",
    );
    expect(outcome.reason).toBe(GOOD_REASON);
  });

  it("refuses a hard-block however well-formed the override is", () => {
    const outcome = overrideApplies(
      { entryId: "e", reason: GOOD_REASON },
      "e",
      "hard-block",
    );
    expect(outcome.applies).toBe(false);
    expect(outcome.refusal).toBe("level-not-overridable");
  });

  it("refuses when no override was sent", () => {
    const outcome = overrideApplies(undefined, "e", "block-overridable");
    expect(outcome.applies).toBe(false);
    expect(outcome.refusal).toBe("no-override");
  });

  it("refuses an override naming a different entry", () => {
    // The scoping property: one written reason must not excuse a guard the
    // caller never looked at.
    const outcome = overrideApplies(
      { entryId: "some-other-entry", reason: GOOD_REASON },
      "broad-process-kill",
      "block-overridable",
    );
    expect(outcome.applies).toBe(false);
    expect(outcome.refusal).toBe("wrong-entry");
  });

  it("refuses a reason with no content in it", () => {
    const outcome = overrideApplies({ entryId: "e", reason: "ok" }, "e", "block-overridable");
    expect(outcome.applies).toBe(false);
    expect(outcome.refusal).toBe("reason-too-short");
  });

  it("refuses a reason that is only whitespace padding", () => {
    // Trimmed before measuring, so spaces cannot buy the length.
    const padded = " ".repeat(MIN_OVERRIDE_REASON_LENGTH + 10);
    const outcome = overrideApplies({ entryId: "e", reason: padded }, "e", "block-overridable");
    expect(outcome.applies).toBe(false);
    expect(outcome.refusal).toBe("reason-too-short");
  });

  it("accepts a reason exactly at the floor and refuses one a character under", () => {
    const atFloor = "x".repeat(MIN_OVERRIDE_REASON_LENGTH);
    const under = "x".repeat(MIN_OVERRIDE_REASON_LENGTH - 1);
    expect(overrideApplies({ entryId: "e", reason: atFloor }, "e", "block-overridable").applies).toBe(
      true,
    );
    expect(overrideApplies({ entryId: "e", reason: under }, "e", "block-overridable").applies).toBe(
      false,
    );
  });

  it("caps a stored reason at the maximum length", () => {
    const huge = "y".repeat(MAX_OVERRIDE_REASON_LENGTH + 500);
    const outcome = overrideApplies({ entryId: "e", reason: huge }, "e", "block-overridable");
    expect(outcome.applies).toBe(true);
    expect(outcome.reason).toHaveLength(MAX_OVERRIDE_REASON_LENGTH);
  });

  it("reports nothing to override on a non-blocking level", () => {
    // Not a refusal: nothing was being stopped.
    const outcome = overrideApplies(undefined, "e", "nudge");
    expect(outcome.applies).toBe(false);
    expect(outcome.refusal).toBeUndefined();
  });
});

describe("readOverrideClaim", () => {
  it("reads a well-formed claim", () => {
    expect(readOverrideClaim({ entryId: "e", reason: GOOD_REASON })).toEqual({
      entryId: "e",
      reason: GOOD_REASON,
    });
  });

  it("accepts the snake_case spelling of the entry id", () => {
    expect(readOverrideClaim({ entry_id: "e", reason: GOOD_REASON })?.entryId).toBe("e");
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["an array", [{ entryId: "e", reason: GOOD_REASON }]],
    ["a missing entry id", { reason: GOOD_REASON }],
    ["a missing reason", { entryId: "e" }],
    ["an empty entry id", { entryId: "   ", reason: GOOD_REASON }],
    ["an empty reason", { entryId: "e", reason: "   " }],
    ["a non-string reason", { entryId: "e", reason: 42 }],
  ])("drops %s rather than partially accepting it", (_label, value) => {
    // The direction matters: a malformed override must read as NO
    // override, so the call stays blocked. The opposite bias would let a
    // garbled payload open the gate.
    expect(readOverrideClaim(value)).toBeUndefined();
  });
});

describe("overrideRemedy", () => {
  it("names the entry and the reason floor for an overridable block", () => {
    const remedy = overrideRemedy("broad-process-kill", "block-overridable");
    expect(remedy).toContain("broad-process-kill");
    expect(remedy).toContain(String(MIN_OVERRIDE_REASON_LENGTH));
  });

  it("says the reason is recorded, so nobody reads it as a free pass", () => {
    expect(overrideRemedy("e", "block-overridable")).toContain("recorded");
  });

  it("offers nothing for a hard block", () => {
    // Offering an exit that cannot be taken is the exact broken promise
    // this module exists to end.
    expect(overrideRemedy("e", "hard-block")).toBeNull();
  });

  it("offers nothing for a level that is not blocking at all", () => {
    expect(overrideRemedy("e", "nudge")).toBeNull();
  });
});
