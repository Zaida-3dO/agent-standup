// The picker's override rule and its policy — MILESTONES.md #70 and #71.
//
// The two properties these tests exist to hold:
//
//   - **An override is recorded, never refused** (#70). Nothing in
//     `resolveSelection` or `overrideDiscouragement` may return a refusal,
//     and the recommendation's strength must survive onto an overridden run
//     — that is what makes overrides gradeable later.
//   - **No experiment runs on risky work** (#71), and risk is checked
//     *before* the rate, so an explore rate of 1.0 still cannot reach a P0.
//     That ordering is the safety property and is asserted directly.
import { describe, expect, it } from "vitest";
import {
  isSelectionReason,
  isValidStrength,
  overrideDiscouragement,
  overrideLacksReason,
  resolveSelection,
  type Recommendation,
} from "@/lib/picker/selection";
import {
  DEFAULT_HIGH_DIFFICULTY,
  MAX_STRENGTH,
  MIN_STRENGTH,
  mayExperiment,
  recommendationStrength,
  riskBandFor,
  shouldExperiment,
  type RiskInputs,
} from "@/lib/picker/policy";
import type { FacetScoreSummary } from "@/lib/scoring/run-scores";

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    model: "tier-a",
    effort: "high",
    strength: 0.8,
    rationale: "this area has gone well at this tier",
    ...overrides,
  };
}

/** A low-risk item — every field deliberately at its least risky value. */
function item(overrides: Partial<RiskInputs> = {}): RiskInputs {
  return {
    priority: "P3",
    mergeAuthority: "pre_approved",
    needsVisualReview: false,
    difficulty: { reasoning: 2 },
    ...overrides,
  };
}

function summary(overrides: Partial<FacetScoreSummary> = {}): FacetScoreSummary {
  return {
    facet: "reasoning",
    count: 10,
    mean: 4,
    distribution: { 1: 0, 2: 0, 3: 2, 4: 6, 5: 2 },
    poor: 0,
    weak: 0,
    reviewed: 4,
    corrected: 1,
    meanDelta: 0,
    ...overrides,
  };
}

describe("resolveSelection — recording what was chosen and why", () => {
  it("records a matching choice as recommended, keeping the strength", () => {
    const selection = resolveSelection({
      chosenModel: "tier-a",
      chosenEffort: "high",
      recommendation: recommendation({ strength: 0.77 }),
    });
    expect(selection.reason).toBe("recommended");
    expect(selection.recommendationStrength).toBe(0.77);
    expect(selection.overrideReason).toBeNull();
  });

  it("records a different choice as an override and keeps the reason given", () => {
    const selection = resolveSelection({
      chosenModel: "tier-b",
      chosenEffort: "low",
      recommendation: recommendation(),
      overrideReason: "this one is mostly mechanical",
    });
    expect(selection.reason).toBe("override");
    expect(selection.overrideReason).toBe("this one is mostly mechanical");
    expect(selection.model).toBe("tier-b");
    expect(selection.effort).toBe("low");
  });

  it("keeps the recommendation's strength on an override", () => {
    // The valuable half of #70: an override against a confident
    // recommendation says something different from one against a guess,
    // and dropping the strength would destroy that distinction.
    const selection = resolveSelection({
      chosenModel: "tier-b",
      chosenEffort: "high",
      recommendation: recommendation({ strength: 0.91 }),
      overrideReason: "known tricky area",
    });
    expect(selection.reason).toBe("override");
    expect(selection.recommendationStrength).toBe(0.91);
  });

  it("counts a differing effort at the same model as an override", () => {
    const selection = resolveSelection({
      chosenModel: "tier-a",
      chosenEffort: "low",
      recommendation: recommendation({ model: "tier-a", effort: "high" }),
    });
    expect(selection.reason).toBe("override");
  });

  it("records no reason at all when nothing was recommended", () => {
    // Not `override` — there was nothing to override. SCHEMA.md §1084:
    // null is both the truthful value and the excludable one.
    const selection = resolveSelection({
      chosenModel: "tier-b",
      chosenEffort: "low",
      recommendation: null,
    });
    expect(selection.reason).toBeNull();
    expect(selection.recommendationStrength).toBeNull();
  });

  it("records a pin as pinned rather than as an override", () => {
    const selection = resolveSelection({
      chosenModel: "tier-c",
      chosenEffort: "low",
      recommendation: recommendation(),
      pinned: true,
    });
    expect(selection.reason).toBe("pinned");
    expect(selection.overrideReason).toBeNull();
  });

  it("records a deliberate experiment as exploration, not as an ordinary recommendation", () => {
    const selection = resolveSelection({
      chosenModel: "tier-c",
      chosenEffort: "low",
      recommendation: recommendation({ model: "tier-c", effort: "low", strength: 0.3 }),
      exploration: true,
    });
    expect(selection.reason).toBe("exploration");
  });

  it("normalises a blank override reason to null", () => {
    const selection = resolveSelection({
      chosenModel: "tier-b",
      chosenEffort: "high",
      recommendation: recommendation(),
      overrideReason: "   ",
    });
    expect(selection.overrideReason).toBeNull();
    expect(overrideLacksReason(selection)).toBe(true);
  });

  it("does not report a missing reason on a run that was not an override", () => {
    const selection = resolveSelection({
      chosenModel: "tier-a",
      chosenEffort: "high",
      recommendation: recommendation(),
    });
    expect(overrideLacksReason(selection)).toBe(false);
  });
});

