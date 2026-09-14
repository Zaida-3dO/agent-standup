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
    const outcome = overrideApplies({ entryId: "e", reason: GOOD_REASON }, "e", "hard-block");
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
    expect(
      overrideApplies({ entryId: "e", reason: atFloor }, "e", "block-overridable").applies,
    ).toBe(true);
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
  // **This block was rewritten when the offer came back, narrowed.** It
  // used to assert the removal was TOTAL, which was the right spec while
  // the function returned `null` unconditionally. The offer is now made to
  // exactly one audience — a caller that composes its own hook payload —
  // and withheld from the one that provably cannot act on it. So the
  // assertions below pin the *boundary* rather than the absence: the
  // silence for an agent is asserted just as strongly as it was before,
  // because that silence is the regression that mattered.

  it("offers nothing to an agent, because the audience cannot take it", () => {
    // The original regression, and still the important one: every
    // `block-overridable` entry in the catalogue is `audience: "agent"`,
    // and an agent reaches only `tool_input`, where an override claim is
    // refused by design. Deleting the audience check in `overrideRemedy`
    // fails here.
    expect(overrideRemedy("broad-process-kill", "block-overridable", "agent")).toBeNull();
  });

  it("offers nothing when the audience is unknown", () => {
    // `undefined` is treated as unreachable rather than reachable. An
    // unknown reader is far likelier to be an agent than a bespoke client,
    // and guessing wrong in that direction reintroduces the broken
    // promise. Changing the check to `audience !== "agent"` fails here.
    expect(overrideRemedy("broad-process-kill", "block-overridable")).toBeNull();
  });

  it("offers nothing for a hard block, whatever the audience", () => {
    // Offering an exit that cannot be taken is the exact broken promise
    // this module exists to end — and a hard block is not overridable by
    // anyone, so no audience earns the sentence.
    expect(overrideRemedy("e", "hard-block", "orchestrator")).toBeNull();
    expect(overrideRemedy("e", "hard-block", "agent")).toBeNull();
  });

  it("offers nothing for a level that is not blocking at all", () => {
    for (const level of ["nothing", "nudge"] as const) {
      expect(overrideRemedy("e", level, "orchestrator")).toBeNull();
      expect(overrideRemedy("e", level, "agent")).toBeNull();
    }
  });

  it("gives an orchestrator the literal syntax, not an allusion to it", () => {
    // The point of restoring it: four sessions bounced off a message that
    // advertised an override without saying how to supply one, and one
    // spent seven attempts inventing syntaxes that could not work. So the
    // remedy must name the real field, the real keys, and the top-level
    // placement that is the part everyone got wrong.
    const remedy = overrideRemedy("broad-process-kill", "block-overridable", "orchestrator");
    expect(remedy).not.toBeNull();
    expect(remedy).toContain("standup_override");
    expect(remedy).toContain("entryId");
    expect(remedy).toContain("reason");
    // The entry it is scoped to, because an override names its finding.
    expect(remedy).toContain("broad-process-kill");
    // Top level, not `tool_input` — the distinction the probe established
    // and the one a reader cannot guess.
    expect(remedy).toMatch(/top level/i);
    expect(remedy).toContain("tool_input");
    // The reason floor, so a caller does not discover it by being refused.
    expect(remedy).toContain(String(MIN_OVERRIDE_REASON_LENGTH));
  });

  it("names the entry it was asked about, rather than a fixed example", () => {
    // A remedy that hardcoded one id would be wrong for every other entry
    // and would send the caller to override the wrong finding.
    const remedy = overrideRemedy(
      "merge-without-approval-at-tip",
      "block-overridable",
      "orchestrator",
    );
    expect(remedy).toContain("merge-without-approval-at-tip");
    expect(remedy).not.toContain("broad-process-kill");
  });

  it("offers a syntax that readOverrideClaim actually accepts", () => {
    // **The property that makes this safe to print.** A remedy describing
    // a shape the parser rejects is the original bug wearing new clothes,
    // so the documented shape is round-tripped through the real reader
    // rather than eyeballed. Renaming a key in `readOverrideClaim` without
    // updating the sentence fails here.
    const claim = readOverrideClaim({
      entryId: "broad-process-kill",
      reason: "the kill is scoped to one pid this guard misread as broad",
    });
    expect(claim).toEqual({
      entryId: "broad-process-kill",
      reason: "the kill is scoped to one pid this guard misread as broad",
    });
    expect(overrideApplies(claim, "broad-process-kill", "block-overridable").applies).toBe(true);
  });

  it("still validates a real override claim, so the mechanism is intact", () => {
    // The promise was removed; the CHANNEL was not. A caller composing its
    // own stdin (the test harness, a non-Claude-Code client) still gets a
    // working override, and the reason floor still bites. If this fails,
    // the cleanup went too far and deleted a capability.
    const entryId = "broad-process-kill";
    const good = "x".repeat(MIN_OVERRIDE_REASON_LENGTH);
    const short = "x".repeat(MIN_OVERRIDE_REASON_LENGTH - 1);
    expect(overrideApplies({ entryId, reason: good }, entryId, "block-overridable").applies).toBe(
      true,
    );
    expect(overrideApplies({ entryId, reason: short }, entryId, "block-overridable").applies).toBe(
      false,
    );
  });
});
