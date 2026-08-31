// The stop-hook catch — MILESTONES.md #47 ("live crew and nothing scheduled
// to wake you"), DECISIONS.md §6.
//
// The situation this exists for: an orchestrator finishes its turn while
// crew it dispatched are still running, and nothing is scheduled to wake it
// when they finish. The work completes into a session that has stopped
// listening — nobody reads the result, nothing merges, and from the outside
// it is indistinguishable from work that failed.
//
// ── The condition, exactly as §6 states it ──────────────────────────────
//
//   > Condition is *"crew running AND nothing scheduled to wake you"* —
//   > silent if a wait is already backgrounded, or you'd nag every turn.
//
// Both halves are required, and the second half is what stops this being a
// nag: an orchestrator that has already backgrounded a wait has done the
// right thing, and telling it so on every Stop event would train it to
// ignore the message. The three ways a wake can already exist are treated
// alike (`isWakeScheduled`) because they are the same fact arriving by
// different routes.
//
// ── Advisory, and structurally so ───────────────────────────────────────
//
//   > **Nudge, not block**: a refused stop can trap an agent in a loop, and
//   > the server's staleness ladder is already the backstop.
//
// A blocked Stop is a genuinely dangerous shape: the agent cannot end its
// turn, so it does something else, which produces another Stop, which is
// refused again. That loop burns a budget with nobody watching, and the
// staleness ladder already catches the case this would be protecting
// against — so blocking buys nothing and costs a runaway.
//
// This module therefore returns **text or nothing**. It has no access to a
// verdict, no parameter that carries one, and no return shape that could
// express a refusal. The advisory property is a consequence of the
// function's type rather than a rule someone has to remember, which is the
// same posture the rest of the hook's judgement modules take.
//
// ── Why a Stop event and not a periodic check ───────────────────────────
//
// Stop is the only moment at which the question is both answerable and
// still actionable. Earlier, the crew may not have been dispatched yet;
// later, the session is gone and there is nobody to tell. `../hook/run.ts`
// already branches on the event type, so this costs no new wiring — DECISIONS.md
// §4's "one script, wired to both `PostToolUse` and `Stop`".

import type { HookEvent } from "./payload";

/**
 * What is known about an orchestrator's session at the moment it tries to
 * stop. Every field is optional because each arrives from a different place
 * and any may be absent — and an absent field means "not known", which is
 * silent rather than assumed.
 */
export interface StopContext {
  /**
   * How many crew this session dispatched are still running.
   *
   * Zero, or absent, is silent. This is the first half of §6's condition,
   * and it is a count rather than a boolean so the message can say how many
   * — an orchestrator deciding whether to wait benefits from knowing
   * whether it is one crew member or six.
   */
  readonly liveCrew?: number;
  /**
   * Whether something is already scheduled to wake this session — a
   * backgrounded `wait-for-crew`, a pending timer, a queued resume.
   *
   * The second half of §6's condition. When this is true the orchestrator
   * has already done the thing it would be told to do, so the catch is
   * silent.
   */
  readonly wakeScheduled?: boolean;
  /**
   * Whether a wait is already running in the background, specifically.
   *
   * Kept separate from `wakeScheduled` because the two are established by
   * different means — one is a process this session started, the other is
   * state the server holds — and a caller will often know one without the
   * other. Either being true is enough to stay silent; see `isWakeScheduled`.
   */
  readonly waitBackgrounded?: boolean;
  /**
   * Whether this session has already been told on this stop.
   *
   * The same edge-suppression discipline the rest of the hook's advisory
   * output uses: a message repeated on every Stop is one that gets ignored.
   */
  readonly alreadyCaught?: boolean;
}

/**
 * The advice produced when the condition holds. Text and a machine-readable
 * count — and, deliberately, **nothing that could refuse the stop.**
 */
export interface StopCatch {
  readonly kind: "stop-catch";
  /** The sentence the orchestrator reads. */
  readonly text: string;
  /** How many crew were still running, for a caller that wants to record it. */
  readonly liveCrew: number;
}

/**
 * Whether anything at all is already lined up to wake this session.
 *
 * The two flags are OR-ed rather than ranked: they are two routes to one
 * fact, and requiring both would make the catch fire at an orchestrator
 * that had already backgrounded a wait simply because the server had not
 * recorded it yet — the precise false positive §6 rules out.
 */
