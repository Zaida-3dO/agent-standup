// Scoring how a run went — `src/lib/scoring/run-scores.ts`.
//
// MILESTONES.md #66. Two scores per facet, the agent's frozen, accepting
// copies it to the person's. These properties are the ways an
// implementation quietly stops being evidence:
//
//   - letting an agent score be overwritten, which destroys the delta that
//     is the entire reason there are two columns,
//   - collapsing "nobody looked" into "looked and agreed", which biases the
//     learning signal toward failures,
//   - reporting only a mean, which averages a discarded run into a
//     comfortable number,
//   - clamping an out-of-range score, which invents an opinion,
//   - flagging on a single score, which turns one bad run into a verdict on
//     a model tier.
//
// The third has teeth and is the one this milestone argued for: a single 1
// among many 4s is the signal, and a mean-only report hides it.
//
// Every assertion is against a literal array. No fixture, no database —
// which is what `run-scores.ts` holding no client buys.
//
// Fixture values are deliberately DIFFERENT per field. A fixture whose
// agent and user scores are the same number cannot tell a function that
// reads the wrong one from a correct one.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_REVIEW_MEAN,
  DEFAULT_RUN_REVIEW_THRESHOLD,
  FACETS,
  MAX_RUN_SCORE,
  MIN_RUN_SCORE,
  RUN_SCALE_POINTS,
  RUN_SCORE_MEANINGS,
  agreementOf,
  checkAgentScoreWritable,
  deltaOf,
  flagFacetsForReview,
  isFacet,
  isValidRunScore,
  scoreFrom,
  summariseRunScores,
  type Facet,
  type RunFacetScore,
} from "@/lib/scoring/run-scores";

/** One row, with both scores stated explicitly so no default can hide a bug. */
function row(facet: Facet, agentScore: number | null, userScore: number | null): RunFacetScore {
  return { facet, agentScore, userScore };
}

/** `n` rows on one facet carrying an agent score only. */
function agentRows(facet: Facet, score: number, times: number): RunFacetScore[] {
  return Array.from({ length: times }, () => row(facet, score, null));
}

describe("the scale", () => {
  it("is 1 to 5", () => {
    expect(MIN_RUN_SCORE).toBe(1);
    expect(MAX_RUN_SCORE).toBe(5);
  });

  it("names every point on the scale", () => {
    for (const point of [1, 2, 3, 4, 5]) {
      expect(RUN_SCORE_MEANINGS[point]).toBeTypeOf("string");
      expect(RUN_SCORE_MEANINGS[point]!.length).toBeGreaterThan(0);
    }
  });

  it("walks the scale strongest first", () => {
    expect([...RUN_SCALE_POINTS]).toEqual([5, 4, 3, 2, 1]);
  });

  it("accepts only integers within range", () => {
    expect(isValidRunScore(1)).toBe(true);
    expect(isValidRunScore(5)).toBe(true);
    expect(isValidRunScore(0)).toBe(false);
    expect(isValidRunScore(6)).toBe(false);
    // A 4.5 is not a point on this scale; averaging it in would produce an
    // aggregate no rater expressed.
    expect(isValidRunScore(4.5)).toBe(false);
    expect(isValidRunScore("4")).toBe(false);
    expect(isValidRunScore(null)).toBe(false);
  });

  it("knows the six facets and rejects anything else", () => {
    expect([...FACETS]).toEqual([
      "reasoning",
      "breadth",
      "precision",
      "autonomy",
      "visual",
      "writing",
    ]);
    expect(isFacet("reasoning")).toBe(true);
    expect(isFacet("speed")).toBe(false);
  });
});

describe("the agent score is frozen", () => {
  it("allows the first write, on a row that does not exist yet", () => {
    expect(checkAgentScoreWritable(null, 4)).toBeNull();
  });

  it("allows a write when the row exists but was never graded", () => {
    expect(checkAgentScoreWritable({ agentScore: null }, 4)).toBeNull();
  });

  it("REFUSES an overwrite, which is the whole point of the column", () => {
    const refusal = checkAgentScoreWritable({ agentScore: 5 }, 2);
    expect(refusal).not.toBeNull();
    expect(refusal!.kind).toBe("frozen");
    // The refusal has to say what to do instead, or a caller routes around it.
    expect(refusal!.message).toContain("user score");
  });

  it("refuses re-writing the SAME value, so a retry cannot become a correction", () => {
    const refusal = checkAgentScoreWritable({ agentScore: 3 }, 3);
    expect(refusal).not.toBeNull();
    expect(refusal!.kind).toBe("frozen");
  });

  it("refuses an out-of-range score with a DIFFERENT reason than a frozen one", () => {
    const refusal = checkAgentScoreWritable(null, 9);
    expect(refusal).not.toBeNull();
    expect(refusal!.kind).toBe("invalid");
  });

  it("reports the range refusal before the freeze refusal is even reachable", () => {
    // Both wrong at once: an invalid score against an already-frozen row.
    // The caller has to fix the number regardless, so that is the reason given.
    const refusal = checkAgentScoreWritable({ agentScore: 3 }, 0);
    expect(refusal!.kind).toBe("invalid");
  });
});

