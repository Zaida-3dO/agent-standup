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
