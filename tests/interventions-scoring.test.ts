// Scoring the catalogue — `src/lib/interventions/scoring.ts`.
//
// The evidence loop exists because the guard surface only ever grew: every
// incident added an entry and nothing ever removed one. These properties are
// the ways a scoring implementation quietly stops being evidence:
//
//   - paraphrasing the owner's scale, so scores stop meaning what he asked,
//   - clamping an out-of-range score, which invents an opinion,
//   - reporting only a mean, which averages a harmful firing into a
//     comfortable number,
//   - flagging on a single bad rating, which turns one frustration into a
//     removal.
//
// The third has teeth and is the one the corpus argued for: the firing that
// most deserved a 1 in this installation's history belonged to a guard that
// was correct on nearly every other firing. A mean-only flag would never
// have surfaced it.
//
// Every assertion is against a literal array. There is no fixture and no
// database here, which is what `scoring.ts` holding no client buys.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_MEAN,
  DEFAULT_REVIEW_THRESHOLD,
  INTERVENTION_SCORE_MEANINGS,
  MAX_INTERVENTION_SCORE,
  MIN_INTERVENTION_SCORE,
  SCALE_POINTS,
  flagEntriesForReview,
  isRemovalSignal,
  isValidInterventionScore,
  summariseScores,
  type ScoredFiring,
} from "@/lib/interventions/scoring";

/** Builds `n` scored firings for one entry, all with the same score. */
function firings(entryId: string, score: number, times: number): ScoredFiring[] {
  return Array.from({ length: times }, () => ({ entryId, score }));
}

describe("the scale", () => {
  // Kills: deleting any one line from INTERVENTION_SCORE_MEANINGS, or
  // changing a key. A five-point scale missing a point still validates and
  // still aggregates — it just silently cannot express one of the answers.
  it("defines all five points", () => {
    expect(Object.keys(INTERVENTION_SCORE_MEANINGS).sort()).toEqual(["1", "2", "3", "4", "5"]);
  });

  // Kills: rewording 1 to drop "remove", or 4 to drop the "wasn't about to
  // do anything dangerous" clause. This is the test that stops a later
  // tidy-up turning the owner's scale into a generic usefulness ladder —
  // the paraphrase would read as the same scale, and every aggregate would
  // still compute, while meaning something he never asked for.
  it("keeps the two distinctions the owner's wording turns on", () => {
    // A 1 demands removal; that is what separates it from a 2.
    expect(INTERVENTION_SCORE_MEANINGS[1]).toMatch(/remove/i);
    // A 4 is bounded by not having been in danger; that is what separates
    // it from a 5, which is about danger averted rather than time saved.
    expect(INTERVENTION_SCORE_MEANINGS[5]).toMatch(/wrong path|incorrect/i);
    expect(INTERVENTION_SCORE_MEANINGS[4]).toMatch(/dangerous/i);
    // A 3 is the "I'd have got there myself" line, not "no opinion".
    expect(INTERVENTION_SCORE_MEANINGS[3]).toMatch(/figured it out myself/i);
    // A 2 is about being actively misled, not merely unhelpful.
    expect(INTERVENTION_SCORE_MEANINGS[2]).toMatch(/incorrect or misleading/i);
  });

  // Kills: dropping a point from SCALE_POINTS, or reordering it to ascend.
  // The survey renders its prompt from this, so a missing point is a point
  // the rater is never offered — and nothing else would fail.
  it("lists every point, strongest first, for the prompt to render", () => {
    expect([...SCALE_POINTS]).toEqual([5, 4, 3, 2, 1]);
    for (const point of SCALE_POINTS) {
      expect(INTERVENTION_SCORE_MEANINGS[point]).toBeDefined();
    }
  });
});

describe("isValidInterventionScore", () => {
  // Kills: `>=` → `>` or `<=` → `<` on either bound. Both endpoints are
  // real answers on this scale and an off-by-one at either end silently
  // discards the two most decisive ratings.
  it("accepts both endpoints", () => {
    expect(isValidInterventionScore(MIN_INTERVENTION_SCORE)).toBe(true);
    expect(isValidInterventionScore(MAX_INTERVENTION_SCORE)).toBe(true);
  });

  // Kills: widening either bound.
  it("rejects values outside the scale", () => {
    expect(isValidInterventionScore(0)).toBe(false);
    expect(isValidInterventionScore(6)).toBe(false);
    expect(isValidInterventionScore(-1)).toBe(false);
  });

  // Kills: dropping the `Number.isInteger` check. A 4.5 would then average
  // in as an opinion no rater expressed.
  it("rejects a non-integer", () => {
    expect(isValidInterventionScore(4.5)).toBe(false);
  });

  // Kills: dropping the typeof check. "5" from a JSON reply would otherwise
  // pass a naive range comparison through coercion.
  it("rejects a numeric string and other non-numbers", () => {
    expect(isValidInterventionScore("5")).toBe(false);
    expect(isValidInterventionScore(null)).toBe(false);
    expect(isValidInterventionScore(undefined)).toBe(false);
    expect(isValidInterventionScore(Number.NaN)).toBe(false);
  });
});

