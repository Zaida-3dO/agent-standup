// Nudges — MILESTONES.md #46.
//
// The suite is organised around one property above all others: **a nudge is
// advisory and never blocks.** That is the defining behaviour of the whole
// row, and it is the one most likely to regress silently — a nudge that
// began denying would look, from the agent's side, exactly like a rule
// nobody had told it about. So it is asserted at every layer it could break:
// the evaluator's shape, the composition in `decideWithNudges`, the rendered
// exit code, and the full `runHook` path.

import { describe, expect, it } from "vitest";
import {
  evaluateNudges,
  isWriteShaped,
  readNudgeContext,
  NUDGE_KINDS,
  type NudgeContext,
} from "@/lib/hook/nudge";
import { decideWithNudges, type ServerVerdict } from "@/lib/hook/decide";
import { renderWithNudges, HOOK_EXIT } from "@/lib/hook/response";
import { runHook } from "@/lib/hook/run";
import type { HookEvent } from "@/lib/hook/payload";

const event = (over: Partial<HookEvent> = {}): HookEvent => ({
  eventType: "PostToolUse",
  sessionId: "s-1",
  tool: "Bash",
  command: "ls",
  ...over,
});

const noServer = async (): Promise<ServerVerdict | undefined> => undefined;
const allowing = async (): Promise<ServerVerdict> => ({ decision: "allow" });

describe("evaluateNudges — the four kinds", () => {
  it("nudges an orchestrator doing write-shaped work itself under `allowed`", () => {
    const nudges = evaluateNudges({
      delegationMode: "allowed",
      isOrchestrator: true,
      writeShaped: true,
    });
    expect(nudges.map((n) => n.kind)).toEqual(["delegate"]);
    expect(nudges[0]?.text).toMatch(/dispatch/i);
  });

  // The three negatives below are the point of the delegate nudge: it must
  // stay quiet for a non-orchestrator, for a read, and — the subtle one —
  // for the two modes that are enforced elsewhere.
  it("stays silent for a non-orchestrator", () => {
    expect(
      evaluateNudges({ delegationMode: "allowed", isOrchestrator: false, writeShaped: true }),
    ).toEqual([]);
  });

  it("stays silent on a read-shaped call", () => {
    expect(
      evaluateNudges({ delegationMode: "allowed", isOrchestrator: true, writeShaped: false }),
    ).toEqual([]);
  });

  it.each(["never", "required"] as const)(
    "stays silent under delegation mode %s, which is enforced elsewhere",
    (delegationMode) => {
      expect(evaluateNudges({ delegationMode, isOrchestrator: true, writeShaped: true })).toEqual(
        [],
      );
    },
  );

  it("nudges to stage uncommitted work, naming the count", () => {
    const nudges = evaluateNudges({ writeShaped: true, unstagedFiles: 3 });
    expect(nudges.map((n) => n.kind)).toEqual(["staging"]);
    expect(nudges[0]?.text).toContain("3 files");
  });

  it("uses the singular for one file", () => {
    const [nudge] = evaluateNudges({ writeShaped: true, unstagedFiles: 1 });
    expect(nudge?.text).toContain("1 file of");
    expect(nudge?.text).not.toContain("files");
  });

  it("does not nudge to stage when nothing is uncommitted", () => {
    expect(evaluateNudges({ writeShaped: true, unstagedFiles: 0 })).toEqual([]);
  });

  it("does not nudge to stage on a read-shaped call", () => {
    expect(evaluateNudges({ writeShaped: false, unstagedFiles: 9 })).toEqual([]);
  });

  it("passes an escalation through verbatim, because the server composed it", () => {
    const escalation = "Item T-4 has been blocked on a person for two days.";
    const nudges = evaluateNudges({ escalation });
    expect(nudges).toEqual([{ kind: "escalation", text: escalation }]);
  });

  it("treats empty escalation text as no escalation", () => {
    expect(evaluateNudges({ escalation: "" })).toEqual([]);
  });

  it("nudges in the wind-down band", () => {
    const nudges = evaluateNudges({ budgetBand: "wind-down" });
    expect(nudges.map((n) => n.kind)).toEqual(["wind-down"]);
    expect(nudges[0]?.text).toMatch(/stopping point/i);
  });

  // `stop` is an enforcement, not advice; `free`/`selective` have nothing to
  // say. If wind-down's condition were widened to any band, this fails.
  it.each(["free", "selective", "stop"] as const)("stays silent in the %s band", (budgetBand) => {
    expect(evaluateNudges({ budgetBand })).toEqual([]);
  });

  it("returns nothing for an empty context, which is the common case", () => {
    expect(evaluateNudges({})).toEqual([]);
  });

  it("emits several kinds at once, in a fixed order", () => {
    const nudges = evaluateNudges({
      delegationMode: "allowed",
      isOrchestrator: true,
      writeShaped: true,
      unstagedFiles: 2,
      escalation: "someone is waiting",
      budgetBand: "wind-down",
    });
    expect(nudges.map((n) => n.kind)).toEqual(["delegate", "staging", "escalation", "wind-down"]);
  });
});