describe("agreement between the two scores", () => {
  it("tells 'nobody graded it' from 'nobody looked'", () => {
    // These are opposite data points and collapsing them biases the signal.
    expect(agreementOf(row("reasoning", null, null))).toBe("unscored");
    expect(agreementOf(row("reasoning", 4, null))).toBe("unreviewed");
  });

  it("reads an equal user score as agreement, not as absence", () => {
    expect(agreementOf(row("reasoning", 4, 4))).toBe("agreed");
  });

  it("reads a different user score as a correction", () => {
    expect(agreementOf(row("reasoning", 5, 2))).toBe("corrected");
  });

  it("gives a signed delta, negative when the agent over-rated itself", () => {
    expect(deltaOf(row("reasoning", 5, 2))).toBe(-3);
    expect(deltaOf(row("reasoning", 2, 5))).toBe(3);
    expect(deltaOf(row("reasoning", 4, 4))).toBe(0);
  });

  it("gives no delta when either side is missing, rather than a zero", () => {
    // A zero would be indistinguishable from agreement.
    expect(deltaOf(row("reasoning", 4, null))).toBeNull();
    expect(deltaOf(row("reasoning", null, 4))).toBeNull();
  });
});

describe("which score an aggregate reads", () => {
  // Different values per field: a fixture using the same number twice
  // cannot tell these three apart.
  const both = row("reasoning", 5, 2);

  it("reads each source distinctly", () => {
    expect(scoreFrom(both, "agent")).toBe(5);
    expect(scoreFrom(both, "user")).toBe(2);
    // Effective prefers the person's judgement.
    expect(scoreFrom(both, "effective")).toBe(2);
  });

  it("falls back to the agent score only when no person scored", () => {
    expect(scoreFrom(row("reasoning", 5, null), "effective")).toBe(5);
    expect(scoreFrom(row("reasoning", 5, null), "user")).toBeNull();
  });
});

describe("summarising preserves the distribution", () => {
  it("keeps the buckets alongside the mean", () => {
    // A 5 and a 1 average to 3, and so do three honest 3s. The mean cannot
    // tell them apart; the distribution can, and that is why it is kept.
    const volatile = summariseRunScores(
      [row("reasoning", 5, null), row("reasoning", 1, null), row("reasoning", 3, null)],
      "agent",
    );
    const steady = summariseRunScores(agentRows("reasoning", 3, 3), "agent");

    expect(volatile[0]!.mean).toBe(3);
    expect(steady[0]!.mean).toBe(3);
    // Identical means, different distributions.
    expect(volatile[0]!.distribution).toEqual({ 1: 1, 2: 0, 3: 1, 4: 0, 5: 1 });
    expect(steady[0]!.distribution).toEqual({ 1: 0, 2: 0, 3: 3, 4: 0, 5: 0 });
  });

  it("counts the poor and weak tails separately", () => {
    const [summary] = summariseRunScores(
      [
        row("precision", 1, null),
        row("precision", 2, null),
        row("precision", 2, null),
        row("precision", 5, null),
      ],
      "agent",
    );
    // A 1 says the work was unusable; a 2 says it needed correcting. Folding
    // them together would lose the strongest thing a rater can say.
    expect(summary!.poor).toBe(1);
    expect(summary!.weak).toBe(3);
    expect(summary!.count).toBe(4);
  });

  it("drops an out-of-range score rather than clamping it", () => {
    // Clamping a 9 to a 5 would invent an opinion nobody expressed, in the
    // direction that hides the bug.
    const [summary] = summariseRunScores(
      [row("reasoning", 9, null), row("reasoning", 4, null)],
      "agent",
    );
    expect(summary!.count).toBe(1);
    expect(summary!.mean).toBe(4);
  });

  it("returns nothing for a facet with no score at all", () => {
    expect(summariseRunScores([], "agent")).toEqual([]);
    // A row graded by nobody contributes nothing under either source.
    expect(summariseRunScores([row("visual", null, null)], "agent")).toEqual([]);
  });

  it("separates facets and orders them stably", () => {
    const summaries = summariseRunScores(
      [row("writing", 2, null), row("autonomy", 4, null), row("breadth", 5, null)],
      "agent",
    );
    expect(summaries.map((s) => s.facet)).toEqual(["autonomy", "breadth", "writing"]);
    // Each facet keeps its own score rather than pooling them.
    expect(summaries.map((s) => s.mean)).toEqual([4, 5, 2]);
  });

  it("counts reviewed and corrected from the row, not from the aggregated value", () => {
    // Under `effective` the aggregated number IS the user's score, so a
    // reader deriving agreement from it would call every reviewed row agreed.
    const [summary] = summariseRunScores(
      [
        row("reasoning", 5, 2), // corrected downward
        row("reasoning", 4, 4), // agreed
        row("reasoning", 3, null), // nobody looked
      ],
      "effective",
    );
    expect(summary!.count).toBe(3);
    expect(summary!.reviewed).toBe(2);
    expect(summary!.corrected).toBe(1);
    // Effective scores are 2, 4, 3.
    expect(summary!.mean).toBe(3);
  });

  it("averages the delta only over rows a person actually scored", () => {
    const [summary] = summariseRunScores(
      [row("reasoning", 5, 2), row("reasoning", 4, 3), row("reasoning", 1, null)],
      "effective",
    );
    // Deltas are -3 and -1; the unreviewed row contributes nothing.
    expect(summary!.meanDelta).toBe(-2);
  });

  it("gives no mean delta when nobody reviewed, rather than a zero", () => {
    const [summary] = summariseRunScores(agentRows("reasoning", 4, 3), "agent");
    expect(summary!.meanDelta).toBeNull();
  });
});

