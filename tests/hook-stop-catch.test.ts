// The stop-hook catch — MILESTONES.md #47, DECISIONS.md §6.
//
// Two properties carry this row, and the suite is built around them:
//
//   1. **The condition is an AND, and both halves matter.** "Crew running
//      AND nothing scheduled to wake you" — a catch that fired on the first
//      half alone would nag every orchestrator that had already done the
//      right thing, which §6 rules out explicitly.
//   2. **It never blocks the stop.** A refused stop can trap an agent in a
//      loop, so the exit code is carried through untouched. This is the
//      property most likely to regress silently.

import { describe, expect, it } from "vitest";
import {
  evaluateStopCatch,
  isWakeScheduled,
  readStopContext,
  type StopContext,
} from "@/lib/hook/stop-catch";
import { renderWithStopCatch, renderResponse, HOOK_EXIT } from "@/lib/hook/response";
import { runHook, mergeStopContext } from "@/lib/hook/run";
import type { HookEvent } from "@/lib/hook/payload";
import type { ServerVerdict } from "@/lib/hook/decide";

const stopEvent = (over: Partial<HookEvent> = {}): HookEvent => ({
  eventType: "Stop",
  sessionId: "s-1",
  ...over,
});

const noServer = async (): Promise<ServerVerdict | undefined> => undefined;

/** A `Stop` payload as the agent tool writes it — no tool, no command. */
const stopStdin = JSON.stringify({ hook_event_name: "Stop", session_id: "s-1" });

describe("evaluateStopCatch — the condition from DECISIONS.md §6", () => {
  it("fires when crew are running and nothing is scheduled to wake the session", () => {
    const caught = evaluateStopCatch(stopEvent(), { liveCrew: 2 });
    expect(caught).not.toBeNull();
    expect(caught?.kind).toBe("stop-catch");
    expect(caught?.liveCrew).toBe(2);
    expect(caught?.text).toContain("2 crew members");
    expect(caught?.text).toMatch(/backgrounded wait/i);
  });

  it("uses the singular for one crew member", () => {
    const caught = evaluateStopCatch(stopEvent(), { liveCrew: 1 });
    expect(caught?.text).toContain("1 crew member is");
    expect(caught?.text).not.toContain("members");
  });

  // First half of the AND.
  it("stays silent when no crew are running", () => {
    expect(evaluateStopCatch(stopEvent(), { liveCrew: 0 })).toBeNull();
  });

  it("stays silent when the crew count is not known", () => {
    expect(evaluateStopCatch(stopEvent(), { wakeScheduled: false })).toBeNull();
  });

  // Second half of the AND — the half that stops this being a nag. If the
  // condition were reduced to "crew running", every one of these fires.
  it("stays silent when a wake is already scheduled", () => {
    expect(evaluateStopCatch(stopEvent(), { liveCrew: 3, wakeScheduled: true })).toBeNull();
  });

  it("stays silent when a wait is already backgrounded", () => {
    expect(evaluateStopCatch(stopEvent(), { liveCrew: 3, waitBackgrounded: true })).toBeNull();
  });

  it("fires when both wake flags are explicitly false", () => {
    const caught = evaluateStopCatch(stopEvent(), {
      liveCrew: 1,
      wakeScheduled: false,
      waitBackgrounded: false,
    });
    expect(caught).not.toBeNull();
  });

  it("stays silent once it has already been said on this stop", () => {
    expect(evaluateStopCatch(stopEvent(), { liveCrew: 4, alreadyCaught: true })).toBeNull();
  });

  it("stays silent when nothing is known about the session", () => {
    expect(evaluateStopCatch(stopEvent(), undefined)).toBeNull();
  });

  // Only a Stop is an attempt to end a turn. Evaluating this on a tool call
  // would fire on every call an orchestrator made while its crew ran.
  it.each(["PostToolUse", "PreToolUse"] as const)(
    "stays silent on a %s event, which is not an attempt to stop",
    (eventType) => {
      expect(
        evaluateStopCatch(
          { eventType, sessionId: "s-1", tool: "Bash", command: "ls" },
          { liveCrew: 5 },
        ),
      ).toBeNull();
    },
  );

  it("ignores a negative crew count rather than firing on it", () => {
    expect(evaluateStopCatch(stopEvent(), { liveCrew: -1 })).toBeNull();
  });
});

