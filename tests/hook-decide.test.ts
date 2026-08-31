// MILESTONES.md #125 — the hook's decision (`src/lib/hook/decide.ts`).
//
// **The posture under test is fail OPEN, and it is a reversal** — see
// DECISIONS.md §16. That makes this suite's shape unusual for a guard: the
// interesting assertions are that failures *allow*, and the ones that would
// catch a regression are the small number of things that still deny.
//
// Three properties are what this file exists to protect, and each is stated
// with the change that would break it:
//
//   1. **Every kind of no-answer allows.** Unreachable, thrown transport,
//      unrecognised decision, no server configured. Reintroducing a
//      `decision: "deny"` in the `answer === undefined` branch fails these.
//   2. **`post` and `Stop` can never be refused.** Deleting the `canBlock`
//      check in `decide` — one line — fails these, and nothing else in the
//      suite would notice, because the server *is* saying block in those
//      cases and being overruled.
//   3. **`block` on `pre` still denies.** Without this the whole module is
//      a function that returns `allow`, and every other test here would
//      still pass. This is the test that stops the fail-open posture from
//      quietly becoming "never blocks at all".
import { describe, expect, it, vi } from "vitest";
import { canBlock, decide, decideWithNudges, type ServerVerdict } from "@/lib/hook/decide";
import type { HookEvent } from "@/lib/hook/payload";
import type { SessionEnforcement } from "@/lib/hook/enforcement";

function event(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    eventType: "PreToolUse",
    sessionId: "s-1",
    tool: "Bash",
    command: "git status",
    ...overrides,
  };
}

/** A server that answers, and records that it was asked. */
function server(answer: ServerVerdict | undefined) {
  return vi.fn(async () => answer);
}

describe("a pre-tool call the server blocks", () => {
  it("denies, carrying the server's reason", async () => {
    const verdict = await decide({
      event: event(),
      askServer: server({ decision: "block", reason: "no approving review at tip" }),
    });

    expect(verdict).toEqual({
      decision: "deny",
      reason: "no approving review at tip",
      source: "server",
    });
  });

  it("denies with a stated reason even when the server supplied none", async () => {
    const verdict = await decide({
      event: event(),
      askServer: server({ decision: "block" }),
    });

    expect(verdict.decision).toBe("deny");
    // Not merely truthy: an empty reason renders a refusal with nothing in
    // it, which an agent cannot act on and will retry into.
    expect(verdict.reason.length).toBeGreaterThan(0);
  });
});

