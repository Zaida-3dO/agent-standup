// Flagged runs — MILESTONES.md #69, specified by SCHEMA.md §12's "flag the
// runs where a score is worth most".
//
// ── The hole this closes ───────────────────────────────────────────────
//
// §12 states it plainly: without this, the exploration design has a hole.
// An experiment that went badly gets skimmed past, an accept records a weak
// endorsement, and you conclude the cheaper model was fine having never
// looked. The flag exists to make the one run whose score carries the most
// information ask for real eyes instead of being cleared with everything
// else.
//
// ── Why the question is the specification ──────────────────────────────
//
// The row phrases the feature as a sentence — "we tried a cheaper model
// here, is this up to standard?" — and that phrasing is the requirement,
// not decoration. A generic "please review this run" prompts a generic
// answer; naming the specific tradeoff that was taken tells the reader what
// judgement is actually wanted and what their answer will be used for. So
// the question is composed from the run's own facts (`flaggedRunQuestion`)
// rather than being a constant string.
//
// ── Flagged is not blocked ─────────────────────────────────────────────
//
// §12 keeps these distinct and so does this module: `blocked` means work
// cannot proceed without you; a flagged run means it proceeded, but your
// judgement is unusually valuable here. One is urgent, the other is an
// invitation. Conflating them makes the urgent list untrustworthy, which is
// how an urgent list stops being read at all — so nothing here produces an
// escalation, a badge on the blocked count, or anything a reader has to
// clear.
import type { SelectionReason } from "@/lib/picker/selection";

/** What a card needs to know about the run behind it to decide whether to flag it. */
export interface FlaggableRun {
  /** Why this model was used, or null where no dispatch decision stands behind the run. */
  readonly selectionReason: SelectionReason | null;
  /** Confidence at dispatch time, 0-1, or null when nothing recommended anything. */
  readonly recommendationStrength: number | null;
  /** The model that served the run, for the question's wording. */
  readonly model: string | null;
}

/**
 * Why a run was flagged.
 *
 * Named rather than boolean because the two reasons ask subtly different
 * questions — an exploration was a deliberate experiment, while a run
 * merely dispatched with low confidence was the picker admitting it did not
 * know. Both want eyes; only the first was a choice.
 */
export type FlagReason = "exploration" | "low_confidence";

/**
 * The confidence at or below which a run is worth a person's eyes.
 *
 * A **default, not a constant** — the milestone's governing constraint is
 * that the mechanism is code and the judgement is data, so this is
 * overridable by the caller and is surfaced through the settings registry
 * as `model_picker.flag_below_strength` rather than being compiled in.
 *
 * 0.5 as the shipped default: at or below an even chance, the picker is
 * closer to guessing than to recommending, and a guess is exactly the case
 * where a person's read is worth more than the aggregate.
 */
export const DEFAULT_FLAG_BELOW_STRENGTH = 0.5;

/**
 * Whether this run should ask for real eyes, and why.
 *
 * Null when it should not — the ordinary case, and deliberately the same
 * "null means nothing to say" shape `emptyStateMessage` uses, so a caller
 * asks once rather than asking "should I flag?" separately from "why?".
 *
 * `exploration` is checked first: a run that was BOTH an experiment and low
 * confidence is more usefully described as the experiment, because that is
 * the decision a reader is being asked to judge.
 *
 * A null `selectionReason` cannot be flagged on that basis at all — per
 * SCHEMA.md §1084 it means no dispatch decision stands behind the run
 * (telemetry saw which model served a call, never why), so there is no
 * tradeoff to ask about. It can still flag on low confidence if a strength
 * was somehow recorded, which is the honest reading of each column
 * separately.
 */
export function flagReasonFor(
  run: FlaggableRun,
  flagBelowStrength: number = DEFAULT_FLAG_BELOW_STRENGTH,
): FlagReason | null {
  if (run.selectionReason === "exploration") return "exploration";
  if (run.recommendationStrength !== null && run.recommendationStrength <= flagBelowStrength) {
    return "low_confidence";
  }
  return null;
}

/** Whether a run is flagged at all. */
export function isFlaggedRun(
  run: FlaggableRun,
  flagBelowStrength: number = DEFAULT_FLAG_BELOW_STRENGTH,
): boolean {
  return flagReasonFor(run, flagBelowStrength) !== null;
}

/**
 * The question a flagged run puts to the reader.
 *
 * Composed from the run's facts so it names the actual tradeoff taken. The
 * model is included when known, because "we tried a cheaper model" is
 * markedly less useful than naming which — the reader's judgement of
 * whether the output is up to standard depends on knowing what produced it.
 *
 * Returns null for an unflagged run rather than a generic prompt: a card
 * that asks every run the same question teaches a reader to ignore the
 * question.
 */
export function flaggedRunQuestion(
  run: FlaggableRun,
  flagBelowStrength: number = DEFAULT_FLAG_BELOW_STRENGTH,
): string | null {
  const reason = flagReasonFor(run, flagBelowStrength);
  if (reason === null) return null;

  const named = run.model !== null && run.model.trim() !== "" ? ` (${run.model.trim()})` : "";
  if (reason === "exploration") {
    return `We tried a cheaper model here${named} — is this up to standard?`;
  }
  return `This one was a close call${named} — we were not confident it was the right tier. Is this up to standard?`;
}

/**
 * The short label beside a flagged card.
 *
 * Deliberately an invitation rather than a demand, and deliberately not the
 * vocabulary the blocked list uses — see the module header on why those two
 * must not be confused.
 */
export function flaggedRunLabel(reason: FlagReason): string {
  return reason === "exploration" ? "Worth a look" : "Worth a look — close call";
}
