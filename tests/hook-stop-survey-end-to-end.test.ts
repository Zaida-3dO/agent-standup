// The session-end survey, driven the way the process drives it —
// `runHook` with a server that volunteers a `windDown` block.
//
// ── What only this file can prove ──────────────────────────────────────
//
// The survey is assembled from five pieces that are each covered on their
// own: `survey.ts` builds the question, `evaluateStopSurvey` decides whether
// to ask, `renderWithStopSurvey` renders it, `ask-http.ts` parses the
// server's block, and `run.ts` composes them. Every one of those can be
// green while the survey reaches nobody, because what joins them is not a
// function — it is a field name agreed between a producer and a parser that
// never import each other, and a spread in a third module.
//
// **A feature can be green in every unit test and dead in the product.**
// That is the failure this file exists to catch, so the assertions here are
// about what a session actually reads on stderr at the end of a turn, driven
// from a string of stdin — not about what any function returned.

import { describe, expect, it } from "vitest";
import { runHook } from "@/lib/hook/run";
import { HOOK_EXIT } from "@/lib/hook/response";
import { WIND_DOWN_QUIET_MS } from "@/lib/interventions/survey";
import { readWindDownContext } from "@/lib/hook/stop-catch";

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
    // And the tool to pass it to. This assertion used to require the JSON
    // reply shape instead, which contradicted this test's own name: the
    // shape had no ingestion path, so quoting the id back in it produced no
    // row. The id and the tool together are what make the loop answerable,
    // and they have to arrive in the same prompt.
    expect(rendered.stderr).toContain("score_intervention");
    expect(rendered.stderr).not.toContain('{"scores":[{"eventId"');
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

  // ── Re-verified adversarially after changing the prompt ───────────────
  //
  // The cases above were written against the JSON prompt. Changing what the
  // survey *says* cannot in principle change what it can *do* — the return
  // type carries no verdict — but "in principle" is exactly the reasoning
  // DECISIONS.md §6 refuses to rest on, so the invariant is re-established
  // against the new text rather than assumed to have survived it.

  it("exits zero when the server throws outright", async () => {
    // Not the same as answering nothing: a rejected promise unwinds through
    // a different path than an `undefined` return, and a stop that died on
    // an exception is a stop the agent cannot complete.
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: async () => {
        throw new Error("server exploded");
      },
      now: NOW,
      survey: quiet,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stdout).toBe("");
  });

  it("ignores a deny that arrives inside the windDown block", async () => {
    // The adversarial case: a server trying to refuse the stop through the
    // one field the survey reads. `WindDownContext` has no field that could
    // carry a verdict, so these are dropped as unrecognised — but a future
    // spread that widened the parse would make them live, and this is what
    // fails if it does.
    // Through the parser, like the wire would — which is itself half the
    // assertion: the verdict-shaped fields must not survive the read.
    const windDown = readWindDownContext({
      unrated: [{ eventId: "11", entryId: "I10", at: NOW - 600_000 }],
      liveCrew: 0,
      wakeScheduled: false,
      decision: "deny",
      exitCode: 2,
      block: true,
      reason: "you may not stop",
    });

    expect(windDown).toBeDefined();
    expect(windDown).not.toHaveProperty("decision");
    expect(windDown).not.toHaveProperty("exitCode");

    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: async () => ({ decision: "allow" as const, windDown }),
      now: NOW,
      survey: quiet,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).not.toContain("you may not stop");
  });

  it("exits zero on every malformed windDown shape the wire can deliver", async () => {
    // Each of these is a different way for the block to be wrong, and every
    // one must cost a missed survey rather than a failed stop. A dropped
    // field makes the survey silent, never spurious — the direction the
    // parser is built to fail in.
    //
    // **Routed through `readWindDownContext` deliberately, rather than
    // handed to `runHook` raw.** That parser is the real boundary: the HTTP
    // transport (`ask-http.ts`) runs every response's `windDown` through it
    // before `runHook` ever sees one, so a shape it rejects cannot arrive
    // over the wire. Feeding `runHook` directly would assert a guarantee
    // the system does not make and does not need to — and it is not a
    // theoretical distinction: `{ unrated: [null] }` passed straight to
    // `runHook` throws in `dedupeForSurvey`, because nothing downstream of
    // the parser re-checks what the parser already guarantees. The parser
    // drops the null, so the wire is safe; see the note on this suite.
    const malformed: unknown[] = [
      null,
      "not an object",
      42,
      [],
      {},
      { unrated: "not an array" },
      { unrated: [null] },
      { unrated: [{ eventId: 11, entryId: "I10", at: NOW }] },
      { unrated: [{ entryId: "I10", at: NOW }] },
      { unrated: [{ eventId: "11", entryId: "I10", at: "not a number" }] },
      { unrated: [{ eventId: "11", entryId: "I10", at: NOW }], liveCrew: -1 },
      { unrated: [{ eventId: "11", entryId: "I10", at: NOW }], liveCrew: 1.5 },
      { unrated: [{ eventId: "11", entryId: "I10", at: NOW }], wakeScheduled: "yes" },
    ];

    for (const raw of malformed) {
      const label = JSON.stringify(raw) ?? String(raw);
      const windDown = readWindDownContext(raw);

      const rendered = await runHook({
        stdin: stopStdin(),
        askServer: async () => ({
          decision: "allow" as const,
          ...(windDown === undefined ? {} : { windDown }),
        }),
        now: NOW,
        survey: quiet,
      });

      expect(rendered.exitCode, `windDown = ${label}`).toBe(HOOK_EXIT.ALLOW);
      expect(rendered.stdout, `windDown = ${label}`).toBe("");
    }
  });

  it("exits zero on a message far past any sane bound", async () => {
    // A 200k-character message is the shape that turns a render into a hang
    // or an out-of-memory at exactly the moment a session is trying to end.
    const huge = "x".repeat(200_000);
    const rendered = await runHook({
      stdin: stopStdin(),
      askServer: async () => ({
        decision: "allow" as const,
        windDown: {
          unrated: [
            { eventId: "11", entryId: "I10", at: NOW - 600_000, tool: "Bash", message: huge },
          ],
          liveCrew: 0,
          wakeScheduled: false,
        },
      }),
      now: NOW,
      survey: quiet,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(rendered.stdout).toBe("");
  });
});
