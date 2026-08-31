// Delivery of the session-end intervention survey — `evaluateStopSurvey`
// in `src/lib/hook/stop-catch.ts`, and `renderWithStopSurvey` in
// `src/lib/hook/response.ts`.
//
// The survey logic itself (when to ask, what to ask, how to read a reply)
// was already built and tested in `interventions-survey.test.ts`. What was
// missing was any caller at all: nothing in `src/` referenced it, so the
// owner's scale was a library that had never been put to a session. These
// tests are about the delivery — that it fires at a genuine wind-down, that
// it stays silent everywhere else, and above all that it can never gate
// anything.

import { describe, expect, it } from "vitest";
import { evaluateStopSurvey } from "@/lib/hook/stop-catch";
import { renderWithStopSurvey, HOOK_EXIT } from "@/lib/hook/response";
import type { HookEvent } from "@/lib/hook/payload";
import type { WindDownContext } from "@/lib/interventions/survey";
import { WIND_DOWN_QUIET_MS } from "@/lib/interventions/survey";

function stopEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return { eventType: "Stop", sessionId: "s-1", ...overrides };
}

/** A context that satisfies every wind-down condition. */
function windingDown(overrides: Partial<WindDownContext> = {}): WindDownContext {
  return {
    unrated: [{ eventId: "e-1", entryId: "I10", at: 1_000 }],
    liveCrew: 0,
    wakeScheduled: false,
    idleMs: WIND_DOWN_QUIET_MS + 1,
    ...overrides,
  };
}

describe("when the survey is asked", () => {
  it("asks at a genuine wind-down", () => {
    const survey = evaluateStopSurvey(stopEvent(), windingDown());
    expect(survey).not.toBeNull();
    expect(survey?.asked).toBe(1);
  });

  it("renders the owner's scale, not a paraphrase of it", () => {
    // The wording is load-bearing: the owner's 4 and 3 are separated by
    // whether the agent would have got there anyway, and a tidied
    // "very useful / useful / neutral" scale would score differently while
    // still producing numbers between 1 and 5.
    const survey = evaluateStopSurvey(stopEvent(), windingDown());
    expect(survey?.text).toContain("wrong path");
    expect(survey?.text).toContain("Please remove");
  });

  it("says nothing on a session where no intervention fired", () => {
    // The brief's case: an empty survey is pure cost.
    expect(evaluateStopSurvey(stopEvent(), windingDown({ unrated: [] }))).toBeNull();
  });

  it("says nothing when crew are still running", () => {
    expect(evaluateStopSurvey(stopEvent(), windingDown({ liveCrew: 2 }))).toBeNull();
  });

  it("says nothing when a wake is already scheduled", () => {
    expect(evaluateStopSurvey(stopEvent(), windingDown({ wakeScheduled: true }))).toBeNull();
  });

  it("says nothing when the session has not been quiet long enough", () => {
    expect(evaluateStopSurvey(stopEvent(), windingDown({ idleMs: 0 }))).toBeNull();
  });

  it("says nothing when the session was already surveyed", () => {
    expect(evaluateStopSurvey(stopEvent(), windingDown({ alreadySurveyed: true }))).toBeNull();
  });

  it("says nothing when idle time is unknown", () => {
    const { idleMs: _dropped, ...withoutIdle } = windingDown();
    expect(evaluateStopSurvey(stopEvent(), withoutIdle)).toBeNull();
  });

  it("says nothing with no context at all", () => {
    expect(evaluateStopSurvey(stopEvent(), undefined)).toBeNull();
  });

  it("never asks on a tool call, however complete the context", () => {
    // Surveying on PostToolUse would interrupt mid-task to ask about a
    // nudge from four minutes ago.
    expect(evaluateStopSurvey(stopEvent({ eventType: "PostToolUse" }), windingDown())).toBeNull();
    expect(evaluateStopSurvey(stopEvent({ eventType: "PreToolUse" }), windingDown())).toBeNull();
  });
});

describe("the survey can never gate anything", () => {
  it("carries an allow through as an allow", () => {
    // DECISIONS.md §6 — a refused stop can trap an agent in a loop.
    const allowed = { stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW } as const;
    const rendered = renderWithStopSurvey(allowed, {
      kind: "intervention-survey",
      text: "rate these",
      asked: 1,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("leaves stdout untouched, so a JSON reader is unaffected", () => {
    const allowed = { stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW } as const;
    const rendered = renderWithStopSurvey(allowed, {
      kind: "intervention-survey",
      text: "rate these",
      asked: 1,
    });

    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).toContain("rate these");
  });

  it("does not downgrade a deny it decorates", () => {
    const denied = { stdout: "{}", stderr: "no", exitCode: HOOK_EXIT.DENY } as const;
    const rendered = renderWithStopSurvey(denied, {
      kind: "intervention-survey",
      text: "rate these",
      asked: 1,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
  });

  it("passes the response straight through when there is no survey", () => {
    const allowed = { stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW } as const;
    expect(renderWithStopSurvey(allowed, null)).toBe(allowed);
  });
});
