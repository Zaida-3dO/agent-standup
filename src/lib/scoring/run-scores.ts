// How well a run went, per facet — MILESTONES.md #66, SCHEMA.md §12.
//
// `run_scores` holds two scores per facet and never merges them: the
// agent's own judgement, and a person's. This module is the vocabulary and
// the arithmetic over that pair. It holds no database client and writes
// nothing, for the same reason `../interventions/scoring.ts` does not —
// every rule in here is then assertable against a literal array rather than
// a fixture, including the rules that decide whether a score may change.
//
// ── Why two scores rather than one column and an edit ──────────────
//
// The agent's score is FROZEN once written. A person who disagrees writes
// their own score beside it; they do not correct it. That is the entire
// value of the table: the delta between the two measures how well the agent
// judges its own work, and an overwrite destroys the only copy of the thing
// being measured. An agent that graded itself 5 on work a person graded 2
// is the most informative row this table can hold, and it exists only if
// the 5 survives the 2 being written.
//
// This is the one place where the intervention scale's shape does NOT
// generalise. `intervention_scores` upserts: a rater changing its mind
// updates its row, because there the aggregate is the product and a rater
// voting twice would move it. Here the first answer is itself the product.
// The two tables want opposite write rules, which is why this is a separate
// module rather than a reuse of that one.
//
// ── Accepting is a copy, not an absence ───────────────────────────
//
// SCHEMA.md §12: on accept, write `user_score = agent_score`. A null
// `user_score` then means "nobody looked" and never "looked and agreed",
// which are opposite data points. Collapsing them would bias every learning
// signal toward failures, because the only runs carrying a human judgement
// would be the ones somebody objected to.

/** Every facet a run can be scored on. Mirrors `Facet` in schema.prisma exactly. */
export const FACETS = [
  "reasoning",
  "breadth",
  "precision",
  "autonomy",
  "visual",
  "writing",
] as const;

export type Facet = (typeof FACETS)[number];

/** Whether a value is one of the facets the column can hold. */
export function isFacet(value: unknown): value is Facet {
  return typeof value === "string" && (FACETS as readonly string[]).includes(value);
}

export const MIN_RUN_SCORE = 1;
export const MAX_RUN_SCORE = 5;

/**
 * The 1–5 scale for how a run went.
 *
 * Written out because a scale whose points are unnamed is one where two
 * raters mean different things by a 3. These are deliberately phrased about
 * the WORK rather than about the model: "would this have merged" is a
 * question a reviewer can answer from the diff, whereas "was the model
 * good" invites a judgement of the tier that the picker is supposed to be
 * learning rather than being told.
 */
export const RUN_SCORE_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  5: "Landed clean — merged as proposed, no findings worth raising",
  4: "Sound work with cosmetic findings; it merged once nits were addressed",
  3: "Real findings, but the approach was right and the rework was bounded",
  2: "The approach needed correcting; most of the value was in the review, not the run",
  1: "Wrong or unusable — the work was discarded, redone, or actively cost time",
});

/**
 * Whether a value is a score on the scale.
 *
 * Integer-checked as well as range-checked. A 4.5 is not a point on this
 * scale and averaging it in would produce an aggregate no rater expressed;
 * the same reasoning as the intervention scale, and the database carries
 * the matching constraint.
 */
export function isValidRunScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_RUN_SCORE &&
    value <= MAX_RUN_SCORE
  );
}

/** One `run_scores` row as this module reads it. */
export interface RunFacetScore {
  readonly facet: Facet;
  /** The agent's own score. Null until it grades itself; frozen once set. */
  readonly agentScore: number | null;
  /** A person's score. Null means nobody looked. */
  readonly userScore: number | null;
  readonly userScoredBy?: string | null;
  readonly userScoredAt?: Date | string | null;
}

/**
 * Why a write to an existing score was refused.
 *
 * A named reason rather than a boolean because the two refusals call for
 * different things from the caller: a frozen agent score means "write a
 * user score instead", and an out-of-range score means "fix the number".
 * A caller handed only `false` would have to guess which.
 */