describe("isRemovalSignal", () => {
  // Kills: `=== 1` → `<= 2`. Folding a 2 into the removal signal makes the
  // strongest thing a rater can say indistinguishable from the second
  // strongest — and, via flagEntriesForReview's second trigger, would flag
  // every entry anyone ever found merely unhelpful.
  it("is the 1 alone, never the 2", () => {
    expect(isRemovalSignal(1)).toBe(true);
    expect(isRemovalSignal(2)).toBe(false);
    expect(isRemovalSignal(3)).toBe(false);
  });
});

describe("summariseScores", () => {
  // Kills: computing the mean as a sum, or dividing by the wrong count.
  it("counts, means and distributes", () => {
    const [summary] = summariseScores([
      { entryId: "I10", score: 5 },
      { entryId: "I10", score: 3 },
      { entryId: "I10", score: 1 },
    ]);

    expect(summary?.count).toBe(3);
    expect(summary?.mean).toBe(3);
    expect(summary?.distribution).toEqual({ 1: 1, 2: 0, 3: 1, 4: 0, 5: 1 });
  });

  // Kills: `continue` → clamp, in `summariseScores`. Clamping a 7 to a 5
  // would invent an opinion nobody expressed, in the direction that hides
  // the bug that produced it.
  it("drops an invalid score rather than clamping it", () => {
    const [summary] = summariseScores([
      { entryId: "I10", score: 4 },
      { entryId: "I10", score: 7 },
      { entryId: "I10", score: 0 },
    ]);

    expect(summary?.count).toBe(1);
    expect(summary?.mean).toBe(4);
  });

  // Kills: counting 2s into `removalSignals`, or omitting 2s from
  // `unhelpful`. These two fields answer different questions and swapping
  // them would make a merely-unhelpful entry look like one a rater demanded
  // be deleted.
  it("separates removal signals from the unhelpful tail", () => {
    const [summary] = summariseScores([
      { entryId: "I11", score: 1 },
      { entryId: "I11", score: 2 },
      { entryId: "I11", score: 2 },
    ]);

    expect(summary?.removalSignals).toBe(1);
    expect(summary?.unhelpful).toBe(3);
  });

  // Kills: dropping the `.trim() !== ""` guard, which would push whitespace
  // notes into a report a maintainer reads.
  it("keeps real notes and discards blank ones", () => {
    const [summary] = summariseScores([
      { entryId: "I12", score: 2, note: "  told me to kill by pid, then refused a pid kill  " },
      { entryId: "I12", score: 2, note: "   " },
      { entryId: "I12", score: 3 },
    ]);

    expect(summary?.notes).toEqual(["told me to kill by pid, then refused a pid kill"]);
  });

  // Kills: removing the sort. A report whose row order changes between runs
  // is one whose diffs cannot be read.
  it("returns entries in a stable id order", () => {
    const summaries = summariseScores([
      { entryId: "I12", score: 3 },
      { entryId: "I1", score: 3 },
      { entryId: "I10", score: 3 },
    ]);

    expect(summaries.map((summary) => summary.entryId)).toEqual(["I1", "I10", "I12"]);
  });

  // Kills: sharing one distribution object across entries — the classic
  // hoisted-accumulator bug, which would make every entry report every
  // other entry's scores.
  it("keeps entries independent", () => {
    const summaries = summariseScores([
      { entryId: "A", score: 5 },
      { entryId: "B", score: 1 },
    ]);

    expect(summaries[0]?.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 });
    expect(summaries[1]?.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it("is empty for no input", () => {
    expect(summariseScores([])).toEqual([]);
  });
});

describe("flagEntriesForReview", () => {
  // Kills: `<` → `<=` on the count threshold, which would act on an entry
  // with two ratings — a coincidence rather than evidence.
  it("will not flag an entry with too few ratings", () => {
    const summaries = summariseScores(firings("I9", 1, DEFAULT_REVIEW_THRESHOLD - 1));
    expect(flagEntriesForReview(summaries)).toEqual([]);
  });

  // Kills: raising the threshold, or the same `<`/`<=` mutation the other
  // way. Exactly at the threshold an entry becomes actionable.
  it("flags at exactly the threshold", () => {
    const summaries = summariseScores(firings("I9", 1, DEFAULT_REVIEW_THRESHOLD));
    expect(flagEntriesForReview(summaries).map((entry) => entry.entryId)).toEqual(["I9"]);
  });

  // Kills: `<=` → `<` on the mean comparison. An entry sitting exactly on
  // the boundary is one the threshold was chosen to catch.
  it("flags an entry whose mean sits exactly on the boundary", () => {
    // Two 2s and two 3s average exactly 2.5.
    const summaries = summariseScores([...firings("I18", 2, 2), ...firings("I18", 3, 2)]);

    expect(summaries[0]?.mean).toBe(DEFAULT_REVIEW_MEAN);
    expect(flagEntriesForReview(summaries).map((entry) => entry.entryId)).toEqual(["I18"]);
  });

  // Kills: raising the mean threshold to 3. A neutral entry is doing what a
  // 3 says it does — helping slightly — and flagging it would bury the
  // genuinely wrong entries under a list of merely modest ones.
  it("leaves a neutral entry alone", () => {
    const summaries = summariseScores(firings("I1", 3, 5));
    expect(flagEntriesForReview(summaries)).toEqual([]);
  });

  // **The property the corpus argued for**, and the one a mean-only
  // implementation fails. Kills: deleting the `removalSignals > 0` trigger.
  // Nine 5s and one 1 average 4.6 — comfortably above every threshold —
  // yet the 1 is a rater saying the entry did active harm. That is the
  // shape of the kill-guard firing: correct intent, correct on almost every
  // firing, and catastrophic on the one where its message named a remedy it
  // then refused. Averaging that away is exactly how it stayed shipped.
  it("flags a single removal signal even against an excellent mean", () => {
    const summaries = summariseScores([...firings("I12", 5, 9), { entryId: "I12", score: 1 }]);

    expect(summaries[0]?.mean).toBeGreaterThan(4);
    const flagged = flagEntriesForReview(summaries);
    expect(flagged.map((entry) => entry.entryId)).toEqual(["I12"]);
    expect(flagged[0]?.reason).toMatch(/removed/);
  });

  // Kills: pluralising unconditionally, or dropping the count from the
  // reason. The reason is what a maintainer reads instead of the raw rows.
  it("says how many raters asked for removal", () => {
    const one = flagEntriesForReview(
      summariseScores([...firings("A", 5, 9), { entryId: "A", score: 1 }]),
    );
    expect(one[0]?.reason).toContain("1 rater asked");

    const several = flagEntriesForReview(
      summariseScores([...firings("B", 5, 9), ...firings("B", 1, 2)]),
    );
    expect(several[0]?.reason).toContain("2 raters asked");
  });

  // Kills: reporting only one reason when both triggers fire. An entry that
  // is both unhelpful on balance and explicitly rejected is a different
  // case from one that is merely either.
  it("reports both reasons when both triggers fire", () => {
    const flagged = flagEntriesForReview(summariseScores(firings("I2", 1, 4)));
    expect(flagged[0]?.reason).toMatch(/mean 1\.00 over 4 ratings/);
    expect(flagged[0]?.reason).toMatch(/4 raters asked for it to be removed/);
  });

  // Kills: sorting by id, or reversing the comparator. A maintainer reading
  // a truncated list must see the worst entry, not the alphabetically first.
  it("orders the worst entry first", () => {
    const summaries = summariseScores([...firings("A-mild", 2, 3), ...firings("Z-awful", 1, 3)]);

    expect(flagEntriesForReview(summaries).map((entry) => entry.entryId)).toEqual([
      "Z-awful",
      "A-mild",
    ]);
  });

  // Kills: ignoring the caller's threshold and always using the default.
  it("respects a caller's threshold", () => {
    const summaries = summariseScores(firings("I9", 1, 3));
    expect(flagEntriesForReview(summaries, { threshold: 4 })).toEqual([]);
    expect(flagEntriesForReview(summaries, { threshold: 3 })).toHaveLength(1);
  });
});
