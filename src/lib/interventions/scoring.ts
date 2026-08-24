// Scoring the catalogue — the evidence loop for interventions.
//
// `docs/plans/INTERVENTIONS.md` describes what is detected and what happens.
// It says nothing about whether any of it was *worth* detecting, and until
// now nothing did: the guard surface only ever grew, because every incident
// added an entry and nothing ever removed one. Entries have shipped that
// were unsatisfiable by construction, and entries have shipped whose message
// named a remedy the same guard then refused. Both were found by a person
// hitting them.
//
// This module turns that from a matter of opinion into data.
//
// ── The scale is the owner's, and the wording is load-bearing ──────────
//
// `INTERVENTION_SCORE_MEANINGS` below is the single place the scale is
// written, and it is written in the owner's own terms rather than
// paraphrased into something tidier. That matters more than it looks. A
// rewrite to "very useful / useful / neutral / unhelpful / harmful" reads
// like the same scale and is not one: the owner's 4 and 3 are separated by
// *whether the agent would have got there anyway*, not by degree of
// usefulness, and his 1 is not merely "worse than 2" — it is an explicit
// request to remove the entry. A rater handed the tidied version would
// score the same firing differently, and the aggregate would quietly stop
// meaning what the owner asked for.
//
// So the survey prompt is generated from this table rather than restated
// beside it, and `isRemovalSignal` gives the 1 its own name in code so that
// no reader has to remember the range's low end carries a demand.
//
// ── What this module is not ─────────────────────────────────────────────
//
// It holds no database client and writes nothing, for the same reason a
// predicate does not: aggregation over scores is arithmetic on rows handed
// in, and keeping it that way is what makes every threshold in it
// assertable against a literal array instead of a fixture. The persistence
// half lives in `../service/operations/`; the shape of a verdict lives
// here.

/** The 1–5 scale, in the owner's words. Do not paraphrase these. */
export const INTERVENTION_SCORE_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  5: "I would have gone down the wrong path and wasted a lot of tokens, or done something incorrect, if not for this nudge",
  4: "Saved me some time/tokens or got me somewhere quicker, but I wasn't about to do anything dangerous anyway",
  3: "Neutral — it helped, but I could probably have figured it out myself",
  2: "Didn't help; the nudge was incorrect or misleading and I wasted more time because of it",
  1: "Actively wrong or harmful — a block I had to route around, a stumbling block that took too long to work around. Please remove",
});

export const MIN_INTERVENTION_SCORE = 1;
export const MAX_INTERVENTION_SCORE = 5;

/**
 * Whether a value is a score on the scale.
 *
 * Integer-checked rather than merely range-checked: a 4.5 is not a point on
 * this scale, and averaging it in would produce an aggregate no rater
 * actually expressed. The database carries the same constraint — this is
 * the parser half of a rule enforced in both places, because an aggregate
 * is the entire product of the table and a bad row silently skews every
 * reading of it.
 */
export function isValidInterventionScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_INTERVENTION_SCORE &&
    value <= MAX_INTERVENTION_SCORE
  );
}

/**
 * Whether a score is the owner's explicit removal signal.
 *
 * A 1 is not "the low end of the range". Its wording ends *"Please
 * remove"*, and that is a demand rather than a sentiment — so it gets a
 * named predicate instead of a bare `=== 1` scattered across callers, and
 * the reason it means removal stays attached to it.
 *
 * A 2 is deliberately **not** included. A 2 says the entry did not help on
 * that firing; a 1 says it should not exist. Folding them together would
 * make the strongest thing a rater can say indistinguishable from the
 * second-strongest, which is the one distinction this scale most needs to
 * keep.
 */
export function isRemovalSignal(score: number): boolean {
  return score === MIN_INTERVENTION_SCORE;
}

/** One score as an aggregate reads it. */
export interface ScoredFiring {
  readonly entryId: string;
  readonly score: number;
  /** Optional one-liner from the rater. */
  readonly note?: string;
}