describe("isWakeScheduled", () => {
  // The two flags are two routes to one fact. Requiring both would produce
  // the exact false positive §6 rules out.
  it.each([
    [{ wakeScheduled: true }, true],
    [{ waitBackgrounded: true }, true],
    [{ wakeScheduled: true, waitBackgrounded: true }, true],
    [{ wakeScheduled: false, waitBackgrounded: false }, false],
    [{}, false],
  ])("reads %o as %s", (context, expected) => {
    expect(isWakeScheduled(context as StopContext)).toBe(expected);
  });
});

describe("readStopContext", () => {
  it("reads a well-formed block", () => {
    expect(
      readStopContext({
        liveCrew: 3,
        wakeScheduled: false,
        waitBackgrounded: false,
        alreadyCaught: false,
      }),
    ).toEqual({
      liveCrew: 3,
      wakeScheduled: false,
      waitBackgrounded: false,
      alreadyCaught: false,
    });
  });

  it.each([undefined, null, "text", 7, []])("returns undefined for %s", (value) => {
    expect(readStopContext(value)).toBeUndefined();
  });

  it("returns undefined when nothing in the object is recognised", () => {
    expect(readStopContext({ unrelated: true })).toBeUndefined();
  });

  // A dropped field makes the catch silent, never spurious.
  it("drops a malformed crew count and keeps the rest", () => {
    expect(readStopContext({ liveCrew: "two", wakeScheduled: true })).toEqual({
      wakeScheduled: true,
    });
  });

  it("rejects a non-integer crew count", () => {
    expect(readStopContext({ liveCrew: 1.5 })).toBeUndefined();
  });

  it("rejects a negative crew count", () => {
    expect(readStopContext({ liveCrew: -2 })).toBeUndefined();
  });
});

