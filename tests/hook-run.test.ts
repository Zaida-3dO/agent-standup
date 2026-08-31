// MILESTONES.md #125 — the hook end to end (`src/lib/hook/run.ts`).
//
// The composition, driven the way the process drives it: a string of stdin
// in, a rendered response out. What this file adds over the unit tests
// beneath it is the behaviours that only exist once the pieces are joined —
// what an unreadable payload actually renders, and that the advisory
// decorators cannot reach the exit code.
//
// **The assertions here are about what a tool reads**, which is a stricter
// claim than what `decide` returned: an allow is *silent* (empty stdout,
// exit zero), and a change that started printing a JSON object on every
// allowed call would pass every test in `hook-decide.test.ts` and put a line
// of noise into a session after every Read the agent performs.
import { describe, expect, it, vi } from "vitest";
import { runHook, captureContextFor, type FindingsReport } from "@/lib/hook/run";
import type { AskServer } from "@/lib/hook/decide";
import { HOOK_EXIT } from "@/lib/hook/response";

const NOW = 1_700_000_000_000;

function stdin(command: string, eventType = "PreToolUse"): string {
  return JSON.stringify({
    hook_event_name: eventType,
    session_id: "s-1",
    tool_name: "Bash",
    tool_input: { command },
  });
}

const allowing = async () => ({ decision: "allow" as const });
const blocking = async () => ({ decision: "block" as const, reason: "no approval at tip" });
const silent = async () => undefined;

