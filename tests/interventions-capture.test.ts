// Capturing a firing — `src/lib/interventions/capture.ts`.
//
// The owner's first criterion: interventions are captured with enough
// context to be rated later — *"which guard, what it refused, what the agent
// was doing"*. The properties below are the ways a capture stops being
// enough to rate:
//
//   - storing only the entry id, so a rater cannot tell a wrong detection
//     from a right one with a bad message,
//   - recording a block that never happened, because the level said
//     "blocking" and the phase had already clamped it,
//   - truncating a command without marking it, so a reader concludes the
//     guard matched text that was never there,
//   - surveying a silent firing, which asks a session about something it
//     never experienced.
//
// The message is the field the corpus insists on. The firing that most
// deserved a 1 in this installation's history was a *correct* detection
// whose message named a remedy the same guard then refused — and "reword
// it" and "delete it" are opposite fixes that only the stored message can
// distinguish.
import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURED_COMMAND,
  buildCaptures,
  outcomeFor,
  surveyable,
  truncateCommand,
  type CaptureContext,
} from "@/lib/interventions/capture";
import type { InterventionFinding, InterventionLevel } from "@/lib/interventions/types";

function finding(overrides: Partial<InterventionFinding> = {}): InterventionFinding {
  return {
    id: "I10",
    source: "builtin",
    phase: "pre",
    audience: "agent",
    level: "block-overridable",
    timing: "immediate",
    messages: { plain: "plain text", prominent: "PROMINENT" },
    ...overrides,
  };
}

const context: CaptureContext = { sessionId: "s-1", tool: "Bash", command: "git merge main" };

describe("outcomeFor", () => {
  // Kills: collapsing `nothing` into `nudged`. A silent entry is the
  // catalogue's own "observe before it talks" state, and conflating it with
  // a nudge would both misreport it and drag it into the survey.
  it("records a nothing-level finding as silent", () => {
    expect(outcomeFor(finding({ level: "nothing" }), context)).toBe("silent");
  });

  it("records a nudge as nudged", () => {
    expect(outcomeFor(finding({ level: "nudge" }), context)).toBe("nudged");
  });

  // Kills: dropping `blocked` from the outcome set, or treating every
  // blocking level the same as a nudge.
  it("records a refusal as blocked", () => {
    for (const level of ["block-overridable", "hard-block"] satisfies InterventionLevel[]) {
      expect(outcomeFor(finding({ level }), { ...context, blocked: true })).toBe("blocked");
    }
  });

  // **Kills reading the level alone.** A `post` finding is clamped by the
  // phase and refuses nothing, so a capture trusting the level would record
  // a block that never happened — and a rater asked to score "a block" it
  // never hit would answer about a fiction.
  it("does not record a block when the call was not actually refused", () => {
    expect(outcomeFor(finding({ level: "hard-block" }), { ...context, blocked: false })).toBe(
      "nudged",
    );
  });
});

describe("truncateCommand", () => {
  // Kills: `>` → `>=` at the boundary, which would mark an untruncated
  // command as truncated.
  it("leaves a command at the limit alone", () => {
    const exact = "x".repeat(MAX_CAPTURED_COMMAND);
    expect(truncateCommand(exact)).toBe(exact);
  });

  // Kills: dropping the marker. An untruncated-looking command that was in
  // fact cut invites a reader to conclude the guard matched on text that
  // was never there.
  it("marks a command it cut", () => {
    const long = "y".repeat(MAX_CAPTURED_COMMAND + 50);
    const cut = truncateCommand(long);

    expect(cut).toContain("[truncated]");
    expect(cut.startsWith("y".repeat(MAX_CAPTURED_COMMAND))).toBe(true);
    expect(cut.length).toBeLessThan(long.length);
  });
});

describe("buildCaptures", () => {
  // Kills: dropping the message from the capture. This is the field that
  // separates "the detection is wrong, delete it" from "the detection is
  // right, reword it" — opposite fixes that a bare entry id cannot tell
  // apart.
  it("stores what the session was shown, not just which entry fired", () => {
    const [capture] = buildCaptures([finding()], context);

    expect(capture?.entryId).toBe("I10");
    expect(capture?.message).toBe("plain text");
    expect(capture?.tool).toBe("Bash");
    expect(capture?.command).toBe("git merge main");
    expect(capture?.level).toBe("block-overridable");
    expect(capture?.phase).toBe("pre");
  });

  // Kills: storing the command untruncated, which would put multi-kilobyte
  // heredocs on the highest-volume write path in the system.
  it("truncates the command it stores", () => {
    const [capture] = buildCaptures([finding()], {
      ...context,
      command: "z".repeat(MAX_CAPTURED_COMMAND + 100),
    });

    expect(capture?.command).toContain("[truncated]");
  });

  // Kills: capturing only speaking findings. The catalogue's guidance is to
  // run a new entry silently first, and its firing rate is the entire point
  // of doing so.
  it("captures a silent firing too", () => {
    const captures = buildCaptures([finding({ level: "nothing" })], context);

    expect(captures).toHaveLength(1);
    expect(captures[0]?.outcome).toBe("silent");
  });

  // Kills: capturing only the first finding, or sharing one object across
  // them.
  it("captures every finding from one decision", () => {
    const captures = buildCaptures(
      [finding({ id: "I10" }), finding({ id: "I11", level: "nudge" })],
      context,
    );

    expect(captures.map((capture) => capture.entryId)).toEqual(["I10", "I11"]);
    expect(captures.map((capture) => capture.outcome)).toEqual(["blocked", "nudged"]);
  });

  // Kills: materialising absent optional fields as nulls or empty strings —
  // "not known" and "known to be empty" are different facts, and a row that
  // recorded `tool: ""` would report a call that never named a tool as one
  // that named an empty one.
  it("omits what it does not know", () => {
    const [capture] = buildCaptures([finding()], { sessionId: "s-1" });

    expect(capture?.tool).toBeUndefined();
    expect(capture?.command).toBeUndefined();
    expect(capture?.itemId).toBeUndefined();
    expect(capture?.sessionId).toBe("s-1");
  });

  it("is empty for no findings", () => {
    expect(buildCaptures([], context)).toEqual([]);
  });
});