describe("the catch never blocks the stop — DECISIONS.md §6", () => {
  const allowed = renderResponse({ decision: "allow", reason: "ok", source: "post-cannot-block" }, "Stop");

  it("leaves the exit code at zero when it fires", () => {
    const rendered = renderWithStopCatch(allowed, {
      kind: "stop-catch",
      text: "crew still running",
      liveCrew: 2,
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.exitCode).toBe(0);
  });

  it("writes the advice to stderr and leaves stdout untouched", () => {
    const rendered = renderWithStopCatch(allowed, {
      kind: "stop-catch",
      text: "crew still running",
      liveCrew: 2,
    });
    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).toBe("[standup:stop-catch] crew still running\n");
  });

  it("returns the response untouched when there is nothing to say", () => {
    expect(renderWithStopCatch(allowed, null)).toBe(allowed);
  });

  it("does not disturb a denial it decorates", () => {
    const denied = renderResponse(
      { decision: "deny", reason: "displaced session", source: "enforcement" },
      "Stop",
    );
    const rendered = renderWithStopCatch(denied, {
      kind: "stop-catch",
      text: "crew still running",
      liveCrew: 1,
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    expect(JSON.parse(rendered.stdout).reason).toBe("displaced session");
    expect(rendered.stderr).toContain("displaced session");
    expect(rendered.stderr).toContain("crew still running");
  });

  it("allows the stop through the whole hook while catching it", async () => {
    const rendered = await runHook({
      stdin: stopStdin,
      askServer: noServer,
      now: 1_000,
      stop: { liveCrew: 2 },
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).toContain("stop-catch");
    expect(rendered.stderr).toContain("2 crew members");
  });

  // A Stop with no cached rules must still be allowed — it carries no
  // command, so there is nothing to be unsure about. If the catch were ever
  // wired into the verdict, this is where it would surface.
  it("allows a stop with no rules cached at all", async () => {
    const rendered = await runHook({
      stdin: stopStdin,
      askServer: noServer,
      now: 1_000,
      stop: { liveCrew: 9 },
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });
});

describe("runHook — wiring", () => {
  it("says nothing on a stop with no live crew", async () => {
    const rendered = await runHook({
      stdin: stopStdin,
      askServer: noServer,
      now: 1_000,
      stop: { liveCrew: 0 },
    });
    expect(rendered.stderr).toBe("");
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("says nothing on a stop when a wait is already backgrounded", async () => {
    const rendered = await runHook({
      stdin: stopStdin,
      askServer: noServer,
      now: 1_000,
      stop: { liveCrew: 4, waitBackgrounded: true },
    });
    expect(rendered.stderr).toBe("");
  });

  it("says nothing when no stop context is supplied", async () => {
    const rendered = await runHook({ stdin: stopStdin, askServer: noServer, now: 1_000 });
    expect(rendered.stderr).toBe("");
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  // A tool call is not an attempt to end a turn — the catch must not appear
  // on one even when crew are running.
  it("does not catch an ordinary tool call while crew are running", async () => {
    const rendered = await runHook({
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
      askServer: noServer,
      now: 1_000,
      stop: { liveCrew: 3 },
    });
    expect(rendered.stderr).toBe("");
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  // A `Stop` still pings the server — the thin client classifies nothing
  // locally, so it has no basis for deciding an event is uninteresting
  // (MILESTONES.md #125). What matters is that the catch does not *depend*
  // on that call: it works from what the caller already knows, which is why
  // the context is a `runHook` parameter at all.
  it("calls the server on a stop, and renders the catch even when the call fails", async () => {
    let called = false;
    const rendered = await runHook({
      stdin: stopStdin,
      askServer: async () => {
        called = true;
        return undefined;
      },
      now: 1_000,
      stop: { liveCrew: 2 },
    });

    expect(called).toBe(true);
    expect(rendered.stderr).toContain("2 crew members");
  });

  // The merge is only observable where a server call actually happens, so
  // it is asserted through `renderWithStopCatch`'s input rather than
  // through a `Stop`. A response that mentions only the wait must not erase
  // a locally-known crew count, and vice versa.
  it("merges a partial server block over the local one without erasing it", () => {
    const local: StopContext = { liveCrew: 2 };
    const volunteered: StopContext = { waitBackgrounded: true };
    const merged: StopContext = { ...local, ...volunteered };

    expect(merged.liveCrew).toBe(2);
    expect(evaluateStopCatch(stopEvent(), merged)).toBeNull();
    expect(evaluateStopCatch(stopEvent(), local)).not.toBeNull();
  });

  // Precedence, asserted with an **overlapping** field. The test above uses
  // disjoint fields, so it passes under either spread order and says nothing
  // about which side wins. Here both sides set `liveCrew`, so the assertion
  // fails if the merge is flipped to `{ ...volunteered, ...local }`.
  //
  // The server wins because it is strictly newer: it answered on this round
  // trip, whereas the local value was read before the call was made.
  it("lets the server's value win when both sides set the same field", () => {
    const merged = mergeStopContext({ liveCrew: 2 }, { liveCrew: 7 });
    expect(merged?.liveCrew).toBe(7);
    expect(evaluateStopCatch(stopEvent(), merged)?.liveCrew).toBe(7);
  });

  it("keeps a local field the server did not mention", () => {
    const merged = mergeStopContext({ liveCrew: 2 }, { waitBackgrounded: false });
    expect(merged?.liveCrew).toBe(2);
    expect(merged?.waitBackgrounded).toBe(false);
  });

  it("returns whichever side is present when the other is absent", () => {
    expect(mergeStopContext(undefined, { liveCrew: 5 })).toEqual({ liveCrew: 5 });
    expect(mergeStopContext({ liveCrew: 3 }, undefined)).toEqual({ liveCrew: 3 });
    expect(mergeStopContext(undefined, undefined)).toBeUndefined();
  });
});