describe("evaluateNudges — edge suppression", () => {
  // "silent if a wait is already backgrounded, or you'd nag every turn"
  // (DECISIONS.md §6). Without the filter, every one of these repeats.
  it("suppresses a kind already delivered to this session", () => {
    const context: NudgeContext = { budgetBand: "wind-down", alreadyNudged: ["wind-down"] };
    expect(evaluateNudges(context)).toEqual([]);
  });

  it("suppresses only the kinds already delivered, not the rest", () => {
    const nudges = evaluateNudges({
      budgetBand: "wind-down",
      escalation: "still blocked",
      alreadyNudged: ["wind-down"],
    });
    expect(nudges.map((n) => n.kind)).toEqual(["escalation"]);
  });

  it("delivers every kind when none has been delivered before", () => {
    const nudges = evaluateNudges({
      budgetBand: "wind-down",
      escalation: "still blocked",
      alreadyNudged: [],
    });
    expect(nudges.map((n) => n.kind)).toEqual(["escalation", "wind-down"]);
  });
});

describe("isWriteShaped", () => {
  it.each(["Write", "Edit", "NotebookEdit", "Bash"])("treats %s as write-shaped", (tool) => {
    expect(isWriteShaped(tool)).toBe(true);
  });

  // "nudging on a read trains people to ignore nudges" (DECISIONS.md §7).
  it.each(["Read", "Grep", "Glob", "WebFetch"])("treats %s as read-shaped", (tool) => {
    expect(isWriteShaped(tool)).toBe(false);
  });

  it("treats an unknown tool as read-shaped, to avoid crying wolf", () => {
    expect(isWriteShaped("SomeToolThisBuildHasNeverSeen")).toBe(false);
  });

  it("treats an absent tool as read-shaped", () => {
    expect(isWriteShaped(undefined)).toBe(false);
  });
});