describe("overrideDiscouragement — discourages, never refuses", () => {
  it("returns text naming the recommendation and asking for a reason", () => {
    const text = overrideDiscouragement(
      recommendation({ model: "tier-a", effort: "high", strength: 0.82 }),
      "tier-b",
      "low",
    );
    expect(text).toContain("tier-a");
    expect(text).toContain("tier-b");
    expect(text).toContain("0.82");
    // The word that makes this a discouragement rather than a block.
    expect(text).toContain("allowed");
  });

  it("says nothing when the choice matches the recommendation", () => {
    expect(overrideDiscouragement(recommendation(), "tier-a", "high")).toBeNull();
  });

  it("says nothing when there was no recommendation to argue with", () => {
    expect(overrideDiscouragement(null, "tier-b", "low")).toBeNull();
  });
});

describe("riskBandFor — what an experiment may not touch", () => {
  it("calls a P0 high risk", () => {
    expect(riskBandFor(item({ priority: "P0" }))).toBe("high");
  });

  it("calls work needing a person's approval high risk", () => {
    expect(riskBandFor(item({ mergeAuthority: "needs_approval" }))).toBe("high");
  });

  it("calls a hard facet high risk however low the priority", () => {
    expect(riskBandFor(item({ difficulty: { precision: DEFAULT_HIGH_DIFFICULTY } }))).toBe("high");
  });

  it("calls a P1 medium and visual review medium", () => {
    expect(riskBandFor(item({ priority: "P1" }))).toBe("medium");
    expect(riskBandFor(item({ needsVisualReview: true }))).toBe("medium");
  });

  it("calls ordinary low-priority work low risk", () => {
    expect(riskBandFor(item())).toBe("low");
    expect(riskBandFor(item({ priority: "P2" }))).toBe("low");
  });

  it("takes the strictest band when several signals disagree", () => {
    // P0 outranks the pre-approved merge and the easy facet.
    expect(riskBandFor(item({ priority: "P0", difficulty: { reasoning: 1 } }))).toBe("high");
  });

  it("ignores a malformed difficulty rather than reading it as danger", () => {
    const malformed = { difficulty: { reasoning: Number.NaN } } as unknown as Partial<RiskInputs>;
    expect(riskBandFor(item(malformed))).toBe("low");
  });

  it("honours a caller-supplied difficulty threshold", () => {
    const three = item({ difficulty: { breadth: 3 } });
    expect(riskBandFor(three)).toBe("low");
    expect(riskBandFor(three, 3)).toBe("high");
  });
});

describe("shouldExperiment — the safety property", () => {
  it("never experiments on high-risk work, even at a rate of 1", () => {
    // The property, stated as directly as it can be: the rate cannot
    // override the risk check, because risk is consulted first. A mutant
    // reordering those two checks fails here and nowhere else.
    expect(
      shouldExperiment({
        enabled: true,
        exploreRate: 1,
        item: item({ priority: "P0" }),
        draw: 0,
      }),
    ).toBe(false);
    expect(
      shouldExperiment({
        enabled: true,
        exploreRate: 1,
        item: item({ mergeAuthority: "needs_approval" }),
        draw: 0,
      }),
    ).toBe(false);
  });

  it("never experiments on medium-risk work either", () => {
    expect(
      shouldExperiment({
        enabled: true,
        exploreRate: 1,
        item: item({ priority: "P1" }),
        draw: 0,
      }),
    ).toBe(false);
  });

  it("experiments on low-risk work when the draw falls under the rate", () => {
    expect(shouldExperiment({ enabled: true, exploreRate: 0.25, item: item(), draw: 0.1 })).toBe(
      true,
    );
  });

  it("does not experiment when the draw is at or above the rate", () => {
    // Boundary: a draw exactly at the rate must not experiment, or a rate
    // of 0 would fire on a draw of 0.
    expect(shouldExperiment({ enabled: true, exploreRate: 0.25, item: item(), draw: 0.25 })).toBe(
      false,
    );
  });

  it("ships switched off — a rate of zero never experiments", () => {
    expect(shouldExperiment({ enabled: true, exploreRate: 0, item: item(), draw: 0 })).toBe(false);
  });

  it("does nothing at all while the picker is disabled", () => {
    expect(shouldExperiment({ enabled: false, exploreRate: 1, item: item(), draw: 0 })).toBe(false);
  });

  it("agrees with mayExperiment about which work is eligible", () => {
    expect(mayExperiment(item())).toBe(true);
    expect(mayExperiment(item({ priority: "P0" }))).toBe(false);
  });
});

