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
  readCommandOverrideClaim,
  readOverrideClaim,
  toolCarriesOverride,
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
  // ── This block has been rewritten three times. Keep the history ───────
  //
  // 1. It asserted the offer was made to everyone. That was wrong: every
  //    `block-overridable` entry is `audience: "agent"`, and an agent could
  //    only influence `tool_input`, where a claim was refused by design.
  // 2. It asserted the removal was TOTAL, which was right for exactly as
  //    long as no agent could send a claim.
  // 3. It now asserts a boundary, because an agent CAN send one — as a
  //    marked shell comment on its own command. Blanket silence became the
  //    new lie: withholding a syntax that works.
  //
  // The rule that survived all three, and the thing to preserve if this is
  // ever touched again: **the offer is made exactly when the caller can
  // act on it.** The gate that implements it keys on the TOOL rather than
  // on the audience, because that is the question that actually decides it:
  // can THIS call carry a claim? An agent on a tool with no command to
  // comment on is told nothing, which is asserted just below and is the
  // half most likely to be deleted by someone tidying up.

  it("offers an agent nothing on a tool whose call cannot carry a claim", () => {
    // The regression that mattered, restated against the real boundary.
    // `checkout-held-by-another-crew` fires only on `Write`/`Edit`/
    // `NotebookEdit`, whose every input field is a path or file content —
    // a marker there would have to be written into the user's file to be
    // sent. Offering the comment syntax to that reader would be the broken
    // promise all over again. Deleting the `toolCarriesOverride` gate in
    // `overrideRemedy` fails here.
    for (const tool of ["Edit", "Write", "NotebookEdit"]) {
      expect(
        overrideRemedy("checkout-held-by-another-crew", "block-overridable", "agent", tool),
      ).toBeNull();
    }
  });

  it("offers nothing when the tool is unknown", () => {
    // `undefined` is treated as unable rather than able, the same
    // direction the audience check used to take and for the same reason:
    // guessing wrong here reintroduces a promise the reader cannot keep.
    // Changing the gate to a negative test on a known-bad list fails here.
    expect(overrideRemedy("broad-process-kill", "block-overridable", "agent")).toBeNull();
    expect(overrideRemedy("broad-process-kill", "block-overridable")).toBeNull();
  });

  it("gives an agent on a Bash call the literal comment syntax", () => {
    // The whole point of the change: 448 blocks and 7 overrides, none of
    // the seven by an agent, because the only channel that existed was one
    // an agent could not reach. This is the sentence that ends that.
    const remedy = overrideRemedy("broad-process-kill", "block-overridable", "agent", "Bash");
    expect(remedy).not.toBeNull();
    // The literal marker and the entry it is scoped to, printed rather
    // than alluded to — the standard the orchestrator branch already sets.
    expect(remedy).toContain("# standup-override(broad-process-kill):");
    expect(remedy).toContain(String(MIN_OVERRIDE_REASON_LENGTH));
    // Ope's framing, which is the reason the block is worth keeping at
    // all: it is a prompt to stop and think, not a wall.
    expect(remedy).toMatch(/stop and think/i);
    // Where to complain about the guard itself, so an agent that thinks
    // the ENTRY is wrong has somewhere to go other than the override.
    expect(remedy).toContain("feedback/");
  });

  it("prints an agent syntax that readCommandOverrideClaim actually accepts", () => {
    // The round-trip that makes it safe to print, mirroring the
    // orchestrator branch's own. A remedy advertising a form the parser
    // rejects is precisely the defect this module's history is about, so
    // the printed sentence is fed back through the real reader rather than
    // eyeballed. Changing the marker, the parentheses or the colon in
    // either place without the other fails here.
    const entryId = "broad-process-kill";
    const remedy = overrideRemedy(entryId, "block-overridable", "agent", "Bash");
    const reason = "this kill names one pid and the guard misread it as broad";
    // Reconstruct the command a caller would send by following the
    // instruction literally: the printed line, with the placeholder
    // replaced by a real reason.
    const printed = /# standup-override\([^)]+\): <[^>]+>/.exec(remedy ?? "");
    expect(printed).not.toBeNull();
    const command = `kill 123\n${printed![0].replace(/<[^>]+>/, reason)}`;

    const claim = readCommandOverrideClaim("Bash", command);
    expect(claim).toEqual({ entryId, reason });
    expect(overrideApplies(claim, entryId, "block-overridable").applies).toBe(true);
  });

  it("offers nothing for a hard block, whatever the audience or tool", () => {
    // Offering an exit that cannot be taken is the exact broken promise
    // this module exists to end — and a hard block is not overridable by
    // anyone, so no audience and no tool earns the sentence. The `Bash`
    // case is the one that matters now: the agent channel must not have
    // opened a door into the level that is meant to have none.
    expect(overrideRemedy("e", "hard-block", "orchestrator")).toBeNull();
    expect(overrideRemedy("e", "hard-block", "agent")).toBeNull();
    expect(overrideRemedy("e", "hard-block", "agent", "Bash")).toBeNull();
  });

  it("offers nothing for a level that is not blocking at all", () => {
    for (const level of ["nothing", "nudge"] as const) {
      expect(overrideRemedy("e", level, "orchestrator")).toBeNull();
      expect(overrideRemedy("e", level, "agent")).toBeNull();
      expect(overrideRemedy("e", level, "agent", "Bash")).toBeNull();
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

// ── The agent's own channel: a marked comment on its own command ────────
//
// The half that makes `block-overridable` mean its name for the audience
// that actually meets it. Every assertion here comes in the pair this
// file's header describes: for each "this is a claim", a "and this looks
// like one and is not", because a reader that accepted anything resembling
// the marker would turn ordinary content into a silent waiver.
describe("readCommandOverrideClaim", () => {
  const ENTRY = "broad-process-kill";
  const REASON = "this kill names one pid and the guard misread it as broad";

  it("reads a claim written as a trailing comment", () => {
    expect(
      readCommandOverrideClaim("Bash", `kill 123\n# standup-override(${ENTRY}): ${REASON}`),
    ).toEqual({ entryId: ENTRY, reason: REASON });
  });

  it("tolerates the spacing a real caller actually types", () => {
    // Indentation from a multi-line command, and spaces around the marker.
    // A parser this strict about whitespace would refuse correct claims and
    // send the caller hunting for an invisible difference.
    expect(
      readCommandOverrideClaim("Bash", `kill 123\n   #  standup-override(${ENTRY}) :  ${REASON}`),
    ).toEqual({ entryId: ENTRY, reason: REASON });
  });

  // ── The negative cases — acceptance criterion 3 ──────────────────────

  it("does not read a claim out of a command that merely mentions the marker", () => {
    // The case that decides whether this is safe to ship at all: searching
    // for the string must not waive the guard being searched for. The
    // mention is not on the final line, and is not a comment.
    expect(
      readCommandOverrideClaim("Bash", `grep -rn "standup-override(${ENTRY}): x" src/`),
    ).toBeUndefined();
  });

  it("does not read a claim out of content being written to a file", () => {
    // A heredoc writing this very documentation — the marker appears, in
    // full and well-formed, as DATA. It is not the last line of the
    // command, so it is not a claim. Anchoring the pattern to the end is
    // what makes this hold; removing the `$` fails here.
    const command = [
      "cat > docs/override.md <<'EOF'",
      `# standup-override(${ENTRY}): ${REASON}`,
      "EOF",
    ].join("\n");
    expect(readCommandOverrideClaim("Bash", command)).toBeUndefined();
  });

  it("does not read a claim from a marker sharing a line with the command", () => {
    // **A deliberate narrowing, and the one place this parser is stricter
    // than a shell.** `echo x # standup-override(...): ...` IS a valid
    // trailing comment to `sh`, and it is refused here anyway.
    //
    // The reason is the negative case above. A mid-line `#` is only a
    // comment when it is unquoted, and this reader sees text rather than a
    // parsed command — it cannot tell `echo x # ...` from
    // `echo "x # standup-override(e): ..."`, where the marker is an
    // argument the caller is printing, not a claim. Requiring its own line
    // removes that whole class of ambiguity for the cost of one newline,
    // and the refusal text prints the form that works.
    expect(
      readCommandOverrideClaim("Bash", `echo x # standup-override(${ENTRY}): ${REASON}`),
    ).toBeUndefined();
  });

  it("refuses a claim on a tool whose call cannot carry one", () => {
    // The fourth entry's tools. Even a perfectly-formed marker is not a
    // claim here — it would be file content. This is the gate that keeps
    // `checkout-held-by-another-crew` honest rather than half-supported.
    const command = `# standup-override(${ENTRY}): ${REASON}`;
    for (const tool of ["Edit", "Write", "NotebookEdit", undefined]) {
      expect(readCommandOverrideClaim(tool, command)).toBeUndefined();
    }
  });

  it("refuses a marker with no entry id", () => {
    // A blanket claim is the thing `OverrideClaim.entryId` exists to stop:
    // one written reason must not excuse a guard the caller never read.
    expect(readCommandOverrideClaim("Bash", `kill 123\n# standup-override: ${REASON}`)).toBe(
      undefined,
    );
    expect(readCommandOverrideClaim("Bash", `kill 123\n# standup-override(): ${REASON}`)).toBe(
      undefined,
    );
  });

  it("refuses a marker with no reason at all", () => {
    expect(readCommandOverrideClaim("Bash", `kill 123\n# standup-override(${ENTRY}):`)).toBe(
      undefined,
    );
  });

  it("leaves a too-short reason to overrideApplies rather than dropping it", () => {
    // The distinction that decides what the caller is TOLD. A dropped claim
    // reads as "you sent no override"; a parsed-but-short one is refused by
    // name as `reason-too-short`. Two different next actions.
    const short = "too short";
    const claim = readCommandOverrideClaim(
      "Bash",
      `kill 123\n# standup-override(${ENTRY}): ${short}`,
    );
    expect(claim).toEqual({ entryId: ENTRY, reason: short });
    expect(overrideApplies(claim, ENTRY, "block-overridable").refusal).toBe("reason-too-short");
  });

  it("scopes the claim to the entry it names", () => {
    // An override written for one guard does not excuse another that fired
    // on the same call — the property `overrideApplies` enforces, asserted
    // here through the new reader so the two cannot drift apart.
    const claim = readCommandOverrideClaim(
      "Bash",
      `kill 123\n# standup-override(${ENTRY}): ${REASON}`,
    );
    expect(overrideApplies(claim, ENTRY, "block-overridable").applies).toBe(true);
    expect(overrideApplies(claim, "some-other-entry", "block-overridable").refusal).toBe(
      "wrong-entry",
    );
  });

  it("cannot open a hard block", () => {
    // The one thing the module must never do, asserted against the NEW
    // channel specifically. A well-formed comment claim on a hard block is
    // still refused, for the same structural reason a top-level one is.
    const claim = readCommandOverrideClaim(
      "Bash",
      `kill 123\n# standup-override(${ENTRY}): ${REASON}`,
    );
    expect(overrideApplies(claim, ENTRY, "hard-block").applies).toBe(false);
    expect(overrideApplies(claim, ENTRY, "hard-block").refusal).toBe("level-not-overridable");
  });
});

describe("toolCarriesOverride", () => {
  it("is true for Bash and false for the checkout-write tools", () => {
    expect(toolCarriesOverride("Bash")).toBe(true);
    // These three are `CHECKOUT_WRITE_TOOLS` in the interventions context —
    // the tools `checkout-held-by-another-crew` fires on. If this ever
    // returns true for them, an agent is being told to write a marker into
    // a file it is editing, which is the failure this gate prevents.
    expect(toolCarriesOverride("Edit")).toBe(false);
    expect(toolCarriesOverride("Write")).toBe(false);
    expect(toolCarriesOverride("NotebookEdit")).toBe(false);
    expect(toolCarriesOverride(undefined)).toBe(false);
  });
});