describe("fail open — every way of not getting an answer allows", () => {
  it("allows when the server is unreachable", async () => {
    const verdict = await decide({ event: event(), askServer: server(undefined) });

    expect(verdict.decision).toBe("allow");
    expect(verdict.source).toBe("server-unreachable");
  });

  it("allows when the transport throws", async () => {
    const verdict = await decide({
      event: event(),
      askServer: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    expect(verdict.decision).toBe("allow");
    expect(verdict.source).toBe("server-unreachable");
  });

  it("names the outage in the reason rather than allowing silently", async () => {
    const verdict = await decide({ event: event(), askServer: server(undefined) });

    // An outage that leaves no trace is one nobody finds. The reason is the
    // only trace on the allow path, since stdout stays empty.
    expect(verdict.reason).toContain("could not be reached");
  });

  it("allows a decision value this build does not recognise", async () => {
    // The §16 case most likely to be hit in practice: a newer server adds a
    // fourth decision and an un-updated script sees it. It must not refuse.
    const verdict = await decide({
      event: event(),
      askServer: server({ decision: "escalate" } as unknown as ServerVerdict),
    });

    expect(verdict.decision).toBe("allow");
  });

  it("allows when the answer carries no decision at all", async () => {
    const verdict = await decide({ event: event(), askServer: server({}) });

    expect(verdict.decision).toBe("allow");
    expect(verdict.source).toBe("server");
  });
});

describe("post can never block", () => {
  it("allows a PostToolUse even when the server says block", async () => {
    const askServer = server({ decision: "block", reason: "the server wants this stopped" });
    const verdict = await decide({
      event: event({ eventType: "PostToolUse" }),
      askServer,
    });

    expect(verdict.decision).toBe("allow");
    expect(verdict.source).toBe("post-cannot-block");
    // Still reported — the ping is the point of the phase, so an
    // implementation that skipped the call to save a round trip would be
    // wrong in a way the verdict alone cannot show.
    expect(askServer).toHaveBeenCalledTimes(1);
  });

  it("allows a Stop even when the server says block", async () => {
    const verdict = await decide({
      event: event({ eventType: "Stop", tool: undefined, command: undefined }),
      askServer: server({ decision: "block", reason: "crew still running" }),
    });

    expect(verdict.decision).toBe("allow");
    expect(verdict.source).toBe("post-cannot-block");
  });

  it("allows a PostToolUse whose session the server reports as displaced", async () => {
    // Enforcement is the strongest refusal the hook has, and it still
    // cannot un-run a call that already happened.
    const verdict = await decide({
      event: event({ eventType: "PostToolUse" }),
      askServer: server({
        decision: "block",
        enforcement: { status: "displaced", detail: "taken over" },
      }),
    });

    expect(verdict.decision).toBe("allow");
  });

  it("canBlock is true only for PreToolUse", () => {
    expect(canBlock(event({ eventType: "PreToolUse" }))).toBe(true);
    expect(canBlock(event({ eventType: "PostToolUse" }))).toBe(false);
    expect(canBlock(event({ eventType: "Stop" }))).toBe(false);
  });
});

describe("session enforcement", () => {
  const displaced: SessionEnforcement = {
    status: "displaced",
    detail: "another session took over",
  };

  it("refuses a pre-tool call from a displaced session without asking the server", async () => {
    const askServer = server({ decision: "allow" });
    const verdict = await decide({ event: event(), askServer, enforcement: displaced });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("enforcement");
    // The round trip is skipped: the answer cannot change the outcome, and
    // a displaced session should not be generating load either.
    expect(askServer).not.toHaveBeenCalled();
  });

  it("refuses when the server reports the displacement mid-call", async () => {
    // The local file cannot know about a takeover that happened a second
    // ago, so the response is the first place it can be learned.
    const verdict = await decide({
      event: event(),
      askServer: server({ decision: "allow", enforcement: displaced }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("enforcement");
  });

  it("allows a pre-tool call from an active session", async () => {
    const verdict = await decide({
      event: event(),
      askServer: server({ decision: "allow" }),
      enforcement: { status: "active" },
    });

    expect(verdict.decision).toBe("allow");
  });

  it("does not let a locally-known displacement refuse a post event", async () => {
    const verdict = await decide({
      event: event({ eventType: "PostToolUse" }),
      askServer: server({ decision: "allow" }),
      enforcement: displaced,
    });

    expect(verdict.decision).toBe("allow");
  });
});

describe("nudges never change a verdict", () => {
  it("carries a nudge alongside an allow", async () => {
    const { verdict, nudges } = await decideWithNudges({
      event: event({ tool: "Write" }),
      askServer: server({ decision: "allow", nudge: { budgetBand: "wind-down" } }),
    });

    expect(verdict.decision).toBe("allow");
    expect(nudges.map((n) => n.kind)).toContain("wind-down");
  });

  it("carries a nudge alongside a deny, and the deny is unchanged", async () => {
    const { verdict, nudges } = await decideWithNudges({
      event: event({ tool: "Write" }),
      askServer: server({
        decision: "block",
        reason: "no approval at tip",
        nudge: { budgetBand: "wind-down" },
      }),
    });

    expect(verdict).toEqual({
      decision: "deny",
      reason: "no approval at tip",
      source: "server",
    });
    expect(nudges).toHaveLength(1);
  });

  it("does not turn an allow into a deny however many nudges apply", async () => {
    const { verdict, nudges } = await decideWithNudges({
      event: event({ tool: "Write" }),
      askServer: server({
        decision: "allow",
        nudge: {
          budgetBand: "wind-down",
          escalation: "a reviewer raised something",
          unstagedFiles: 4,
          delegationMode: "allowed",
          isOrchestrator: true,
        },
      }),
    });

    expect(nudges.length).toBeGreaterThan(1);
    expect(verdict.decision).toBe("allow");
  });

  it("prefers the server's nudge context over the local one, field by field", async () => {
    const { nudges } = await decideWithNudges({
      event: event({ tool: "Write" }),
      askServer: server({ decision: "allow", nudge: { budgetBand: "wind-down" } }),
      nudge: { escalation: "known locally", budgetBand: "free" },
    });

    const kinds = nudges.map((n) => n.kind);
    // The server's band won (`wind-down`, not `free`)…
    expect(kinds).toContain("wind-down");
    // …without erasing the locally-known escalation it said nothing about.
    expect(kinds).toContain("escalation");
  });
});

describe("findings ride the verdict untouched — MILESTONES.md #128", () => {
  const FINDING = {
    id: "I10",
    source: "builtin" as const,
    phase: "pre" as const,
    audience: "agent" as const,
    level: "block-overridable" as const,
    timing: "immediate" as const,
    messages: { plain: "no approval at tip", prominent: "NO APPROVAL AT TIP" },
  };

  it("carries the findings the server answered with, alongside a deny", async () => {
    const { verdict, findings } = await decideWithNudges({
      event: event(),
      askServer: server({ decision: "block", reason: "no approval at tip", findings: [FINDING] }),
    });

    expect(verdict.decision).toBe("deny");
    expect(findings).toEqual([FINDING]);
  });

  it("carries the findings the server answered with, alongside an allow", async () => {
    // A nudge-level finding allows the call but is still worth recording —
    // `capture.ts`'s own contract is that every triggered finding is
    // captured, including ones that never blocked anything.
    const nudgeFinding = { ...FINDING, level: "nudge" as const };
    const { verdict, findings } = await decideWithNudges({
      event: event(),
      askServer: server({ decision: "allow", findings: [nudgeFinding] }),
    });

    expect(verdict.decision).toBe("allow");
    expect(findings).toEqual([nudgeFinding]);
  });

  it("is an empty array, never undefined, when the server sent none", async () => {
    // `DecidedEvent.findings` is declared non-optional so a caller can
    // iterate it unconditionally; `answer.findings` being absent must not
    // leak an `undefined` through this function's own return.
    const { findings } = await decideWithNudges({
      event: event(),
      askServer: server({ decision: "allow" }),
    });

    expect(findings).toEqual([]);
  });

  it("is an empty array when there was no answer at all", async () => {
    const { findings } = await decideWithNudges({
      event: event(),
      askServer: server(undefined),
    });

    expect(findings).toEqual([]);
  });

  it("cannot influence the verdict — a block-level finding on a post event still allows", async () => {
    // The clamp lives in `decide`, keyed on the event's phase alone; a
    // regression that let `findings` feed back into the verdict would make
    // this the one test in the suite to notice, because every other
    // post/Stop assertion here uses a server answer with no findings at
    // all.
    const { verdict, findings } = await decideWithNudges({
      event: event({ eventType: "PostToolUse" }),
      askServer: server({ decision: "block", findings: [FINDING] }),
    });

    expect(verdict.decision).toBe("allow");
    expect(findings).toEqual([FINDING]);
  });
});

describe("what the hook sends", () => {
  it("asks the server exactly once per event", async () => {
    const askServer = server({ decision: "allow" });
    await decide({ event: event(), askServer });

    // A retry loop on the critical path of every tool call turns one
    // unreachable server into a stall on all of them.
    expect(askServer).toHaveBeenCalledTimes(1);
  });

  it("asks even for an event carrying no command", async () => {
    // The hook classifies nothing, so it has no basis for deciding an event
    // is uninteresting. Skipping the ping here would silently withhold every
    // non-Bash tool call from the server.
    const askServer = server({ decision: "allow" });
    await decide({ event: event({ tool: "Read", command: undefined }), askServer });

    expect(askServer).toHaveBeenCalledTimes(1);
  });
});

// ── The override channel — MILESTONES.md #128's middle tier ─────────────
//
// Before this existed, `block-overridable` and `hard-block` denied
// identically: nothing carried an override, so the middle tier of the
// ladder was a name with no behaviour behind it. These tests are written in
// pairs — what an override releases, and what it must not — because a
// channel that simply allowed everything would pass any suite that only
// checked the happy path.

/** A blocking finding at the given level, shaped as the server reports it. */
function finding(id: string, level: "block-overridable" | "hard-block") {
  return {
    id,
    source: "builtin" as const,
    phase: "pre" as const,
    audience: "agent" as const,
    level,
    timing: "immediate" as const,
    messages: { plain: "p", prominent: "P" },
  };
}

const REASON = "Nothing changed since review except the changelog wording.";

describe("overriding a block-overridable refusal", () => {
  it("allows the call when the override names the blocking finding", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "broad-process-kill", reason: REASON } }),
      askServer: server({
        decision: "block",
        reason: "broad process kill",
        findings: [finding("broad-process-kill", "block-overridable")],
      }),
    });

    expect(verdict.decision).toBe("allow");
    expect(verdict.source).toBe("override");
    // The recorded reason is the whole product of this tier.
    expect(verdict.reason).toContain(REASON);
  });

  it("still denies when the override names a different finding", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "something-else", reason: REASON } }),
      askServer: server({
        decision: "block",
        reason: "broad process kill",
        findings: [finding("broad-process-kill", "block-overridable")],
      }),
    });

    expect(verdict.decision).toBe("deny");
  });

  it("still denies when the reason is too short to say anything", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "broad-process-kill", reason: "ok" } }),
      askServer: server({
        decision: "block",
        reason: "broad process kill",
        findings: [finding("broad-process-kill", "block-overridable")],
      }),
    });

    expect(verdict.decision).toBe("deny");
  });

  it("NEVER releases a hard block, however well-formed the override", async () => {
    // The one property that must not regress. A hard block is the only
    // thing separating "overridable with a reason" from "always passable".
    const verdict = await decide({
      event: event({ override: { entryId: "some-hard-rule", reason: REASON } }),
      askServer: server({
        decision: "block",
        reason: "a hard rule",
        findings: [finding("some-hard-rule", "hard-block")],
      }),
    });

    expect(verdict.decision).toBe("deny");
  });

  it("does not release a call whose other blocking finding was not overridden", async () => {
    // Two guards refused; the caller answered one. "I considered X" is not
    // "I considered everything", so the call stays blocked.
    const verdict = await decide({
      event: event({ override: { entryId: "first-rule", reason: REASON } }),
      askServer: server({
        decision: "block",
        reason: "two rules",
        findings: [
          finding("first-rule", "block-overridable"),
          finding("second-rule", "block-overridable"),
        ],
      }),
    });

    expect(verdict.decision).toBe("deny");
  });

  it("does not release a refusal that reported no findings at all", async () => {
    // An enforcement refusal, or a server that named no entry. There is
    // nothing for an override to be about, so it cannot apply.
    const verdict = await decide({
      event: event({ override: { entryId: "anything", reason: REASON } }),
      askServer: server({ decision: "block", reason: "displaced session" }),
    });

    expect(verdict.decision).toBe("deny");
  });

  it("tells a blocked caller that an override exists and what it costs", async () => {
    const verdict = await decide({
      event: event(),
      askServer: server({
        decision: "block",
        reason: "broad process kill",
        findings: [finding("broad-process-kill", "block-overridable")],
      }),
    });

    expect(verdict.decision).toBe("deny");
    // A refusal that hides an available exit is what teaches sessions to
    // route around guards instead of answering them.
    expect(verdict.reason).toContain("broad-process-kill");
    expect(verdict.reason).toContain("recorded");
  });

  it("offers no override in the refusal text for a hard block", async () => {
    const verdict = await decide({
      event: event(),
      askServer: server({
        decision: "block",
        reason: "a hard rule",
        findings: [finding("some-hard-rule", "hard-block")],
      }),
    });

    expect(verdict.reason).not.toContain("can be overridden");
  });
});

