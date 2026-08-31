// Working out how a run went without asking anyone — MILESTONES.md #67.
//
// #66 records what an agent and a person THOUGHT of a run. This module
// derives a signal from what the system already observed: how many review
// rounds the work took, how severe the findings were, whether it had to be
// redone, and how much steering it needed. Nobody is asked anything, so it
// is available on every run rather than on the few somebody rated.
//
// ── Derived from recorded facts, never from a constant ────────────────
//
// Every input here is a row the server wrote for its own reasons before
// this module existed: `Artifact.verdict` and `Artifact.reviewRound` are
// written by the review path, `Run.reworkRequired` and
// `Run.steeringInterventions` by the telemetry path. Nothing here invents a
// measurement, and the weights that turn those facts into a score are
// arguments with defaults rather than literals buried in the arithmetic —
// the milestone's requirement that the mechanism be bounded code while the
// judgement stays data.
//
// ── Severity comes from the verdict, NOT from `blockingFindings` ──────
//
// `Run.blockingFindings` is the obvious column to read and it must not be
// read. Its own schema comment says no code writes it: it is only ever its
// `0` default, so a reader that trusted it would compute a confident,
// uniformly clean answer for every run in the table — the worst failure
// available here, because it looks like data.
//
// `Artifact.verdict` is written on every review and its tiers already
// encode severity, which is what tiering is for: `changes_required` blocks,
// `lgtm_with_nits` is cosmetic, `lgtm_with_followups` is real but not
// blocking this change. That is a severity scale the review path maintains
// as a side effect of doing its job.
//
// ── A signal, and separately whether it can be trusted ────────────────
//
// `confidence` is returned beside the score rather than folded into it. A
// run with no review artifacts at all yields a score that is arithmetically
// fine and evidentially worthless, and a consumer that could not tell those
// apart would learn from noise. Folding it in would produce a middling
// number that reads as a middling run.

import { isApprovingVerdict } from "../verdicts";
import { MAX_RUN_SCORE, MIN_RUN_SCORE } from "./run-scores";

/** One review as the derived signal reads it. */
export interface ReviewRoundInput {
  /** The round this review belongs to. 1 is the first look at the work. */
  readonly reviewRound: number;
  /** The verdict recorded, or null for an artifact that carries none. */
  readonly verdict: string | null;
}

/** Everything observed about a run, as recorded elsewhere. */
export interface RunEvidence {
  /** Review artifacts for the work, in any order. */
  readonly reviews: readonly ReviewRoundInput[];
  /** `Run.reworkRequired` — the work had to be redone. */
  readonly reworkRequired?: boolean;
  /** `Run.steeringInterventions` — how often a supervisor had to correct course. */
  readonly steeringInterventions?: number;
}

/**
 * How much each observation moves the score, in points on the 1-5 scale.
 *
 * Defaults, not constants: they are the judgement half of this milestone
 * and the milestone says the judgement is data. A caller with evidence that
 * a rejected round costs more than a point may say so without editing the
 * arithmetic, and every one of these is exercisable in a test by passing a
 * different number.
 */
export interface SignalWeights {
  /** Subtracted for each review round after the first. */
  readonly perExtraRound: number;
  /** Subtracted for each round whose verdict blocked. */
  readonly perBlockingRound: number;
  /** Subtracted for each round approved with cosmetic findings only. */
  readonly perNitRound: number;
  /** Subtracted when the work had to be redone. */
  readonly rework: number;
  /** Subtracted per steering intervention. */
  readonly perSteering: number;
}

/**
 * The default weights.
 *
 * Ordered by what each observation actually says about the work. A blocking
 * verdict is the strongest signal available — a reviewer stating the change
 * is not sound — so it costs most. An extra round costs less than the
 * blocking verdict that caused it, because rounds and blocks are correlated
 * and charging both at full weight would double-count one event. A nit
 * round barely moves it: cosmetic findings on sound work are the system
 * working.
 */
export const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = Object.freeze({
  perExtraRound: 0.5,
  perBlockingRound: 1.0,
  perNitRound: 0.25,
  rework: 1.0,
  perSteering: 0.5,
});

/** How much evidence stood behind a derived score. */
export type SignalConfidence = "none" | "low" | "high";

/** The derived signal for one run. */
export interface DerivedSignal {
  /**
   * The score on the same 1-5 scale a rater uses, so the two are
   * comparable. Null when there is no evidence at all — an unscored run,
   * not a bad one.
   */
  readonly score: number | null;
  readonly confidence: SignalConfidence;
  /** How many distinct review rounds the work went through. */
  readonly rounds: number;
  /** Rounds whose verdict blocked the change. */
  readonly blockingRounds: number;
  /** Rounds approved with cosmetic findings only. */
  readonly nitRounds: number;
  readonly reworkRequired: boolean;
  readonly steeringInterventions: number;
  /** Plain-language account of what moved the score, strongest first. */
  readonly reasons: readonly string[];
}

/**
 * Whether a verdict blocked the change.
 *
 * Anything that does not approve and is not the "no verdict to give" label
 * blocks. Expressed against `isApprovingVerdict` rather than by listing
 * labels, so a verdict added to the enum later is treated as blocking until
 * someone deliberately adds it to the approving set — the safe direction,
 * since the alternative silently scores unknown verdicts as clean.
 */