describe("runHook on the ordinary paths", () => {
  it("renders an allow as silence and exit zero", async () => {
    const rendered = await runHook({ stdin: stdin("git status"), askServer: allowing, now: NOW });

    // Exactly this, not merely "exit zero": a hook that printed on every
    // allowed call would be unusable.
    expect(rendered).toEqual({ stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW });
  });

  it("renders a block on both channels, with the reason on each", async () => {
    const rendered = await runHook({ stdin: stdin("git merge"), askServer: blocking, now: NOW });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    // Both, always. Emitting only the JSON would let a tool that does not
    // parse it run the command; emitting only the exit code loses the reason.
    const parsed = JSON.parse(rendered.stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("no approval at tip");
    expect(rendered.stderr).toContain("no approval at tip");
  });

  it("allows a Stop with no tool and no command", async () => {
    const rendered = await runHook({
      stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "s-1" }),
      askServer: allowing,
      now: NOW,
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("allows a PostToolUse the server tried to block, silently", async () => {
    // The invariant, seen from the outside: whatever the server said, the
    // process exits zero and prints nothing that would refuse the call.
    const rendered = await runHook({
      stdin: stdin("git merge", "PostToolUse"),
      askServer: blocking,
      now: NOW,
    });

    expect(rendered).toEqual({ stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW });
  });
});

describe("an unreadable payload allows — DECISIONS.md §16", () => {
  it("allows empty stdin", async () => {
    // The realistic shape of a wiring mistake. It used to deny; with no
    // rules left to enforce, denying here would refuse every call in the
    // session for a guard that would have allowed all of them.
    const rendered = await runHook({ stdin: "", askServer: silent, now: NOW });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stdout).toBe("");
  });

  it("allows a payload from an event type this build does not know", async () => {
    const rendered = await runHook({
      stdin: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s-1" }),
      askServer: silent,
      now: NOW,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("allows malformed JSON", async () => {
    const rendered = await runHook({ stdin: "{{", askServer: silent, now: NOW });
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("allows a payload with no session identifier", async () => {
    const rendered = await runHook({
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
      askServer: silent,
      now: NOW,
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("does not ask the server about an event it could not read", async () => {
    // There is nothing to send: the payload has no session, no event type
    // and no command, so a request would carry nothing the server could
    // attribute or act on.
    const askServer = vi.fn(async () => undefined);
    await runHook({ stdin: "{{", askServer, now: NOW });
    expect(askServer).not.toHaveBeenCalled();
  });
});

describe("an unreachable server allows", () => {
  it("allows a command when the server cannot be reached", async () => {
    const rendered = await runHook({ stdin: stdin("rm -rf /"), askServer: silent, now: NOW });

    // Deliberately the most alarming command available. With the pattern
    // lists gone the hook was never going to refuse it, and refusing it only
    // when the server happens to be down would be the worst of both.
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stdout).toBe("");
  });

  it("allows when the transport throws", async () => {
    const rendered = await runHook({
      stdin: stdin("ls"),
      askServer: async () => {
        throw new Error("ECONNREFUSED");
      },
      now: NOW,
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });
});

describe("enforcement reaches the rendered response", () => {
  it("denies a displaced session's pre-tool call, naming the detail", async () => {
    const rendered = await runHook({
      stdin: stdin("git status"),
      askServer: allowing,
      now: NOW,
      enforcement: { status: "displaced", detail: "taken over by session s-9" },
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    const parsed = JSON.parse(rendered.stdout);
    expect(parsed.source).toBe("enforcement");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("s-9");
  });

  it("does not refuse the same session's post-tool call", async () => {
    const rendered = await runHook({
      stdin: stdin("git status", "PostToolUse"),
      askServer: allowing,
      now: NOW,
      enforcement: { status: "displaced", detail: "taken over by session s-9" },
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });
});

describe("advisory output never touches the exit code", () => {
  it("exits zero for an allowed call carrying a nudge", async () => {
    const rendered = await runHook({
      stdin: stdin("git commit", "PostToolUse"),
      askServer: async () => ({ decision: "allow" as const, nudge: { budgetBand: "wind-down" } }),
      now: NOW,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stderr).toContain("wind-down");
    // stdout stays empty even with advisory text: it is parsed as JSON by
    // the tools that read it, and prose there is a parse failure.
    expect(rendered.stdout).toBe("");
  });

  it("keeps the deny exit code for a blocked call carrying a nudge", async () => {
    const rendered = await runHook({
      stdin: stdin("git merge"),
      askServer: async () => ({
        decision: "block" as const,
        reason: "no approval at tip",
        nudge: { budgetBand: "wind-down" },
      }),
      now: NOW,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    expect(rendered.stderr).toContain("no approval at tip");
    expect(rendered.stderr).toContain("wind-down");
  });

  it("exits zero for a stop carrying the crew catch", async () => {
    const rendered = await runHook({
      stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "s-1" }),
      askServer: silent,
      now: NOW,
      stop: { liveCrew: 2 },
    });

    // §6: "Nudge, not block — a refused stop can trap an agent in a loop."
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stderr).toContain("2 crew members");
  });
});

describe("what reaches the server", () => {
  it("sends the parsed event, once, for an ordinary call", async () => {
    const askServer = vi.fn<AskServer>(async () => ({ decision: "allow" as const }));
    await runHook({ stdin: stdin("git status"), askServer, now: NOW });

    expect(askServer).toHaveBeenCalledTimes(1);
    expect(askServer).toHaveBeenCalledWith({
      eventType: "PreToolUse",
      sessionId: "s-1",
      tool: "Bash",
      command: "git status",
    });
  });

  it("sends a truncated tool result from a PostToolUse", async () => {
    const askServer = vi.fn<AskServer>(async () => ({ decision: "allow" as const }));
    await runHook({
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: "x".repeat(10_000),
      }),
      askServer,
      now: NOW,
    });

    const sent = askServer.mock.calls[0]?.[0] as { toolResult?: string };
    // Bounded rather than merely present: an unbounded result on the
    // critical path of every call makes the hook the slowest thing in the
    // session.
    expect(sent.toolResult).toHaveLength(4000);
  });
});

describe("onFindings — MILESTONES.md #128's capture loop", () => {
  const FINDING = {
    id: "I10",
    source: "builtin" as const,
    phase: "pre" as const,
    audience: "agent" as const,
    level: "block-overridable" as const,
    timing: "immediate" as const,
    messages: { plain: "no approval at tip", prominent: "NO APPROVAL AT TIP" },
  };

  it("is not called when the answer carried no findings", async () => {
    const onFindings = vi.fn<(report: FindingsReport) => Promise<void>>(async () => {});
    await runHook({ stdin: stdin("git status"), askServer: allowing, now: NOW, onFindings });

    expect(onFindings).not.toHaveBeenCalled();
  });

  it("is called once with the findings, the event and blocked: true on a deny", async () => {
    const onFindings = vi.fn<(report: FindingsReport) => Promise<void>>(async () => {});
    const askServer: AskServer = async () => ({
      decision: "block",
      reason: "no approval at tip",
      findings: [FINDING],
    });

    await runHook({ stdin: stdin("git merge"), askServer, now: NOW, onFindings });

    expect(onFindings).toHaveBeenCalledTimes(1);
    expect(onFindings).toHaveBeenCalledWith({
      event: { eventType: "PreToolUse", sessionId: "s-1", tool: "Bash", command: "git merge" },
      findings: [FINDING],
      blocked: true,
    });
  });

  it("reports blocked: false when the finding fired but the call was allowed", async () => {
    // A nudge-level finding, or a blocking finding on a phase that cannot
    // block: `outcomeFor` in capture.ts must be told the call was not
    // actually refused, or it would record a block that never happened.
    const onFindings = vi.fn<(report: FindingsReport) => Promise<void>>(async () => {});
    const askServer: AskServer = async () => ({ decision: "allow", findings: [FINDING] });

    await runHook({ stdin: stdin("git merge"), askServer, now: NOW, onFindings });

    expect(onFindings.mock.calls[0]?.[0]).toMatchObject({ blocked: false });
  });

  it("reports blocked: false for a blocking-level finding on a post event", async () => {
    // The phase clamp: `decide` cannot deny a `post` event no matter what
    // the server says, so a finding riding a `post` answer must never be
    // captured as blocked — that would assert a refusal `verdict.decision`
    // itself denies happened.
    const onFindings = vi.fn<(report: FindingsReport) => Promise<void>>(async () => {});
    const askServer: AskServer = async () => ({ decision: "block", findings: [FINDING] });

    await runHook({
      stdin: stdin("git merge", "PostToolUse"),
      askServer,
      now: NOW,
      onFindings,
    });

    expect(onFindings.mock.calls[0]?.[0]).toMatchObject({ blocked: false });
  });

  it("is awaited before runHook resolves", async () => {
    // If this were fired without awaiting, a process that exits right after
    // `runHook` returns (as `standup-hook.ts` does) would routinely kill the
    // capture write before it left the process. Asserted by making the
    // callback's completion observable only after a microtask queue flush,
    // and checking runHook did not resolve before it ran.
    let finished = false;
    const onFindings = vi.fn(async () => {
      await Promise.resolve();
      await Promise.resolve();
      finished = true;
    });
    const askServer: AskServer = async () => ({ decision: "allow", findings: [FINDING] });

    await runHook({ stdin: stdin("git merge"), askServer, now: NOW, onFindings });

    expect(finished).toBe(true);
  });

  it("does not let onFindings change the rendered response", async () => {
    const askServer: AskServer = async () => ({
      decision: "block",
      reason: "no approval at tip",
      findings: [FINDING],
    });

    const rendered = await runHook({
      stdin: stdin("git merge"),
      askServer,
      now: NOW,
      onFindings: async () => {
        throw new Error("a broken capture write must not reach the caller");
      },
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
  });
});

// ── The override, end to end through runHook ────────────────────────────
//
// `decide` produces the structured override and `capture.ts` writes it, but
// the seam between them is this callback — and the seam is where the record
// half was missing. These build the payload the way a caller actually
// sends it (a `standup_override` field on the raw stdin JSON) so that a
// break anywhere in payload parsing, the decision, or the report is caught
// here rather than only in the unit tests either side of it.
describe("onFindings — the override the caller wrote", () => {
  const OVERRIDABLE = {
    id: "broad-process-kill",
    source: "builtin" as const,
    phase: "pre" as const,
    audience: "agent" as const,
    level: "block-overridable" as const,
    timing: "immediate" as const,
    messages: { plain: "broad process kill", prominent: "BROAD PROCESS KILL" },
  };
  const HARD = { ...OVERRIDABLE, id: "some-hard-rule", level: "hard-block" as const };
  const REASON = "the kill is scoped to one pid this guard misread as broad";

  /** Stdin carrying an override claim, as a caller sends one. */
  function stdinWithOverride(override: unknown): string {
    return JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "s-1",
      tool_name: "Bash",
      tool_input: { command: "kill 123" },
      standup_override: override,
    });
  }

  // The whole point of the feature: the reason survives the decision and
  // reaches the callback that writes it. Asserts the reason's *content* —
  // recording the firing while dropping the reason is the mistake this is
  // built to catch, and it passes any check for mere presence.
  it("hands the reason to the capture loop when the override is honoured", async () => {
    const onFindings = vi.fn<(report: FindingsReport) => Promise<void>>(async () => {});
    const askServer: AskServer = async () => ({
      decision: "block",
      reason: "broad process kill",
      findings: [OVERRIDABLE],
    });

    const rendered = await runHook({
      stdin: stdinWithOverride({ entryId: "broad-process-kill", reason: REASON }),
      askServer,
      now: NOW,
      onFindings,
    });

    // Released, and recorded as released.
    expect(rendered.exitCode).toBe(0);
    expect(onFindings.mock.calls[0]?.[0]).toMatchObject({
      blocked: false,
      override: { entryIds: ["broad-process-kill"], reason: REASON },
    });
  });

  // The constraint that must never regress, asserted on the recording side.
  // A hard block stays refused *and* leaves no override on the report, so
  // nothing downstream can write an `overridden` row for it.
  it("reports no override for a hard block, however well-formed the claim", async () => {
    const onFindings = vi.fn<(report: FindingsReport) => Promise<void>>(async () => {});
    const askServer: AskServer = async () => ({
      decision: "block",
      reason: "a hard rule",
      findings: [HARD],
    });

    const rendered = await runHook({
      stdin: stdinWithOverride({ entryId: "some-hard-rule", reason: REASON }),
      askServer,
      now: NOW,
      onFindings,
    });

    expect(rendered.exitCode).toBe(2);
    const report = onFindings.mock.calls[0]?.[0];
    expect(report?.blocked).toBe(true);
    expect(report?.override).toBeUndefined();
  });

  // The failure direction. A malformed claim reads as *no* override, so the
  // call stays blocked — never as a weaker override that releases it.
  // `exitCode` is asserted, not just the report: the danger of a parse
  // failure is a release, and this pins that the release did not happen.
  it("keeps the call blocked when the override is malformed", async () => {
    const onFindings = vi.fn<(report: FindingsReport) => Promise<void>>(async () => {});
    const askServer: AskServer = async () => ({
      decision: "block",
      reason: "broad process kill",
      findings: [OVERRIDABLE],
    });

    // A reason of the wrong type — the shape `readOverrideClaim` drops.
    const rendered = await runHook({
      stdin: stdinWithOverride({ entryId: "broad-process-kill", reason: { nested: REASON } }),
      askServer,
      now: NOW,
      onFindings,
    });

    expect(rendered.exitCode).toBe(2);
    const report = onFindings.mock.calls[0]?.[0];
    expect(report?.blocked).toBe(true);
    expect(report?.override).toBeUndefined();
  });
});

// ── The capture context, and why it is a function rather than a literal ──
//
// This mapping decides which facts about a call reach the database, so it is
// kept somewhere a test can call it. Inlined into `src/bin/standup-hook.ts`
// it would be untestable by construction: that file is a script which runs
// on import, so nothing can import it to assert on, and deleting the
// `overrideReason` line from such a literal passes an entire suite. That is
// the exact failure this feature guards against — record the firing, lose
// the reason — hiding in the one layer no test can reach.
describe("captureContextFor", () => {
  const REASON = "the kill is scoped to one pid this guard misread as broad";

  function report(overrides: Partial<FindingsReport> = {}): FindingsReport {
    return {
      event: {
        eventType: "PreToolUse",
        sessionId: "s-1",
        tool: "Bash",
        command: "kill 123",
      },
      findings: [],
      blocked: false,
      ...overrides,
    };
  }

  // Kills: dropping `overrideReason` from the projection — the mutant that
  // survived the entire suite before this function existed. Asserts the
  // reason's content, since passing the entry ids while losing the reason
  // is the plausible half-wiring.
  it("carries both the overridden entries and the reason", () => {
    const context = captureContextFor(
      report({ override: { entryIds: ["broad-process-kill"], reason: REASON } }),
    );

    expect(context.overriddenEntryIds).toEqual(["broad-process-kill"]);
    expect(context.overrideReason).toBe(REASON);
  });

  // Kills: emitting the override keys unconditionally. `buildCaptures` reads
  // `overriddenEntryIds` to decide the outcome, so a present-but-empty value
  // is not equivalent to an absent one.
  it("carries no override fields for a call that had none", () => {
    const context = captureContextFor(report({ blocked: true }));

    expect(context.overriddenEntryIds).toBeUndefined();
    expect(context.overrideReason).toBeUndefined();
    expect(context.blocked).toBe(true);
  });

  // The ordinary fields still have to survive the extraction.
  it("carries the session, tool and command the call named", () => {
    const context = captureContextFor(report());

    expect(context.sessionId).toBe("s-1");
    expect(context.tool).toBe("Bash");
    expect(context.command).toBe("kill 123");
  });
});