describe("surveyable", () => {
  // **Kills surveying a silent firing.** The session was never told
  // anything, so asking it to rate the intervention asks it to rate
  // something it did not experience — and it *would* answer, because an
  // agent asked a question produces an answer. That answer is noise
  // indistinguishable from data, which is worse than the missing row.
  it("excludes a firing the session never saw", () => {
    const [silent] = buildCaptures([finding({ level: "nothing" })], context);
    expect(surveyable(silent!)).toBe(false);
  });

  it("includes anything the session was actually told", () => {
    const [nudge] = buildCaptures([finding({ level: "nudge" })], context);
    const [block] = buildCaptures([finding()], { ...context, blocked: true });

    expect(surveyable(nudge!)).toBe(true);
    expect(surveyable(block!)).toBe(true);
  });
});

// ── The override outcome — MILESTONES.md #128's "record" half ──────────
//
// `InterventionOutcome.overridden` was declared by the schema, documented
// there as the most diagnostic outcome on its list, and produced by nothing:
// the block tier shipped while the reason reached only a verdict string that
// is printed to stderr and discarded. These pin the value being produced
// *and* the reason travelling with it, because a row saying `overridden`
// with an empty `override_reason` is the same gap wearing the right label.
describe("outcomeFor — overrides", () => {
  // Kills: dropping the `overriddenEntryIds` branch entirely, and also
  // ordering it after the `blocked === false` test — an overridden call is
  // by definition one that was not refused, so a later check files every
  // override as `nudged`.
  it("records an overridden finding as overridden, not blocked or nudged", () => {
    const outcome = outcomeFor(finding({ id: "I10" }), {
      ...context,
      blocked: false,
      overriddenEntryIds: ["I10"],
      overrideReason: "the guard misread a scoped kill as a broad one",
    });

    expect(outcome).toBe("overridden");
  });

  // Kills: matching on "was anything overridden on this call" rather than
  // on *this* entry. `decide` releases a call only when every blocking
  // finding is covered, so an uncovered finding refused the call and is
  // still `blocked` — crediting it with a neighbour's override would record
  // a release that never happened.
  it("leaves a finding blocked when a different entry was the one overridden", () => {
    const outcome = outcomeFor(finding({ id: "I11" }), {
      ...context,
      blocked: true,
      overriddenEntryIds: ["I10"],
      overrideReason: "a reason written about a different guard entirely",
    });

    expect(outcome).toBe("blocked");
  });

  // Kills: treating a non-blocking finding as overridable. There was
  // nothing to override, and `nudged` is the honest outcome.
  it("does not call a nudge overridden", () => {
    const outcome = outcomeFor(finding({ level: "nudge", id: "I10" }), {
      ...context,
      overriddenEntryIds: ["I10"],
      overrideReason: "a reason attached to something that never blocked",
    });

    expect(outcome).toBe("nudged");
  });
});

describe("buildCaptures — the recorded reason", () => {
  const REASON = "the kill is scoped to one pid that this guard misread";

  // The mutation this exists for: recording the firing but dropping the
  // reason. A test asserting only that a row exists, or only that its
  // outcome is `overridden`, stays green through exactly that change — so
  // this asserts the reason's *content*, which is the entire payload of the
  // feature.
  it("carries the caller's reason verbatim onto the overridden row", () => {
    const [capture] = buildCaptures([finding({ id: "I10" })], {
      ...context,
      blocked: false,
      overriddenEntryIds: ["I10"],
      overrideReason: REASON,
    });

    expect(capture?.outcome).toBe("overridden");
    expect(capture?.overrideReason).toBe(REASON);
  });

  // Kills: attaching the reason to every row on the call. A reason excuses
  // the findings it was matched against; crediting it to a finding that
  // still blocked would attribute a justification to a refusal nobody
  // overrode.
  it("attaches the reason only to the rows the override actually excused", () => {
    const captures = buildCaptures([finding({ id: "I10" }), finding({ id: "I11" })], {
      ...context,
      blocked: true,
      overriddenEntryIds: ["I10"],
      overrideReason: REASON,
    });

    const overridden = captures.find((capture) => capture.entryId === "I10");
    const stillBlocked = captures.find((capture) => capture.entryId === "I11");

    expect(overridden?.outcome).toBe("overridden");
    expect(overridden?.overrideReason).toBe(REASON);
    expect(stillBlocked?.outcome).toBe("blocked");
    expect(stillBlocked?.overrideReason).toBeUndefined();
  });

  // Kills: writing an `overrideReason` onto an ordinary blocked row when no
  // override was in play at all. The common path must stay unchanged.
  it("records no reason on a call that carried no override", () => {
    const [capture] = buildCaptures([finding({ id: "I10" })], { ...context, blocked: true });

    expect(capture?.outcome).toBe("blocked");
    expect(capture?.overrideReason).toBeUndefined();
  });
});