/**
 * What the scores say about one catalogue entry.
 *
 * `mean` is deliberately alongside the counts rather than instead of them.
 * A mean of 3 can be five honest 3s or a 5 and a 1, and those call for
 * opposite actions — the first is an entry doing its job unremarkably, the
 * second is an entry that is right sometimes and harmful others, which is
 * usually a detection that is too broad rather than an entry to delete.
 */
export interface EntryScoreSummary {
  readonly entryId: string;
  readonly count: number;
  readonly mean: number;
  /** How many of each score, keyed 1–5. Every key present, zeroes included. */
  readonly distribution: ScoreDistribution;
  /** Scores of 1 — the explicit removal requests. */
  readonly removalSignals: number;
  /** Scores of 1 or 2 — the "did not help" tail. */
  readonly unhelpful: number;
  /** Notes raters left, in the order given. Empty when none. */
  readonly notes: readonly string[];
}

/**
 * A count for every point on the scale, with all five keys required.
 *
 * Spelled out rather than `Record<number, number>` so that reading a bucket
 * yields a `number` instead of `number | undefined`. The distinction is not
 * pedantry here: under `noUncheckedIndexedAccess` an open record forces
 * every reader of a distribution to handle an absent bucket that this
 * module guarantees is present, and the usual way that gets handled is
 * `?? 0` — which would silently swallow a genuinely missing key if the
 * shape ever changed.
 */
export interface ScoreDistribution {
  readonly 1: number;
  readonly 2: number;
  readonly 3: number;
  readonly 4: number;
  readonly 5: number;
}

type MutableDistribution = { -readonly [K in keyof ScoreDistribution]: number };

