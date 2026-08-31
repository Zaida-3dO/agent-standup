// How strongly to recommend, how often to experiment, and what an
// experiment is allowed to run on — MILESTONES.md #71.
//
// ── The safety property ────────────────────────────────────────────────
//
// "Bias experiments to low-risk work" is the one part of this row that is a
// safety property rather than a tuning knob. An experiment is, by
// construction, running work on a tier the picker is not confident about;
// doing that to work that is expensive to get wrong trades a small
// measurement gain for a large, irreversible cost. So `mayExperiment`
// refuses on anything not low-risk, and refuses **before** consulting the
// rate — an explore rate of 1.0 must not be able to put an experiment on a
// P0 or on work needing approval to merge. That ordering is the property;
// see the test named for it.
//
// ── Ships switched off ─────────────────────────────────────────────────
//
// `model_picker.enabled` is false and `model_picker.explore_rate` is 0 by
// default, and both are read from the typed settings registry rather than
// compiled in here. At those defaults nothing recommends and nothing
// experiments: `shouldExperiment` is false for every input, because a rate
// of zero admits no draw. The milestone's constraint is that the mechanism
// is bounded code while the judgement is data — so every threshold below is
// a parameter with a stated default, never a magic number in a branch.
//
// ── Confidence comes from the distribution, not the mean ───────────────
//
// `recommendationStrength` deliberately reads a facet's whole distribution
// (`FacetScoreSummary` from #66) rather than its mean. A tier averaging 4
// with a single 1 in its history is not a 4-confidence recommendation: the
// 1 is the run that was discarded, and it is exactly the information the
// scores were collected to preserve. So a poor tail cuts confidence
// directly, on top of whatever the mean says.
import type { FacetScoreSummary } from "@/lib/scoring/run-scores";

/**
 * How risky it is to get this piece of work wrong.
 *
 * Three bands rather than a boolean because the middle one is real: most
 * work is neither a production migration nor a typo fix, and collapsing it
 * either way would make the explore rate mean something quite different
 * from what it says.
 */
export type RiskBand = "low" | "medium" | "high";

/** The item facts risk is derived from — all already on `Item`. */
export interface RiskInputs {
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly mergeAuthority: "pre_approved" | "needs_approval" | "agent_judgement";
  readonly needsVisualReview: boolean;
  /** The item's declared difficulty map, sparse per SCHEMA.md §1.1a. */
  readonly difficulty?: Readonly<Record<string, number>> | null;
}

/**
 * The difficulty at or above which work stops being low-risk however it is
 * prioritised.
 *
 * 4 — the top two points of the 1-5 scale. Hard work is where a cheaper
 * tier is most likely to fail and where that failure is least likely to be
 * obvious, which is the combination an experiment should avoid.
 */
export const DEFAULT_HIGH_DIFFICULTY = 4;

/**
 * Which band a piece of work falls in.
 *
 * The rules, strictest first — anything matching a higher band takes it:
 *
 *   - **High:** `P0`, or a merge that needs a person's approval, or any
 *     declared facet at or above `highDifficulty`. Each is independently a
 *     statement that getting this wrong is expensive: P0 by priority,
 *     `needs_approval` because somebody wanted to see it before it landed,
 *     and high difficulty because that is where a cheaper tier fails
 *     quietly.
 *   - **Medium:** `P1`, or work needing visual review. Visual review sits
 *     here rather than high because it is a gate that *catches* the
 *     failure — the cost of a bad run is a bounced review, not a bad merge.
 *   - **Low:** everything else — `P2`/`P3`, pre-approved or agent-judgement
 *     merges, no high facet.
 *
 * A malformed difficulty value is ignored rather than treated as high: it
 * is not evidence of anything, and reading a typo as danger would quietly
 * switch experimentation off across a whole area.
 */
export function riskBandFor(
  item: RiskInputs,
  highDifficulty: number = DEFAULT_HIGH_DIFFICULTY,
): RiskBand {
  if (item.priority === "P0") return "high";
  if (item.mergeAuthority === "needs_approval") return "high";

  const difficulty = item.difficulty;
  if (difficulty !== null && difficulty !== undefined) {
    for (const value of Object.values(difficulty)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= highDifficulty) {
        return "high";
      }
    }
  }

  if (item.priority === "P1") return "medium";
  if (item.needsVisualReview) return "medium";
  return "low";
}

