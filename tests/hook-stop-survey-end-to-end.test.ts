// The session-end survey, driven the way the process drives it —
// `runHook` with a server that volunteers a `windDown` block.
//
// ── What only this file can prove ──────────────────────────────────────
//
// Every piece of this feature was already built and individually tested
// before this row: `survey.ts` builds the question, `evaluateStopSurvey`
// decides whether to ask, `renderWithStopSurvey` renders it, and
// `hook-stop-survey.test.ts` covers all three. And the feature was inert,
// because nothing connected them: the server never sent a block and
// `ask-http.ts` never read one.
//
// **A feature can be green in every unit test and dead in the product.**
// That is the failure this file exists to catch, so the assertions here are
// about what a session actually reads on stderr at the end of a turn, driven
// from a string of stdin — not about what any function returned.

import { describe, expect, it } from "vitest";
import { runHook } from "@/lib/hook/run";
import { HOOK_EXIT } from "@/lib/hook/response";
import { WIND_DOWN_QUIET_MS } from "@/lib/interventions/survey";

const NOW = 1_700_000_000_000;

function stopStdin(sessionId = "s-1"): string {
  return JSON.stringify({ hook_event_name: "Stop", session_id: sessionId });
}

function toolStdin(): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s-1",
    tool_name: "Bash",
    tool_input: { command: "git status" },
  });
}

/** A server that volunteers the firings, exactly as `hook_decision` now does. */
const withFirings = async () => ({
  decision: "allow" as const,
  windDown: {
    unrated: [
      {
        eventId: "11",
        entryId: "I10",
        at: NOW - 600_000,
        tool: "Bash",
        message: "Broad process kills are denied; scope it to a PID.",
        outcome: "blocked",
      },
    ],
    liveCrew: 0,
    wakeScheduled: false,
  },
});

/** A server with nothing to ask about — the overwhelmingly common stop. */
const noFirings = async () => ({ decision: "allow" as const });

/** The client's measured quiet, as `standup-hook.ts` supplies it. */
const quiet = { idleMs: WIND_DOWN_QUIET_MS + 1 };

describe("a real session ending", () => {
  it("puts the survey in front of the agent on stderr", async () => {
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: withFirings,
      now: NOW,
      survey: quiet,
    });

    expect(rendered.stderr).toContain("intervention-survey");
    // The owner's scale, rendered from the stored meanings rather than
    // paraphrased — a tidied scale would score differently while still
    // producing numbers between 1 and 5.
    expect(rendered.stderr).toContain("wrong path");
    expect(rendered.stderr).toContain("Please remove");
  });

  it("names the eventId the agent must pass to score_intervention", async () => {
    // Criterion 1 is that a real ending produces real SCORES, and the only
    // route from this prompt to a row is the agent quoting this id back.
    // `delivery.ts`'s `scoringPrompt` explicitly cannot do this — it has no
    // event id at the point it runs — so the survey is the one place the id
    // is available, and printing it is the whole difference between a
    // promptable loop and an unanswerable one.
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: withFirings,
      now: NOW,
      survey: quiet,
    });

    expect(rendered.stderr).toContain("eventId 11");
    expect(rendered.stderr).toContain('{"scores":[{"eventId"');
  });

  it("carries enough context to tell a genuine 1 from a sulk", async () => {
    // Criterion 3. The schema comment at `intervention_events.message` is
    // the source: a rater asked to score a bare entry id cannot recall the
    // call it fired on, and an agent grading a guard that blocked it is not
    // a neutral party. What makes the score readable later is that the
    // firing, the tool, the outcome and the exact message it was shown are
    // all on the record beside it.
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: withFirings,
      now: NOW,
      survey: quiet,
    });

    expect(rendered.stderr).toContain("I10");
    expect(rendered.stderr).toContain("Bash");
    expect(rendered.stderr).toContain("blocked");
    expect(rendered.stderr).toContain("scope it to a PID");
    // And the ask for the note that separates "wrong detection" from
    // "right detection, unusable message" — the two things a 1 can mean.
    expect(rendered.stderr).toContain("note");
  });
});

describe("the discrimination", () => {
  it("says nothing on a stop where the session is still active", async () => {
    // Criterion 2. The server volunteered firings; the client measured no
    // quiet. `Stop` fires often, and this is the case that stops it being
    // a survey on every turn boundary.
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: withFirings,
      now: NOW,
      survey: { idleMs: 0 },
    });

    expect(rendered.stderr).not.toContain("intervention-survey");
  });

  it("says nothing on a stop where the quiet was never measured", async () => {
    // No `survey` option at all — an unreadable spool, a hook with no
    // spool yet. Absent must read as "do not ask", never as "ask anyway".
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: withFirings,
      now: NOW,
    });

    expect(rendered.stderr).not.toContain("intervention-survey");
  });

  it("says nothing while crew are still running", async () => {
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: async () => ({
        decision: "allow" as const,
        windDown: { ...(await withFirings()).windDown, liveCrew: 2 },
      }),
      now: NOW,
      survey: quiet,
    });

    expect(rendered.stderr).not.toContain("intervention-survey");
  });

  it("never surveys on a tool call, however complete the context", async () => {
    // Surveying on a `PreToolUse` would interrupt the middle of a task to
    // ask about a nudge from four minutes ago.
    const rendered = await runHook({
      stdin: toolStdin(),
      askServer: withFirings,
      now: NOW,
      survey: quiet,
    });

    expect(rendered.stderr).not.toContain("intervention-survey");
    // And the allow is still silent — the ordinary path is unchanged.
    expect(rendered).toEqual({ stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW });
  });
});

describe("a session that tripped nothing", () => {
  it("produces no survey and no noise at all", async () => {
    // Criterion 4, asserted as total silence rather than as "no survey
    // text": a stop that started printing anything on every quiet session
    // would be a line of noise at the end of every turn in the system.
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: noFirings,
      now: NOW,
      survey: quiet,
    });

    expect(rendered).toEqual({ stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW });
  });

  it("stays silent when the server volunteers an empty firing list", async () => {
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: async () => ({
        decision: "allow" as const,
        windDown: { unrated: [], liveCrew: 0, wakeScheduled: false },
      }),
      now: NOW,
      survey: quiet,
    });

    expect(rendered).toEqual({ stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW });
  });
});

describe("the survey can never hold a turn open", () => {
  it("exits zero with a survey attached", async () => {
    // DECISIONS.md §6 — a refused stop can trap an agent in a loop, and a
    // questionnaire that could do it is indefensible where even the catch
    // is advisory.
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: withFirings,
      now: NOW,
      survey: quiet,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("leaves stdout empty, so a JSON reader is unaffected", async () => {
    // stdout on an allow is parsed as JSON by the tools that read it; a
    // prompt printed there is a parse failure at the end of every session.
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: withFirings,
      now: NOW,
      survey: quiet,
    });

    expect(rendered.stdout).toBe("");
  });

  it("survives a server that answers nothing", async () => {
    // An unreachable server means no firings, which means no survey — and
    // must not mean an error at the end of a turn.
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: async () => undefined,
      now: NOW,
      survey: quiet,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stderr).not.toContain("intervention-survey");
  });
});