// ── The structured override, for the record half ────────────────────────
//
// `verdict.reason` is prose printed to stderr and then discarded, which was
// the whole of the record when this tier first shipped — so the design's
// claim that the value is the *recorded* reason was false. `verdict.override`
// is the machine-readable half the capture loop writes to the database.
//
// Every refusal case below asserts the field is **absent**, not merely that
// the call was denied. That is the property that keeps the failure direction
// safe: a refused override that still emitted an `override` would let the
// capture loop record a release that never happened.
describe("the override a verdict carries for the record", () => {
  // Kills: emitting the verdict without the structured field, i.e. the
  // original gap. Asserts the reason's content rather than its presence —
  // dropping the reason while still setting `entryIds` is the plausible
  // mistake here, and it would look green against a truthiness check.
  it("carries the entry it released and the reason, verbatim", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "broad-process-kill", reason: REASON } }),
      askServer: server({
        decision: "block",
        reason: "broad process kill",
        findings: [finding("broad-process-kill", "block-overridable")],
      }),
    });

    expect(verdict.override?.entryIds).toEqual(["broad-process-kill"]);
    expect(verdict.override?.reason).toBe(REASON);
  });

  // The reason recorded is the *validated* one — trimmed by
  // `overrideApplies` — not the raw claim off the payload. Kills: recording
  // `event.override.reason` directly, which would store text subtly
  // different from the text the length check was performed against.
  it("records the trimmed reason rather than the raw claim", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "broad-process-kill", reason: `   ${REASON}   ` } }),
      askServer: server({
        decision: "block",
        reason: "broad process kill",
        findings: [finding("broad-process-kill", "block-overridable")],
      }),
    });

    expect(verdict.override?.reason).toBe(REASON);
  });

  // The constraint the brief calls unbreakable, restated as a recording
  // property. A hard block must not merely be denied — it must leave no
  // trace suggesting it was ever released.
  it("records nothing at all for a hard block, however well-formed", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "some-hard-rule", reason: REASON } }),
      askServer: server({
        decision: "block",
        reason: "a hard rule",
        findings: [finding("some-hard-rule", "hard-block")],
      }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.override).toBeUndefined();
  });

  // Kills: recording an override that named the wrong entry. The call was
  // refused, so nothing was excused and nothing may be written.
  it("records nothing when the override named a different finding", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "something-else", reason: REASON } }),
      askServer: server({
        decision: "block",
        reason: "broad process kill",
        findings: [finding("broad-process-kill", "block-overridable")],
      }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.override).toBeUndefined();
  });

  // Kills: recording an override whose reason failed the length floor. A
  // refused override is not a quieter override; it is no override.
  it("records nothing when the reason was too short to count", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "broad-process-kill", reason: "ok" } }),
      askServer: server({
        decision: "block",
        reason: "broad process kill",
        findings: [finding("broad-process-kill", "block-overridable")],
      }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.override).toBeUndefined();
  });

  // A call refused by two guards where the override covers one is not
  // released — and must record neither. Kills: emitting the partial
  // coverage as an override of the finding it did match.
  it("records nothing when only one of two blocking findings was covered", async () => {
    const verdict = await decide({
      event: event({ override: { entryId: "first-rule", reason: REASON } }),
      askServer: server({
        decision: "block",
        reason: "two guards",
        findings: [
          finding("first-rule", "block-overridable"),
          finding("second-rule", "block-overridable"),
        ],
      }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.override).toBeUndefined();
  });

  // An ordinary allow is not an override. Kills: defaulting the field to a
  // present-but-empty value, which would make every allowed call look like
  // an excused one to anything reading the column.
  it("records nothing on a call nothing objected to", async () => {
    const verdict = await decide({
      event: event(),
      askServer: server({ decision: "allow" }),
    });

    expect(verdict.decision).toBe("allow");
    expect(verdict.override).toBeUndefined();
  });
});
