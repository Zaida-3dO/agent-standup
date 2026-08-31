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
  /**
   * The reason a caller wrote when overriding this finding, verbatim.
   *
   * Present only on an `overridden` outcome, and the two are set together
   * by `buildCaptures` from the same value — an `overridden` row with no
   * reason would be the outcome this table most wants to read stripped of
   * the only thing that makes it readable.
   */
  readonly overrideReason?: string;
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
  /**
   * The entries this call's override actually released, if any.
   *
   * A list rather than a boolean because an override is scoped to the entry
   * it names (`../hook/override.ts`): a call carrying two blocking findings
   * where only one was overridden released neither, and even where every
   * finding was covered it is the per-entry match that decides which rows
   * may say `overridden`. A finding not in this list is recorded exactly as
   * it would have been with no override present at all.
   */
  readonly overriddenEntryIds?: readonly string[];
  /**
   * The reason the caller wrote, already trimmed and bounded by
   * `overrideApplies`. Only meaningful alongside `overriddenEntryIds`.
   */
  readonly overrideReason?: string;
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
 * ── Where `overridden` is decided, and why it is decided here ──────────
 *
 * An earlier version of this comment said `overridden` was not decided
 * here, on the reasoning that an override happens *after* the refusal, on a
 * later call, and that a row would be amended when the caller proceeded.
 * That described a mechanism that was never built — nothing amended
 * anything, no code path anywhere produced this value, and the enum's most
 * diagnostic outcome was unreachable while a comment explained why it did
 * not need to be reachable yet.
 *
 * It is decided here because the retry *is* an ordinary call, and it
 * carries its own override (`../hook/payload.ts` reads it off the payload,
 * `../hook/decide.ts` matches it against this call's findings). So at the
 * moment this runs, whether this finding was released is a known fact about
 * this call rather than a guess about a later one. Amending an earlier row
 * would in any case have been the wrong shape: the first call really was
 * `blocked`, and rewriting that row would erase the refusal the override is
 * only meaningful in contrast to. Two rows — a block, then an override —
 * are the honest record of what happened.
 *
 * **A finding is `overridden` only if it is named in `overriddenEntryIds`.**
 * A blocking finding on a call where some *other* entry was overridden is
 * still `blocked`, because it was: `decide` releases a call only when every
 * blocking finding is covered, so an uncovered finding refused the call.
 */
export function outcomeFor(
  finding: InterventionFinding,
  context: CaptureContext,
): InterventionOutcome {
  if (finding.level === "nothing") return "silent";
  if (!isBlockingLevel(finding.level)) return "nudged";
  // Checked before `blocked`, because an overridden call is precisely one
  // that was *not* refused — reading `blocked === false` first would file
  // every override as a `nudged`, which is the outcome for a finding that
  // never tried to stop anything, and would lose the distinction the enum
  // calls the most diagnostic one on the list.
  if (context.overriddenEntryIds?.includes(finding.id) === true) return "overridden";
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
    const outcome = outcomeFor(finding, context);
    // The reason rides only the rows it actually excused. Attaching it to
    // every row on the call would credit a reason to findings it did not
    // release — including, on a call `decide` refused, findings that were
    // never overridden at all.
    const overrideReason = outcome === "overridden" ? context.overrideReason : undefined;
    return {
      entryId: finding.id,
      sessionId: context.sessionId,
      ...(context.rootSessionId === undefined ? {} : { rootSessionId: context.rootSessionId }),
      ...(context.itemId === undefined ? {} : { itemId: context.itemId }),
      outcome,
      level: finding.level,
      phase: finding.phase,
      ...(context.tool === undefined ? {} : { tool: context.tool }),
      ...(command === undefined ? {} : { command }),
      message: finding.messages.plain,
      ...(overrideReason === undefined || overrideReason === "" ? {} : { overrideReason }),
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