function emptyDistribution(): MutableDistribution {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

/**
 * The five points of the scale, strongest first.
 *
 * Exported so the survey renders the scale by walking this rather than by
 * writing its own list of five numbers. A hand-written list in the prompt
 * could drop a point or reorder it and nothing would fail — every score
 * would still be valid and every aggregate would still compute.
 */
export const SCALE_POINTS = [5, 4, 3, 2, 1] as const satisfies readonly (keyof ScoreDistribution)[];

/**
 * Rolls scored firings up per entry.
 *
 * Invalid scores are **dropped rather than clamped**. Clamping a 7 to a 5
 * would invent an opinion nobody expressed and would do it in the direction
 * that hides a bug; dropping it leaves the aggregate honest and leaves the
 * count able to disagree with the caller's expectations, which is how the
 * bad row gets noticed at all.
 *
 * Sorted by entry id so the output is stable — a report whose row order
 * changes between runs is one whose diffs cannot be read.
 */
export function summariseScores(firings: readonly ScoredFiring[]): EntryScoreSummary[] {
  const byEntry = new Map<string, { scores: number[]; notes: string[] }>();

  for (const firing of firings) {
    if (!isValidInterventionScore(firing.score)) continue;
    const bucket = byEntry.get(firing.entryId) ?? { scores: [], notes: [] };
    bucket.scores.push(firing.score);
    if (firing.note !== undefined && firing.note.trim() !== "") {
      bucket.notes.push(firing.note.trim());
    }
    byEntry.set(firing.entryId, bucket);
  }

  const summaries: EntryScoreSummary[] = [];
  for (const [entryId, bucket] of byEntry) {
    const distribution = emptyDistribution();
    let total = 0;
    for (const score of bucket.scores) {
      // `isValidInterventionScore` already narrowed every score to an
      // integer 1-5 on the way in, which is exactly `keyof
      // ScoreDistribution` — but that check lives in a type guard returning
      // `value is number`, so the assertion restates what it established
      // rather than assuming anything new.
      distribution[score as keyof ScoreDistribution] += 1;
      total += score;
    }
    const count = bucket.scores.length;
    summaries.push({
      entryId,
      count,
      mean: total / count,
      distribution,
      removalSignals: distribution[1],
      unhelpful: distribution[1] + distribution[2],
      notes: bucket.notes,
    });
  }

  return summaries.sort((a, b) => a.entryId.localeCompare(b.entryId));
}

/**
 * How many scores an entry needs before its aggregate is worth acting on.
 *
 * Three, and the number is a judgement rather than a calculation: one bad
 * firing is an anecdote and two is a coincidence, while waiting for ten
 * would mean an entry that is wrong on every firing survives a fortnight of
 * being wrong. It is exported so the threshold is visible to a reader and
 * settable by a caller with more data than this default assumes.
 */
export const DEFAULT_REVIEW_THRESHOLD = 3;

/**
 * The mean at or below which an entry is flagged for review.
 *
 * 2.5 — below the neutral 3, so an entry has to be *actively* unhelpful on
 * balance rather than merely unremarkable. An entry averaging exactly 3 is
 * doing what a 3 says it does: helping slightly. That is not grounds for
 * removal, and a threshold that flagged it would bury the entries that are
 * genuinely wrong under a list of entries that are merely modest.
 */
export const DEFAULT_REVIEW_MEAN = 2.5;

/** An entry the scores say should be looked at, and why. */
export interface FlaggedEntry {
  readonly entryId: string;
  readonly summary: EntryScoreSummary;
  /** Plain-language statement of what triggered the flag. */
  readonly reason: string;
}

export interface FlagOptions {
  /** Minimum scores before an entry can be flagged. Default 3. */
  readonly threshold?: number;
  /** Mean at or below which an entry is flagged. Default 2.5. */
  readonly meanAtOrBelow?: number;
}

/**
 * Picks out the entries worth a maintainer's attention.
 *
 * Two independent triggers, because they catch different failures and one
 * would miss the other:
 *
 *   - **A low mean** — the entry is unhelpful on balance. This is the
 *     ordinary case and the one the scale was designed for.
 *   - **Any removal signal at all**, regardless of mean. A single 1 is a
 *     rater saying the entry did active harm, and an entry that is
 *     brilliant nine times and harmful once is *not* averaging out — the
 *     harm is usually a detection firing outside its intended scope, and
 *     averaging it into a comfortable 4.2 is exactly how it stays shipped.
 *     This is the trigger the corpus argued for: the guard whose message
 *     told a caller to kill by pid and then refused a pid-scoped kill was
 *     correct in intent and correct on most firings.
 *
 * Both still respect the count threshold. An entry with one score has not
 * been observed enough to act on either way, and flagging on a single 1
 * would turn one frustrated rater into a removal.
 */
export function flagEntriesForReview(
  summaries: readonly EntryScoreSummary[],
  options: FlagOptions = {},
): FlaggedEntry[] {
  const threshold = options.threshold ?? DEFAULT_REVIEW_THRESHOLD;
  const meanAtOrBelow = options.meanAtOrBelow ?? DEFAULT_REVIEW_MEAN;

  const flagged: FlaggedEntry[] = [];
  for (const summary of summaries) {
    if (summary.count < threshold) continue;

    const reasons: string[] = [];
    if (summary.mean <= meanAtOrBelow) {
      reasons.push(`mean ${summary.mean.toFixed(2)} over ${summary.count} ratings`);
    }
    if (summary.removalSignals > 0) {
      reasons.push(
        summary.removalSignals === 1
          ? "1 rater asked for it to be removed"
          : `${summary.removalSignals} raters asked for it to be removed`,
      );
    }
    if (reasons.length === 0) continue;

    flagged.push({ entryId: summary.entryId, summary, reason: reasons.join("; ") });
  }

  // Worst first: the entry a maintainer should read about is the one with
  // the lowest mean, not the one whose id sorts first.
  return flagged.sort((a, b) => a.summary.mean - b.summary.mean);
}