describe("recommendationStrength — the distribution, not just the mean", () => {
  it("recommends a consistently good tier strongly", () => {
    const strength = recommendationStrength(
      summary({ mean: 4.5, distribution: { 1: 0, 2: 0, 3: 0, 4: 5, 5: 5 }, count: 10, poor: 0 }),
    );
    expect(strength).toBeGreaterThan(0.8);
  });

  it("cuts confidence for a single unusable run the mean would hide", () => {
    // Nine 5s and one 1: mean 4.6, which alone would recommend at near
    // maximum. The 1 is the run that was discarded and is exactly the
    // information the scores exist to preserve.
    const clean = recommendationStrength(
      summary({ mean: 4.6, distribution: { 1: 0, 2: 0, 3: 0, 4: 4, 5: 6 }, count: 10, poor: 0 }),
    );
    const withOnePoor = recommendationStrength(
      summary({ mean: 4.6, distribution: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 9 }, count: 10, poor: 1 }),
    );
    expect(withOnePoor).toBeLessThan(clean);
    // And the size of the cut is real, not a rounding artefact.
    expect(clean - withOnePoor).toBeGreaterThan(0.1);
  });

  it("all but eliminates a recommendation after repeated unusable runs", () => {
    const strength = recommendationStrength(
      summary({ mean: 3, distribution: { 1: 3, 2: 0, 3: 4, 4: 0, 5: 3 }, count: 10, poor: 3 }),
    );
    expect(strength).toBeLessThan(0.2);
  });

  it("reports the minimum on too little evidence rather than a lucky result", () => {
    // One run at a perfect 5 is an anecdote, not a recommendation.
    const strength = recommendationStrength(
      summary({ mean: 5, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }, count: 1, poor: 0 }),
    );
    expect(strength).toBe(MIN_STRENGTH);
  });

  it("reports the minimum when there is no history at all", () => {
    expect(recommendationStrength(null)).toBe(MIN_STRENGTH);
  });

  it("never reaches certainty, however good the history", () => {
    const strength = recommendationStrength(
      summary({ mean: 5, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 40 }, count: 40, poor: 0 }),
    );
    expect(strength).toBeLessThanOrEqual(MAX_STRENGTH);
  });

  it("never falls below the floor, however bad the history", () => {
    const strength = recommendationStrength(
      summary({ mean: 1, distribution: { 1: 20, 2: 0, 3: 0, 4: 0, 5: 0 }, count: 20, poor: 20 }),
    );
    expect(strength).toBe(MIN_STRENGTH);
  });

  it("honours caller-supplied thresholds over the defaults", () => {
    const twoRuns = summary({
      mean: 4,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 2, 5: 0 },
      count: 2,
      poor: 0,
    });
    expect(recommendationStrength(twoRuns)).toBe(MIN_STRENGTH);
    expect(recommendationStrength(twoRuns, { minObservations: 2 })).toBeGreaterThan(MIN_STRENGTH);
  });
});

describe("the selection vocabulary", () => {
  it("recognises exactly the four reasons", () => {
    expect(isSelectionReason("override")).toBe(true);
    expect(isSelectionReason("exploration")).toBe(true);
    expect(isSelectionReason("guessed")).toBe(false);
  });

  it("accepts only a confidence in range", () => {
    expect(isValidStrength(0)).toBe(true);
    expect(isValidStrength(1)).toBe(true);
    expect(isValidStrength(1.5)).toBe(false);
    expect(isValidStrength(Number.NaN)).toBe(false);
  });
});