export function isBlockingVerdict(verdict: string | null): boolean {
  if (verdict === null || verdict === "na") return false;
  return !isApprovingVerdict(verdict);
}

/** Whether a verdict approved the work while leaving cosmetic findings. */
export function isNitVerdict(verdict: string | null): boolean {
  return verdict === "lgtm_with_nits";
}

/**
 * Clamps a computed score onto the scale.
 *
 * Clamping is right HERE and wrong when summarising raters' scores. There,
 * a value outside the range means a bad row and clamping would invent an
 * opinion nobody expressed. Here the value is arithmetic this module just
 * performed on a known scale, so a result below 1 means "as bad as this
 * scale can express" rather than a data error.
 */
function clampToScale(value: number): number {
  if (value < MIN_RUN_SCORE) return MIN_RUN_SCORE;
  if (value > MAX_RUN_SCORE) return MAX_RUN_SCORE;
  return value;
}

/**
 * How much evidence a run's observations amount to.
 *
 * A run nobody reviewed has `none`, and its score is null rather than a
 * number: the arithmetic would happily return a clean 5 for work no
 * reviewer ever looked at, and that 5 would be indistinguishable from a
 * genuinely clean review. One round is `low` — a single approving look is
 * weak evidence of quality, and the picker should weight it accordingly.
 */
export function confidenceFor(rounds: number): SignalConfidence {
  if (rounds === 0) return "none";
  if (rounds === 1) return "low";
  return "high";
}

/**
 * Derives how a run went from what was recorded about it.
 *
 * Starts from the top of the scale and subtracts. That direction is
 * deliberate: the null hypothesis for a piece of work that merged with one
 * clean review is that it went well, and every deduction then corresponds
 * to a specific observed event that can be named in `reasons`. Building
 * upward from the bottom would require inventing credit for the absence of
 * problems, which is not something the system observes.
 *
 * Rounds are counted as DISTINCT `reviewRound` values, not as artifacts. A
 * round with a code review and a visual review is one round that produced
 * two documents, and counting artifacts would score a thoroughly-reviewed
 * change as a troubled one.
 */
export function deriveRunSignal(
  evidence: RunEvidence,
  weights: SignalWeights = DEFAULT_SIGNAL_WEIGHTS,
): DerivedSignal {
  const roundNumbers = new Set<number>();
  const blockingRoundNumbers = new Set<number>();
  const nitRoundNumbers = new Set<number>();

  for (const review of evidence.reviews) {
    roundNumbers.add(review.reviewRound);
    if (isBlockingVerdict(review.verdict)) blockingRoundNumbers.add(review.reviewRound);
    if (isNitVerdict(review.verdict)) nitRoundNumbers.add(review.reviewRound);
  }

  const rounds = roundNumbers.size;
  const blockingRounds = blockingRoundNumbers.size;
  // A round that blocked is not also counted as a nit round: the blocking
  // verdict is the stronger statement about the same round, and charging
  // both would penalise one event twice.
  const nitRounds = [...nitRoundNumbers].filter((r) => !blockingRoundNumbers.has(r)).length;

  const reworkRequired = evidence.reworkRequired ?? false;
  const steeringInterventions = evidence.steeringInterventions ?? 0;
  const confidence = confidenceFor(rounds);

  if (confidence === "none") {
    return {
      score: null,
      confidence,
      rounds: 0,
      blockingRounds: 0,
      nitRounds: 0,
      reworkRequired,
      steeringInterventions,
      reasons: [],
    };
  }

  const extraRounds = rounds - 1;
  const deductions: { amount: number; reason: string }[] = [];

  if (blockingRounds > 0) {
    deductions.push({
      amount: blockingRounds * weights.perBlockingRound,
      reason:
        blockingRounds === 1
          ? "1 review round found blocking issues"
          : String(blockingRounds) + " review rounds found blocking issues",
    });
  }
  if (extraRounds > 0) {
    deductions.push({
      amount: extraRounds * weights.perExtraRound,
      reason:
        extraRounds === 1
          ? "took a second review round"
          : "took " + String(rounds) + " review rounds",
    });
  }
  if (reworkRequired) {
    deductions.push({ amount: weights.rework, reason: "the work had to be redone" });
  }
  if (steeringInterventions > 0) {
    deductions.push({
      amount: steeringInterventions * weights.perSteering,
      reason:
        steeringInterventions === 1
          ? "needed 1 steering intervention"
          : "needed " + String(steeringInterventions) + " steering interventions",
    });
  }
  if (nitRounds > 0) {
    deductions.push({
      amount: nitRounds * weights.perNitRound,
      reason:
        nitRounds === 1
          ? "1 round left cosmetic findings"
          : String(nitRounds) + " rounds left cosmetic findings",
    });
  }

  const total = deductions.reduce((sum, d) => sum + d.amount, 0);

  // Strongest first, so a reader sees what actually drove the score rather
  // than whichever observation this function happened to check first.
  const reasons = [...deductions].sort((a, b) => b.amount - a.amount).map((d) => d.reason);

  return {
    score: clampToScale(MAX_RUN_SCORE - total),
    confidence,
    rounds,
    blockingRounds,
    nitRounds,
    reworkRequired,
    steeringInterventions,
    reasons,
  };
}
