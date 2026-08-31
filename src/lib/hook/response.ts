// Turning a verdict into what the agent tool actually reads — MILESTONES.md
// #42.
//
// A hook communicates two ways at once, and both have to be right because
// different tools (and different versions of one tool) read different ones:
//
//   - **A JSON object on stdout**, naming the decision and the reason. This
//     is the expressive channel: it can say *why*, which is the difference
//     between a refusal an agent can act on and one it retries into forever.
//   - **The process exit code.** The blunt channel, and the one that is
//     honoured even by a reader that ignores stdout entirely. A non-zero
//     exit is the refusal; the reason goes to stderr, where a tool that only
//     reads exit codes still surfaces it to the person.
//
// **Both are emitted for a deny, always.** Emitting only the JSON would let
// a tool that does not parse it run the command; emitting only the exit code
// would lose the reason. The cost of emitting both is a few bytes on a path
// that only runs when something is already being refused.
//
// An allow writes nothing to stdout and exits zero. That is not laziness —
// DECISIONS.md §4 calls the allow path "log silently", and a hook that
// printed on every allowed tool call would put a line of noise into the
// session after every Read, Grep and Glob the agent performs.

import type { HookVerdict } from "./decide";
import type { StopCatch, StopSurvey } from "./stop-catch";
import type { Nudge } from "./nudge";

/** The two exit codes this hook uses. */
export const HOOK_EXIT = {
  /** Allowed — say nothing. */
  ALLOW: 0,
  /**
   * Denied. `2` rather than `1` because agent tools conventionally treat a
   * hook's `2` as "block and feed stderr back to the model", where `1` is
   * an ordinary script failure that is reported to the person and otherwise
   * ignored — and a guard whose refusal the model never sees is a guard that
   * does not change what the model does next.
   */
  DENY: 2,
} as const;

export type HookExitCode = (typeof HOOK_EXIT)[keyof typeof HOOK_EXIT];

/** The JSON object written to stdout on a deny. */
export interface HookOutput {
  readonly decision: "deny";
  readonly reason: string;
  /** Which branch produced it — see `HookVerdict["source"]`. */
  readonly source: HookVerdict["source"];
  /**
   * The nested form some agent tools read instead of the flat fields above.
   * Duplicated rather than chosen between, for the same reason both channels
   * are written at all: a reader that understands only one of the two shapes
   * must still be refused.
   */
  readonly hookSpecificOutput: {
    readonly hookEventName: string;
    readonly permissionDecision: "deny";
    readonly permissionDecisionReason: string;
  };
}

/** What the entry point should write, and with what exit code. */
export interface RenderedResponse {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: HookExitCode;
}

/**
 * Renders one verdict.
 *
 * `eventName` is echoed back into `hookSpecificOutput` because the tools
 * that read that shape key on it; it is taken as a parameter rather than
 * read off the verdict because a verdict produced for an *unparseable*
 * payload has no event name to read — and that case must still render a
 * deny, which is the whole reason this function does not require a
 * `HookEvent`.
 */
export function renderResponse(verdict: HookVerdict, eventName: string): RenderedResponse {
  if (verdict.decision === "allow") {
    return { stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW };
  }

  const output: HookOutput = {
    decision: "deny",
    reason: verdict.reason,
    source: verdict.source,
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: "deny",
      permissionDecisionReason: verdict.reason,
    },
  };

  return {
    stdout: `${JSON.stringify(output)}\n`,
    stderr: `${verdict.reason}\n`,
    exitCode: HOOK_EXIT.DENY,
  };
}

/**
 * Attaches the stop-hook catch to an already-rendered response —
 * MILESTONES.md #47.
 *
 * ── The exit code is never touched ─────────────────────────────────────
 *
 * DECISIONS.md §6: "**Nudge, not block**: a refused stop can trap an agent
 * in a loop." So the catch is written to **stderr** and the exit code is
 * carried through from the response it decorates, unchanged. A `Stop` event
 * is allowed by construction (it has no command to classify), so in practice
 * that code is zero — and this function contains no expression that could
 * make it anything else, which is what keeps the advisory property true by
 * construction rather than by convention.
 *
 * stdout is left exactly as it was for the same reason `renderResponse`
 * writes nothing there on an allow: it is parsed as JSON by the tools that
 * read it, and prose printed into it is a parse failure.
 */
export function renderWithStopCatch(
  response: RenderedResponse,
  stopCatch: StopCatch | null,
): RenderedResponse {
  if (stopCatch === null) return response;

  const advisory = `[standup:${stopCatch.kind}] ${stopCatch.text}\n`;

  return {
    stdout: response.stdout,
    stderr: `${response.stderr}${advisory}`,
    // Deliberately the response's own code — see the note above.
    exitCode: response.exitCode,
  };
}

/**
 * Renders a verdict together with any nudges — MILESTONES.md #46.
 *
 * ── Where nudge text goes, and why it is stderr ────────────────────────
 *
 * **stderr**, on both the allow and the deny path. Not stdout, because
 * stdout on the allow path must stay empty: it is parsed as JSON by tools
 * that read it, and a bare sentence printed there is a parse failure on
 * every nudged call. stderr is already the channel this hook uses for the
 * text a person or a model reads (see the module header), and it is
 * surfaced by tools that ignore stdout entirely.
 *
 * ── The exit code is the verdict's, always ─────────────────────────────
 *
 * A nudge on an allowed call exits **zero**. That single line is the whole
 * of "a nudge is advisory": whatever text is emitted, the tool call is not
 * refused, not retried, and not interrupted. There is deliberately no
 * argument, setting or nudge field that can raise it — the exit code is
 * read from the rendered verdict and nowhere else.
 */
export function renderWithNudges(
  verdict: HookVerdict,
  eventName: string,
  nudges: readonly Nudge[],
): RenderedResponse {
  const base = renderResponse(verdict, eventName);
  if (nudges.length === 0) return base;

  const advisory = nudges.map((nudge) => `[standup:${nudge.kind}] ${nudge.text}`).join("\n");

  return {
    stdout: base.stdout,
    stderr: base.stderr === "" ? `${advisory}\n` : `${base.stderr}${advisory}\n`,
    // Deliberately `base.exitCode`, never a value derived from `nudges`.
    exitCode: base.exitCode,
  };
}

/**
 * Attaches the session-end intervention survey to an already-rendered
 * response — the owner's scoring loop, `../interventions/survey.ts`.
 *
 * ── The exit code is never touched, for the same reason as the catch ────
 *
 * DECISIONS.md §6 makes Stop advisory, and a survey is the least urgent
 * thing the hook has to say: it asks about guards that already fired on
 * calls that already happened. If a refused stop is dangerous for the catch
 * — which is at least about work in flight — it is indefensible for a
 * questionnaire. So this carries the response's own exit code through
 * unchanged, and contains no expression that could produce another one.
 *
 * **The survey is emitted last**, after the catch. Ordering here is purely
 * about what a reader sees last, and the catch is the more actionable of
 * the two: an orchestrator whose crew are about to be orphaned needs that
 * sentence more than it needs to rate a nudge. The survey is the wind-down
 * task, so it belongs at the end of the wind-down.
 */
export function renderWithStopSurvey(
  response: RenderedResponse,
  survey: StopSurvey | null,
): RenderedResponse {
  if (survey === null) return response;

  const advisory = `[standup:${survey.kind}] ${survey.text}
`;

  return {
    stdout: response.stdout,
    stderr: `${response.stderr}${advisory}`,
    exitCode: HOOK_EXIT.DENY,
  };
}