export function isWakeScheduled(context: StopContext): boolean {
  return context.wakeScheduled === true || context.waitBackgrounded === true;
}

const stopText = (liveCrew: number): string =>
  `${liveCrew} crew member${liveCrew === 1 ? "" : "s"} ${liveCrew === 1 ? "is" : "are"} still ` +
  "running and nothing is scheduled to wake you when they finish, so their work would complete " +
  "into a session that has stopped listening. Start a backgrounded wait before ending the turn. " +
  "This is advice, not a refusal — the turn is not being held open.";

/**
 * Evaluates the stop-hook catch for one event.
 *
 * Returns the advice when §6's condition holds, and `null` — silence —
 * otherwise. Silence is the overwhelmingly common answer and is not an
 * error.
 *
 * **Only a `Stop` event is considered.** A tool call is not an attempt to
 * end a turn, and evaluating this on `PostToolUse` would fire it on every
 * call an orchestrator made while its crew ran, which is the nag §6
 * forbids.
 *
 * **This function cannot block the stop.** It returns text or nothing; see
 * the module header.
 */
export function evaluateStopCatch(
  event: HookEvent,
  context: StopContext | undefined,
): StopCatch | null {
  if (event.eventType !== "Stop") return null;
  if (context === undefined) return null;

  // Already said once. Saying it again on the same stop is the nagging §6
  // rules out.
  if (context.alreadyCaught === true) return null;

  // Second half of the condition: something is already going to wake this
  // session, so there is nothing to warn about.
  if (isWakeScheduled(context)) return null;

  // First half: no live crew means the turn can end freely. An absent count
  // is "not known" and stays silent rather than guessing — a catch that
  // fired whenever the server failed to report would be noise on exactly
  // the events nobody could act on.
  const liveCrew = context.liveCrew;
  if (liveCrew === undefined || liveCrew <= 0) return null;

  return { kind: "stop-catch", text: stopText(liveCrew), liveCrew };
}

/**
 * Reads a `StopContext` off an arbitrary value — a field on a server
 * response, or a parsed local file.
 *
 * Each field is validated on its own and a malformed one is dropped rather
 * than failing the whole read. The direction matters: a dropped `liveCrew`
 * makes the catch **silent**, never spurious, so a server that garbles this
 * block costs a missed reminder rather than a false alarm on every stop.
 */
export function readStopContext(value: unknown): StopContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const liveCrew =
    typeof record.liveCrew === "number" && Number.isInteger(record.liveCrew) && record.liveCrew >= 0
      ? record.liveCrew
      : undefined;

  const context: StopContext = {
    ...(liveCrew === undefined ? {} : { liveCrew }),
    ...(typeof record.wakeScheduled === "boolean" ? { wakeScheduled: record.wakeScheduled } : {}),
    ...(typeof record.waitBackgrounded === "boolean"
      ? { waitBackgrounded: record.waitBackgrounded }
      : {}),
    ...(typeof record.alreadyCaught === "boolean" ? { alreadyCaught: record.alreadyCaught } : {}),
  };

  return Object.keys(context).length === 0 ? undefined : context;
}

// ── The intervention survey, delivered on the same Stop ─────────────────
//
// `../interventions/survey.ts` decides *when* to ask and *what the question
// looks like*, and it did both correctly from the day it was written. What
// it never had was a caller: nothing in `src/` referenced `buildSurvey`,
// `shouldSurvey` or `parseSurveyResponse`, so the scale the owner specified
// existed as a library and was never once put to a session.
//
// This is the delivery half. It lives here rather than in its own module
// because it is the same shape as the stop catch in every respect that
// matters — it evaluates only on a `Stop`, it returns text or nothing, and
// it cannot refuse anything — and because `renderWithStopCatch` already
// establishes the channel it needs. Two functions with one posture beside
// each other is easier to keep honest than one posture stated twice.
//
// **It cannot gate anything, and that is structural.** DECISIONS.md §6:
// Stop is advisory, and a refused stop can trap an agent in a loop. So this
// returns a `StopSurvey | null` — a value with no verdict in it and no
// field that could carry one — and `renderWithStopCatch` carries the
// response's own exit code through untouched. There is no argument to this
// function, and no configuration anywhere, that can make a survey hold a
// turn open.

