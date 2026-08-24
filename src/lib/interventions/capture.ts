// Capturing what an intervention did, so it can be rated later.
//
// The first of the owner's criteria: *"interventions that fire during a
// session are captured with enough context to be rated later — which guard,
// what it refused, what the agent was doing."* A finding is computed,
// rendered onto the response, and discarded. This module is what gives it a
// row, so that something can be asked about it later.
//
// ── Why the context is stored and not looked up ────────────────────────
//
// Every field on a captured row is a copy of what was true at the moment of
// firing, including the resolved level and the message the session was
// shown. Looking them up later from the catalogue would be cheaper and
// would be wrong: a score is a judgement about *what actually happened*,
// and an entry's message and level are both configurable and both change.
// An aggregate that re-rendered the current message under an old score
// would attribute a rating to text nobody ever read.
//
// The message matters most, and the corpus is explicit about why. The
// firing that most deserved a 1 in this installation's history was a
// correct detection whose message told the caller to kill by process id and
// then refused a process-id-scoped kill. A row storing only the entry id
// could not distinguish that from an entry that is simply wrong, and those
// have opposite fixes — reword the message, or delete the entry.
//
// ── This module writes nothing ─────────────────────────────────────────
//
// It turns findings into rows. The write belongs to a service operation,
// for the same reason the digest does not emit: a module that persisted
// would only ever persist the one way it had been taught, and the hook
// path, a backfill and a test have different needs. `buildCaptures` is the
// seam — whoever writes reads that value.

import { isBlockingLevel, type InterventionFinding } from "./types";

/** What an intervention did on the call it fired on. */
export const INTERVENTION_OUTCOMES = ["silent", "nudged", "blocked", "overridden"] as const;
export type InterventionOutcome = (typeof INTERVENTION_OUTCOMES)[number];

/**
 * How much of a command is kept.
 *
 * A command can be a multi-kilobyte heredoc and this row is written on the
 * highest-volume path in the system. Two hundred characters is enough for a
 * rater to recognise what it was doing — which is the row's only job — and
 * the truncation is marked so a reader never mistakes a cut command for the
 * whole one and concludes the guard fired on something it did not see.
 */
export const MAX_CAPTURED_COMMAND = 200;

/** One firing, ready to be written. */
export interface InterventionCapture {
  readonly entryId: string;
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly itemId?: string;
  readonly outcome: InterventionOutcome;
  readonly level: string;
  readonly phase: string;
  readonly tool?: string;
  readonly command?: string;
  readonly message?: string;
}

/** What the call this finding fired on looked like. */
export interface CaptureContext {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly itemId?: string;
  readonly tool?: string;
  readonly command?: string;
  /** Whether the call was actually refused. */
  readonly blocked?: boolean;
}

/**
 * Truncates a command for storage, marking it when it was cut.
 *
 * The marker is the point. An untruncated-looking command that was in fact
 * truncated invites a reader to conclude the guard matched on text that was
 * never there.
 */
export function truncateCommand(command: string, limit: number = MAX_CAPTURED_COMMAND): string {
  if (command.length <= limit) return command;
  return `${command.slice(0, limit)}…[truncated]`;
}

/**
 * What one finding did.
 *
 * `overridden` is not decided here: an override happens *after* the
 * refusal, on a later call, so at capture time a blocking finding is
 * `blocked` and is amended if and when the caller proceeds. Deciding it
 * here would mean guessing, and the guess would always be "not overridden",
 * which is the answer that makes overrides invisible — and an override is
 * the single most diagnostic event this table can hold, because it is the
 * caller saying in the moment that the refusal was wrong.
 */
export function outcomeFor(
  finding: InterventionFinding,
  context: CaptureContext,
): InterventionOutcome {
  if (finding.level === "nothing") return "silent";
  if (!isBlockingLevel(finding.level)) return "nudged";
  // A blocking level whose call was not actually refused did not block. The
  // phase can clamp it — a `post` finding never refuses anything — so
  // trusting the level alone would record a block that never happened.
  return context.blocked === false ? "nudged" : "blocked";
}

/**
 * Turns the findings from one decision into rows.
 *
 * **Every triggered finding is captured, including `nothing`-level ones.**
 * The catalogue's own guidance is to run a new entry silently before it
 * starts talking, and an entry in that state still wants its firing rate
 * known — indeed that is the entire purpose of running it silently. It is
 * excluded from the survey instead, by `surveyable` below, because there is
 * nothing for a session to have an opinion about.
 *
 * Returns an empty array for no findings, so a caller writes
 * unconditionally rather than testing first.
 */
export function buildCaptures(
  findings: readonly InterventionFinding[],
  context: CaptureContext,
): InterventionCapture[] {
  return findings.map((finding) => {
    const command = context.command === undefined ? undefined : truncateCommand(context.command);
    return {
      entryId: finding.id,
      sessionId: context.sessionId,
      ...(context.rootSessionId === undefined ? {} : { rootSessionId: context.rootSessionId }),
      ...(context.itemId === undefined ? {} : { itemId: context.itemId }),
      outcome: outcomeFor(finding, context),
      level: finding.level,
      phase: finding.phase,
      ...(context.tool === undefined ? {} : { tool: context.tool }),
      ...(command === undefined ? {} : { command }),
      message: finding.messages.plain,
    };
  });
}

/**
 * Whether a captured firing is worth surveying about.
 *
 * A `silent` firing is not: the session was never told anything, so asking
 * it to rate the intervention would be asking it to rate something it did
 * not experience — and it would answer, because an agent asked a question
 * produces an answer. That answer would be noise indistinguishable from
 * data, and noise that looks like data is worse than an absent row.
 */
export function surveyable(capture: InterventionCapture): boolean {
  return capture.outcome !== "silent";
}