export type ScoreWriteRefusal =
  | { readonly kind: "frozen"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Whether an agent score may be written to this row.
 *
 * The freeze is expressed as a predicate over the EXISTING row rather than
 * as a database constraint, because the rule is "may not change once set"
 * and no column check can see the previous value. It lives here so it is
 * testable without a database, and so the operation and any future caller
 * share one definition of frozen.
 *
 * A row whose `agentScore` is null has never been graded, so writing is
 * allowed. Anything else is refused — including writing the SAME value
 * again. That looks pedantic and is not: an idempotent-looking re-write is
 * how a retry quietly becomes a correction when the caller's second attempt
 * carries a different number, and the refusal costs a caller nothing it
 * cannot handle by reading the row it already has.
 */
export function checkAgentScoreWritable(
  existing: Pick<RunFacetScore, "agentScore"> | null,
  score: number,
): ScoreWriteRefusal | null {
  if (!isValidRunScore(score)) {
    return {
      kind: "invalid",
      message:
        "Score must be an integer " +
        String(MIN_RUN_SCORE) +
        "-" +
        String(MAX_RUN_SCORE) +
        ", got " +
        JSON.stringify(score) +
        ".",
    };
  }
  if (existing !== null && existing.agentScore !== null) {
    return {
      kind: "frozen",
      message:
        "An agent score of " +
        String(existing.agentScore) +
        " is already recorded and is immutable — correcting it would destroy " +
        "the agent/person delta this table exists to measure. " +
        "Record a user score instead.",
    };
  }
  return null;
}

/** How a person's score relates to the agent's, once both exist. */
export type Agreement = "unscored" | "unreviewed" | "agreed" | "corrected";

/**
 * What the pair of scores on one facet says.
 *
 * Four states, and the two null ones are kept apart deliberately.
 * `unscored` (no agent score) means the run was never graded at all;
 * `unreviewed` (agent score, no user score) means nobody looked. A reader
 * that folded those together could not tell a gap in the capture path from
 * a gap in the review path, and those have different fixes.
 */
export function agreementOf(score: RunFacetScore): Agreement {
  if (score.agentScore === null) return "unscored";
  if (score.userScore === null) return "unreviewed";
  return score.userScore === score.agentScore ? "agreed" : "corrected";
}

/**
 * The signed gap between a person's score and the agent's.
 *
 * Negative means the agent over-rated itself, which is the direction worth
 * watching: an agent that grades its own work above a person's is the
 * failure mode a self-assessment loop is most prone to. Null when either
 * side is missing — zero would be indistinguishable from agreement.
 */
export function deltaOf(score: RunFacetScore): number | null {
  if (score.agentScore === null || score.userScore === null) return null;
  return score.userScore - score.agentScore;
}

/** A count for every point on the scale, all five keys required. */
export interface RunScoreDistribution {
  readonly 1: number;
  readonly 2: number;
  readonly 3: number;
  readonly 4: number;
  readonly 5: number;
}

type MutableDistribution = { -readonly [K in keyof RunScoreDistribution]: number };

function emptyDistribution(): MutableDistribution {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

/** The five points, strongest first — walked rather than re-listed by callers. */
export const RUN_SCALE_POINTS = [
  5, 4, 3, 2, 1,
] as const satisfies readonly (keyof RunScoreDistribution)[];

/**
 * What the scores say about one facet across many runs.
 *
 * `mean` sits alongside the distribution and is never the whole of it. A mean of 3
 * is five honest 3s or a 5 and a 1, and those call for opposite actions —
 * the same reason the intervention summary keeps its buckets, and the
 * reason this milestone calls a mean-only score insufficient.
 */
export interface FacetScoreSummary {
  readonly facet: Facet;
  /** How many rows carried a score on the requested source. */
  readonly count: number;
  readonly mean: number;
  readonly distribution: RunScoreDistribution;
  /** Scores of 1 — work that was wrong or unusable. */
  readonly poor: number;
  /** Scores of 1 or 2 — the "needed correcting" tail. */
  readonly weak: number;
  /** How many of these rows a person also scored. */
  readonly reviewed: number;
  /** Of the reviewed rows, how many a person moved. */
  readonly corrected: number;
  /**
   * Mean signed delta over rows where both scores exist, or null when none
   * do. Negative means the agent over-rated itself on balance.
   */
  readonly meanDelta: number | null;
}

/** Which of the two scores an aggregate reads. */
export type ScoreSource = "agent" | "user" | "effective";

/**
 * Picks the score an aggregate should read from one row.
 *
 * `effective` prefers the person's score and falls back to the agent's,
 * which is the reading the picker wants: a human judgement supersedes a
 * self-assessment where one exists, and the agent's stands where it does
 * not. It is a READ-time preference and writes nothing — the frozen column
 * is untouched, so the delta survives.
 */
export function scoreFrom(row: RunFacetScore, source: ScoreSource): number | null {
  if (source === "agent") return row.agentScore;
  if (source === "user") return row.userScore;
  return row.userScore ?? row.agentScore;
}

/**
 * Rolls scores up per facet.
 *
 * Invalid scores are dropped rather than clamped, matching the intervention
 * summary: clamping invents an opinion nobody expressed and hides the bad
 * row, while dropping leaves the count able to disagree with the caller.
 *
 * Sorted by facet name so a report's row order is stable between runs.
 */
export function summariseRunScores(
  rows: readonly RunFacetScore[],
  source: ScoreSource = "effective",
): FacetScoreSummary[] {
  const byFacet = new Map<
    Facet,
    { scores: number[]; reviewed: number; corrected: number; deltas: number[] }
  >();

  for (const row of rows) {
    const value = scoreFrom(row, source);
    if (!isValidRunScore(value)) continue;

    const bucket = byFacet.get(row.facet) ?? {
      scores: [],
      reviewed: 0,
      corrected: 0,
      deltas: [],
    };
    bucket.scores.push(value);

    // Agreement is read from the ROW, not from the aggregated value: under
    // `effective` the aggregated number is the user's where one exists, so
    // deriving agreement from it would report every reviewed row as agreed.
    const agreement = agreementOf(row);
    if (agreement === "agreed" || agreement === "corrected") {
      bucket.reviewed += 1;
      if (agreement === "corrected") bucket.corrected += 1;
      const delta = deltaOf(row);
      if (delta !== null) bucket.deltas.push(delta);
    }

    byFacet.set(row.facet, bucket);
  }

  const summaries: FacetScoreSummary[] = [];
  for (const [facet, bucket] of byFacet) {
    const distribution = emptyDistribution();
    let total = 0;
    for (const score of bucket.scores) {
      distribution[score as keyof RunScoreDistribution] += 1;
      total += score;
    }
    const count = bucket.scores.length;
    const deltaTotal = bucket.deltas.reduce((sum, d) => sum + d, 0);
    summaries.push({
      facet,
      count,
      mean: total / count,
      distribution,
      poor: distribution[1],
      weak: distribution[1] + distribution[2],
      reviewed: bucket.reviewed,
      corrected: bucket.corrected,
      meanDelta: bucket.deltas.length === 0 ? null : deltaTotal / bucket.deltas.length,
    });
  }

  return summaries.sort((a, b) => a.facet.localeCompare(b.facet));
}

/**
 * How many scores a facet needs before its aggregate is worth acting on.
 *
 * Three, for the reason the intervention threshold is three: one run is an
 * anecdote and two is a coincidence, while waiting for ten means a tier
 * that is wrong for this kind of work survives a fortnight of being wrong.
 * Exported so a caller with more data can demand more.
 */
export const DEFAULT_RUN_REVIEW_THRESHOLD = 3;

/**
 * The mean at or below which a facet is flagged.
 *
 * 2.5 — below the neutral 3, so the work has to be actively poor on balance
 * rather than merely unremarkable. A facet averaging exactly 3 is doing
 * what a 3 says: real findings, right approach.
 */
export const DEFAULT_RUN_REVIEW_MEAN = 2.5;

/** A facet the scores say is worth attention, and why. */
export interface FlaggedFacet {
  readonly facet: Facet;
  readonly summary: FacetScoreSummary;
  readonly reason: string;
}

export interface RunFlagOptions {
  readonly threshold?: number;
  readonly meanAtOrBelow?: number;
}

/**
 * Picks out the facets worth attention.
 *
 * Three independent triggers, because each catches a failure the others
 * miss:
 *
 *   - **A low mean** — poor on balance. The ordinary case.
 *   - **Any score of 1 at all**, regardless of mean. This is the trigger
 *     the milestone argued for: a single 1 among many 4s is the signal, and
 *     averaging destroys exactly the information the scores were collected
 *     to preserve. Work that was discarded once is not averaged away by
 *     nine runs that landed.
 *   - **A person correcting the agent DOWNWARD on balance.** An agent that
 *     grades its own work above a person's is mis-judging in the direction
 *     that matters, and its mean can look fine while doing so — the mean is
 *     over the effective scores, which are the person's where one exists,
 *     so a systematically over-confident agent hides behind the very
 *     corrections that fixed it.
 *
 * All three respect the count threshold: a facet with one score has not
 * been observed enough to act on, and flagging on a single 1 would turn one
 * bad run into a verdict on a model tier.
 */
export function flagFacetsForReview(
  summaries: readonly FacetScoreSummary[],
  options: RunFlagOptions = {},
): FlaggedFacet[] {
  const threshold = options.threshold ?? DEFAULT_RUN_REVIEW_THRESHOLD;
  const meanAtOrBelow = options.meanAtOrBelow ?? DEFAULT_RUN_REVIEW_MEAN;

  const flagged: FlaggedFacet[] = [];
  for (const summary of summaries) {
    if (summary.count < threshold) continue;

    const reasons: string[] = [];
    if (summary.mean <= meanAtOrBelow) {
      reasons.push(
        "mean " + summary.mean.toFixed(2) + " over " + String(summary.count) + " scores",
      );
    }
    if (summary.poor > 0) {
      reasons.push(
        summary.poor === 1
          ? "1 run scored 1 (unusable)"
          : String(summary.poor) + " runs scored 1 (unusable)",
      );
    }
    if (summary.meanDelta !== null && summary.meanDelta < 0) {
      reasons.push(
        "agent over-rated itself by " +
          Math.abs(summary.meanDelta).toFixed(2) +
          " on average over " +
          String(summary.reviewed) +
          " reviewed runs",
      );
    }
    if (reasons.length === 0) continue;

    flagged.push({ facet: summary.facet, summary, reason: reasons.join("; ") });
  }

  // Worst first, by mean — the facet worth reading about is the lowest, not
  // the one whose name sorts first.
  return flagged.sort((a, b) => a.summary.mean - b.summary.mean);
}