import { buildSurvey, shouldSurvey, type WindDownContext } from "../interventions/survey";

/** The survey as the hook emits it: a prompt, and nothing that could refuse. */
export interface StopSurvey {
  readonly kind: "intervention-survey";
  /** The question, rendered from the owner's scale. */
  readonly text: string;
  /** How many firings are being asked about, for a caller that records it. */
  readonly asked: number;
}

/**
 * Evaluates the session-end survey for one event.
 *
 * Silence is the overwhelmingly common answer and is never an error: a
 * session with nothing unrated, a stop that is not a wind-down, or a
 * session already surveyed all produce `null`. `shouldSurvey` holds every
 * one of those conditions — this function deliberately adds none of its
 * own, so that "when do we ask" has exactly one home and cannot drift
 * between the two modules.
 *
 * **Only a `Stop` event is considered.** The same reason `evaluateStopCatch`
 * gives: a tool call is not an attempt to end a turn, and surveying on
 * `PostToolUse` would interrupt the middle of a task to ask about a nudge
 * from four minutes ago — which is both the worst moment to get an honest
 * answer and the interruption the digest design exists to avoid.
 */
export function evaluateStopSurvey(
  event: HookEvent,
  context: WindDownContext | undefined,
): StopSurvey | null {
  if (event.eventType !== "Stop") return null;
  if (context === undefined) return null;
  if (!shouldSurvey(context)) return null;

  // `shouldSurvey` has already established there is something to ask about,
  // but `buildSurvey` is the module that decides which firings make the cut
  // and it may still return nothing. Trusting the first check and asserting
  // the second would be assuming a relationship between two functions that
  // neither one promises.
  const survey = buildSurvey(context.unrated ?? []);
  if (survey === null) return null;

  return {
    kind: "intervention-survey",
    text: survey.prompt,
    asked: survey.firings.length,
  };
}

/**
 * Reads a `WindDownContext` off an arbitrary value — a field on a server
 * response.
 *
 * Each field is validated on its own and a malformed one is dropped rather
 * than failing the whole read, exactly as `readStopContext` does. The
 * direction is the same and matters for the same reason: a dropped field
 * makes the survey **silent**, never spurious. A server that garbles this
 * block costs a missed survey rather than an interrogation on every stop.
 *
 * `unrated` is the one field with structure in it, and a firing missing its
 * `eventId` or `entryId` is dropped individually — an answer cannot be
 * attributed without an event id, so a firing that cannot be identified is
 * one nothing could ever record a score against.
 */
export function readWindDownContext(value: unknown): WindDownContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const unrated = Array.isArray(record.unrated)
    ? record.unrated.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const firing = entry as Record<string, unknown>;
        const eventId = firing.eventId;
        const entryId = firing.entryId;
        if (typeof eventId !== "string" || eventId.trim() === "") return [];
        if (typeof entryId !== "string" || entryId.trim() === "") return [];
        const at = typeof firing.at === "number" && Number.isFinite(firing.at) ? firing.at : 0;
        return [
          {
            eventId: eventId.trim(),
            entryId: entryId.trim(),
            at,
            ...(typeof firing.tool === "string" ? { tool: firing.tool } : {}),
            ...(typeof firing.message === "string" ? { message: firing.message } : {}),
            ...(typeof firing.outcome === "string" ? { outcome: firing.outcome } : {}),
          },
        ];
      })
    : undefined;

  const liveCrew =
    typeof record.liveCrew === "number" && Number.isInteger(record.liveCrew) && record.liveCrew >= 0
      ? record.liveCrew
      : undefined;

  const idleMs =
    typeof record.idleMs === "number" && Number.isFinite(record.idleMs) && record.idleMs >= 0
      ? record.idleMs
      : undefined;

  const context: WindDownContext = {
    ...(unrated === undefined ? {} : { unrated }),
    ...(liveCrew === undefined ? {} : { liveCrew }),
    ...(idleMs === undefined ? {} : { idleMs }),
    ...(typeof record.wakeScheduled === "boolean" ? { wakeScheduled: record.wakeScheduled } : {}),
    ...(typeof record.alreadySurveyed === "boolean"
      ? { alreadySurveyed: record.alreadySurveyed }
      : {}),
  };

  return Object.keys(context).length === 0 ? undefined : context;
}