/**
 * Whether an experiment is permitted on this work at all.
 *
 * **Low risk only, and checked before the rate.** This is the safety
 * property of the row: no explore rate, however high, may put an experiment
 * on medium or high risk work. A caller that consulted the rate first and
 * this second would have a bug that only appears at high rates — which is
 * to say, in exactly the configuration somebody sets when they want the
 * picker to learn faster.
 */
export function mayExperiment(
  item: RiskInputs,
  highDifficulty: number = DEFAULT_HIGH_DIFFICULTY,
): boolean {
  return riskBandFor(item, highDifficulty) === "low";
}

/**
 * Whether this particular dispatch should be an experiment.
 *
 * `draw` is a 0-1 sample supplied by the caller rather than drawn here, so
 * this stays a pure function and a test can assert the boundary exactly
 * instead of running it a thousand times and hoping. The caller passes
 * `Math.random()`.
 *
 * Order is load-bearing and mirrors `mayExperiment`'s header: **risk is
 * checked before the rate**, and the picker being disabled is checked
 * before either. A rate of 0 yields false for every draw (nothing is
 * `< 0`); a rate of 1 yields true for every draw in [0,1) — but still only
 * on low-risk work.
 */
export function shouldExperiment(args: {
  readonly enabled: boolean;
  readonly exploreRate: number;
  readonly item: RiskInputs;
  readonly draw: number;
  readonly highDifficulty?: number;
}): boolean {
  if (!args.enabled) return false;
  if (!mayExperiment(args.item, args.highDifficulty ?? DEFAULT_HIGH_DIFFICULTY)) return false;
  if (!Number.isFinite(args.exploreRate) || args.exploreRate <= 0) return false;
  return args.draw < args.exploreRate;
}

/**
 * How many scores a tier needs before a recommendation from it is worth
 * anything.
 *
 * Three, matching `DEFAULT_RUN_REVIEW_THRESHOLD` in #66 — one run is an
 * anecdote and two is a coincidence. Below it, confidence is floored at
 * `MIN_STRENGTH` rather than computed, so a tier with one lucky 5 does not
 * present as certain.
 */
export const DEFAULT_MIN_OBSERVATIONS = 3;

/**
 * The confidence floor and ceiling.
 *
 * Never 0 and never 1. A 0 would say "certainly wrong", which no amount of
 * evidence about a different tier establishes; a 1 would say "no further
 * evidence could change this", which is false of every empirical estimate
 * and would suppress the experimentation that keeps the estimate honest.
 */
export const MIN_STRENGTH = 0.1;
export const MAX_STRENGTH = 0.95;

/**
 * How much a single unusable run (a score of 1) cuts confidence.
 *
 * 0.15 per occurrence, so one is a real dent and three all but eliminates
 * the recommendation. This is the distribution doing work the mean cannot:
 * a tier with nine 5s and one 1 has a mean of 4.6 and a failure mode, and
 * the mean alone would recommend it at near-maximum confidence.
 */
export const DEFAULT_POOR_PENALTY = 0.15;

/**
 * How strongly to recommend a tier, given how its runs have gone.
 *
 * The mean sets the base — normalised from the 1-5 scale onto 0-1 — and the
 * poor tail then cuts it. Both halves are needed: the mean alone cannot see
 * the single catastrophic run, and the tail alone cannot tell a tier that
 * is mediocre from one that is good.
 *
 * Returns `MIN_STRENGTH` on too little evidence rather than null, so a
 * caller always has a number to store and a low one honestly reads as "we
 * do not know yet". Null would force every consumer to invent a fallback,
 * and they would invent different ones.
 */
export function recommendationStrength(
  summary: FacetScoreSummary | null,
  options: {
    readonly minObservations?: number;
    readonly poorPenalty?: number;
  } = {},
): number {
  if (summary === null) return MIN_STRENGTH;
  const minObservations = options.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
  if (summary.count < minObservations) return MIN_STRENGTH;

  const poorPenalty = options.poorPenalty ?? DEFAULT_POOR_PENALTY;
  // The 1-5 mean onto 0-1: a mean of 1 is 0, a mean of 5 is 1.
  const base = (summary.mean - 1) / 4;
  const penalised = base - summary.poor * poorPenalty;
  return clampStrength(penalised);
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return MIN_STRENGTH;
  if (value < MIN_STRENGTH) return MIN_STRENGTH;
  if (value > MAX_STRENGTH) return MAX_STRENGTH;
  return value;
}