describe("flagging the facets worth attention", () => {
  it("flags a single 1 among many 4s, which a mean would hide", () => {
    // The property this milestone argued for. Nine 4s and one 1 average to
    // 3.7 — comfortably above any sane mean threshold.
    const rows = [...agentRows("reasoning", 4, 9), row("reasoning", 1, null)];
    const summaries = summariseRunScores(rows, "agent");
    expect(summaries[0]!.mean).toBeGreaterThan(DEFAULT_RUN_REVIEW_MEAN);

    const flagged = flagFacetsForReview(summaries);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.facet).toBe("reasoning");
    expect(flagged[0]!.reason).toContain("scored 1");
  });

  it("flags a low mean even with no 1s at all", () => {
    const flagged = flagFacetsForReview(summariseRunScores(agentRows("breadth", 2, 4), "agent"));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toContain("mean");
  });

  it("does not flag a facet doing what a 3 says it does", () => {
    // A mean of exactly 3 is unremarkable, not grounds for action.
    expect(flagFacetsForReview(summariseRunScores(agentRows("writing", 3, 5), "agent"))).toEqual(
      [],
    );
  });

  it("does not flag below the count threshold, however bad the scores", () => {
    // One frustrated rating is an anecdote, not a verdict on a model tier.
    const rows = agentRows("visual", 1, DEFAULT_RUN_REVIEW_THRESHOLD - 1);
    expect(flagFacetsForReview(summariseRunScores(rows, "agent"))).toEqual([]);
    // One more of the same score crosses it.
    const enough = agentRows("visual", 1, DEFAULT_RUN_REVIEW_THRESHOLD);
    expect(flagFacetsForReview(summariseRunScores(enough, "agent"))).toHaveLength(1);
  });

  it("flags an agent that over-rates itself even when the mean looks fine", () => {
    // Every run corrected downward, but the effective mean is the person's
    // score, so the mean alone reads as acceptable.
    const rows = [row("autonomy", 5, 4), row("autonomy", 5, 4), row("autonomy", 5, 4)];
    const summaries = summariseRunScores(rows, "effective");
    expect(summaries[0]!.mean).toBe(4);
    expect(summaries[0]!.mean).toBeGreaterThan(DEFAULT_RUN_REVIEW_MEAN);

    const flagged = flagFacetsForReview(summaries);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toContain("over-rated");
  });

  it("does not flag an agent a person corrected UPWARD", () => {
    // Under-rating its own work is not the failure mode being watched for.
    const rows = [row("autonomy", 3, 5), row("autonomy", 3, 5), row("autonomy", 3, 5)];
    expect(flagFacetsForReview(summariseRunScores(rows, "effective"))).toEqual([]);
  });

  it("orders the flagged facets worst first", () => {
    const rows = [...agentRows("breadth", 2, 3), ...agentRows("reasoning", 1, 3)];
    const flagged = flagFacetsForReview(summariseRunScores(rows, "agent"));
    expect(flagged.map((f) => f.facet)).toEqual(["reasoning", "breadth"]);
  });

  it("respects a caller-supplied threshold", () => {
    const rows = agentRows("visual", 1, 3);
    expect(flagFacetsForReview(summariseRunScores(rows, "agent"), { threshold: 4 })).toEqual([]);
  });

  it("gives every reason that applies, not just the first", () => {
    // Low mean AND a 1 AND a downward correction, all at once.
    const rows = [row("precision", 2, 1), row("precision", 3, 1), row("precision", 2, 2)];
    const flagged = flagFacetsForReview(summariseRunScores(rows, "effective"));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toContain("mean");
    expect(flagged[0]!.reason).toContain("scored 1");
    expect(flagged[0]!.reason).toContain("over-rated");
  });
});