describe("readNudgeContext", () => {
  it("reads a well-formed block", () => {
    expect(
      readNudgeContext({
        delegationMode: "allowed",
        isOrchestrator: true,
        unstagedFiles: 4,
        escalation: "a person is waiting",
        budgetBand: "wind-down",
        alreadyNudged: ["staging"],
      }),
    ).toEqual({
      delegationMode: "allowed",
      isOrchestrator: true,
      unstagedFiles: 4,
      escalation: "a person is waiting",
      budgetBand: "wind-down",
      alreadyNudged: ["staging"],
    });
  });

  it.each([undefined, null, "text", 7, []])("returns undefined for %s", (value) => {
    expect(readNudgeContext(value)).toBeUndefined();
  });

  it("returns undefined when nothing in the object is recognised", () => {
    expect(readNudgeContext({ somethingElse: true })).toBeUndefined();
  });

  // A malformed field is dropped rather than failing the whole read — the
  // escalation beside it should still be delivered.
  it("drops a malformed field and keeps the rest", () => {
    expect(
      readNudgeContext({
        unstagedFiles: "three",
        budgetBand: "not-a-band",
        delegationMode: "sometimes",
        escalation: "still delivered",
      }),
    ).toEqual({ escalation: "still delivered" });
  });

  it("drops unrecognised entries from alreadyNudged", () => {
    expect(readNudgeContext({ alreadyNudged: ["staging", "not-a-kind", 5] })).toEqual({
      alreadyNudged: ["staging"],
    });
  });

  it("rejects a non-integer file count", () => {
    expect(readNudgeContext({ unstagedFiles: 2.5 })).toBeUndefined();
  });

  // An array is an object in JavaScript, so without an explicit guard it
  // falls through and gets read for the recognised keys. A plain array of
  // objects has none, so it returns `undefined` either way and proves
  // nothing — the discriminating case is an array carrying a recognised key
  // as a property, which the guard rejects and the fall-through accepts.
  it("rejects an array outright rather than reading properties off it", () => {
    const arrayWithField = Object.assign([], { budgetBand: "wind-down" });
    expect(readNudgeContext(arrayWithField)).toBeUndefined();
    expect(readNudgeContext([{ budgetBand: "wind-down" }])).toBeUndefined();
  });

  // No rule reads a claim flag, so parsing one would invite a server author
  // to populate it and expect an effect. It is not part of the shape.
  it("ignores a claim flag, which no rule consumes", () => {
    expect(readNudgeContext({ hasClaim: true })).toBeUndefined();
    expect(readNudgeContext({ hasClaim: true, budgetBand: "wind-down" })).toEqual({
      budgetBand: "wind-down",
    });
  });
});

describe("a nudge never blocks — the defining property of #46", () => {
  // Each test below breaks if a nudge is ever allowed to influence a
  // verdict or an exit code. Together they cover every layer where that
  // coupling could be introduced.

  it("renders an allowed call with a nudge as exit code zero", () => {
    const rendered = renderWithNudges(
      { decision: "allow", reason: "ok", source: "server" },
      "PostToolUse",
      [{ kind: "wind-down", text: "wind down please" }],
    );
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.exitCode).toBe(0);
  });

  it("keeps stdout empty on an allowed call, so a JSON reader still parses nothing", () => {
    const rendered = renderWithNudges(
      { decision: "allow", reason: "ok", source: "server" },
      "PostToolUse",
      [{ kind: "staging", text: "commit something" }],
    );
    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).toContain("commit something");
  });

  it("does not change a denial's exit code or reason when nudges ride along", () => {
    const denied = renderWithNudges(
      { decision: "deny", reason: "blocked by the server", source: "server" },
      "PostToolUse",
      [{ kind: "escalation", text: "someone is waiting" }],
    );
    expect(denied.exitCode).toBe(HOOK_EXIT.DENY);
    expect(JSON.parse(denied.stdout).reason).toBe("blocked by the server");
    expect(denied.stderr).toContain("blocked by the server");
    expect(denied.stderr).toContain("someone is waiting");
  });

  it("renders identically to the plain renderer when there are no nudges", () => {
    const verdict = { decision: "allow", reason: "ok", source: "server" } as const;
    expect(renderWithNudges(verdict, "PostToolUse", [])).toEqual({
      stdout: "",
      stderr: "",
      exitCode: HOOK_EXIT.ALLOW,
    });
  });

  it("labels each nudge with its kind so a reader can tell them apart", () => {
    const rendered = renderWithNudges(
      { decision: "allow", reason: "ok", source: "server" },
      "PostToolUse",
      [
        { kind: "delegate", text: "delegate this" },
        { kind: "wind-down", text: "wind down" },
      ],
    );
    expect(rendered.stderr).toBe(
      "[standup:delegate] delegate this\n[standup:wind-down] wind down\n",
    );
  });

  it("allows a command through the whole hook while nudging it", async () => {
    const rendered = await runHook({
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        tool_name: "Edit",
        tool_input: { command: "edit a file" },
      }),
      askServer: allowing,
      now: 1_000,
      nudge: { budgetBand: "wind-down" },
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).toContain("wind-down");
  });

  it("does not let a nudge context turn an allowed command into a denial", async () => {
    const withoutNudge = await decideWithNudges({
      event: event(),
      askServer: noServer,
    });
    const withNudge = await decideWithNudges({
      event: event(),
      askServer: noServer,
      nudge: {
        budgetBand: "wind-down",
        escalation: "a person is waiting",
        unstagedFiles: 12,
        delegationMode: "allowed",
        isOrchestrator: true,
      },
    });

    expect(withNudge.verdict).toEqual(withoutNudge.verdict);
    expect(withNudge.verdict.decision).toBe("allow");
    expect(withNudge.nudges.length).toBeGreaterThan(0);
  });

  it("does not let a nudge context turn a blocked command into an allow", async () => {
    const { verdict, nudges } = await decideWithNudges({
      event: event({ eventType: "PreToolUse", command: "git merge" }),
      askServer: async () => ({ decision: "block" as const, reason: "no approval at tip" }),
      nudge: { budgetBand: "wind-down" },
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("server");
    expect(nudges.map((n) => n.kind)).toEqual(["wind-down"]);
  });

  // A session that has just been refused still needs to hear that it should
  // be pausing rather than retrying — so nudges are computed for a deny too.
  it("still nudges an enforcement-denied session", async () => {
    const { verdict, nudges } = await decideWithNudges({
      event: event({ eventType: "PreToolUse" }),
      askServer: noServer,
      enforcement: { status: "displaced" },
      nudge: { budgetBand: "wind-down" },
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("enforcement");
    expect(nudges.map((n) => n.kind)).toEqual(["wind-down"]);
  });

  // The mirror of the case above, on the phase that cannot refuse. Without
  // it, an implementation that suppressed nudges whenever it allowed would
  // pass every other test here.
  it("still nudges a displaced session on a post event, which it cannot refuse", async () => {
    const { verdict, nudges } = await decideWithNudges({
      event: event({ eventType: "PostToolUse" }),
      askServer: noServer,
      enforcement: { status: "displaced" },
      nudge: { budgetBand: "wind-down" },
    });

    expect(verdict.decision).toBe("allow");
    expect(nudges.map((n) => n.kind)).toEqual(["wind-down"]);
  });
});

describe("decideWithNudges — composition", () => {
  it("derives write-shapedness from the event's tool when the context is silent", async () => {
    const { nudges } = await decideWithNudges({
      event: event({ tool: "Edit" }),
      askServer: noServer,
      nudge: { unstagedFiles: 2 },
    });
    expect(nudges.map((n) => n.kind)).toEqual(["staging"]);
  });

  it("stays silent when the event's tool is read-shaped", async () => {
    const { nudges } = await decideWithNudges({
      event: event({ tool: "Read" }),
      askServer: noServer,
      nudge: { unstagedFiles: 2 },
    });
    expect(nudges).toEqual([]);
  });

  it("lets an explicit writeShaped in the context override the tool name", async () => {
    const { nudges } = await decideWithNudges({
      event: event({ tool: "Read" }),
      askServer: noServer,
      nudge: { unstagedFiles: 2, writeShaped: true },
    });
    expect(nudges.map((n) => n.kind)).toEqual(["staging"]);
  });

  it("takes nudge context the server volunteered on the ask round trip", async () => {
    const { verdict, nudges } = await decideWithNudges({
      event: event({ command: "deploy" }),
      askServer: async () => ({
        decision: "allow",
        nudge: { budgetBand: "wind-down" },
      }),
    });

    expect(verdict.decision).toBe("allow");
    expect(nudges.map((n) => n.kind)).toEqual(["wind-down"]);
  });

  // Field-by-field merge: a response mentioning only the band must not
  // erase a locally-known escalation.
  it("merges the server's context over the local one without erasing it", async () => {
    const { nudges } = await decideWithNudges({
      event: event({ command: "deploy" }),
      askServer: async () => ({ decision: "allow", nudge: { budgetBand: "wind-down" } }),
      nudge: { escalation: "kept from local context" },
    });

    expect(nudges.map((n) => n.kind)).toEqual(["escalation", "wind-down"]);
    expect(nudges[0]?.text).toBe("kept from local context");
  });

  // Precedence, asserted with an **overlapping** field. The test above uses
  // disjoint fields, so it passes under either spread order and says nothing
  // about which side wins. Here both sides set `escalation`, so this fails
  // if the merge is flipped to `{ ...volunteered, ...options.nudge }`.
  //
  // The server wins because it is strictly newer: it answered on this round
  // trip, whereas the local value was read before the call went out.
  it("lets the server's value win when both sides set the same field", async () => {
    const { nudges } = await decideWithNudges({
      event: event({ command: "deploy" }),
      askServer: async () => ({
        decision: "allow",
        nudge: { escalation: "the newer escalation from the server" },
      }),
      nudge: { escalation: "the stale local escalation" },
    });

    expect(nudges.map((n) => n.kind)).toEqual(["escalation"]);
    expect(nudges[0]?.text).toBe("the newer escalation from the server");
  });

  it("returns no nudges when nothing is known, which is the common path", async () => {
    const { verdict, nudges } = await decideWithNudges({
      event: event(),
      askServer: noServer,
    });
    expect(verdict.decision).toBe("allow");
    expect(nudges).toEqual([]);
  });
});

// Both advisory decorators land on one event. Nothing else exercises the
// composition, and the two arrived in separate changes — so the properties
// that make them safe together are asserted here rather than inferred from
// each holding alone.
describe("nudges and the stop-hook catch on one event", () => {
  const bothStdin = JSON.stringify({ hook_event_name: "Stop", session_id: "s-1" });

  it("emits both, still exits zero, and keeps stdout empty", async () => {
    const rendered = await runHook({
      stdin: bothStdin,
      askServer: noServer,
      now: 1_000,
      nudge: { budgetBand: "wind-down" },
      stop: { liveCrew: 2 },
    });

    // Neither decorator can block, so two of them cannot either.
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).toContain("[standup:wind-down]");
    expect(rendered.stderr).toContain("[standup:stop-catch]");
  });

  // Order is a reading decision, not a correctness one — but it is a
  // decision, so it is pinned. The catch is the most actionable line on a
  // `Stop`, so it lands last. Flipping the two decorators fails this.
  it("puts the stop-catch last, where it is read last", async () => {
    const rendered = await runHook({
      stdin: bothStdin,
      askServer: noServer,
      now: 1_000,
      nudge: { budgetBand: "wind-down" },
      stop: { liveCrew: 2 },
    });

    expect(rendered.stderr.indexOf("[standup:wind-down]")).toBeLessThan(
      rendered.stderr.indexOf("[standup:stop-catch]"),
    );
  });

  it("emits only the catch when there is no nudge to give", async () => {
    const rendered = await runHook({
      stdin: bothStdin,
      askServer: noServer,
      now: 1_000,
      stop: { liveCrew: 1 },
    });

    expect(rendered.stderr).toContain("[standup:stop-catch]");
    expect(rendered.stderr).not.toContain("[standup:wind-down]");
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("emits only the nudge when the catch has nothing to say", async () => {
    const rendered = await runHook({
      stdin: bothStdin,
      askServer: noServer,
      now: 1_000,
      nudge: { budgetBand: "wind-down" },
      stop: { liveCrew: 0 },
    });

    expect(rendered.stderr).toContain("[standup:wind-down]");
    expect(rendered.stderr).not.toContain("[standup:stop-catch]");
  });

  it("stays completely silent when neither has anything to say", async () => {
    const rendered = await runHook({
      stdin: bothStdin,
      askServer: noServer,
      now: 1_000,
      stop: { liveCrew: 0 },
    });

    expect(rendered.stderr).toBe("");
    expect(rendered.stdout).toBe("");
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });
});

describe("the nudge kinds are a closed set", () => {
  it("names exactly the four kinds MILESTONES.md #46 lists", () => {
    expect([...NUDGE_KINDS]).toEqual(["delegate", "staging", "escalation", "wind-down"]);
  });
});
