// Deriving how a run went — `src/lib/scoring/derived-signal.ts`.
//
// MILESTONES.md #67. The signal comes from what the system already recorded
// rather than from an opinion anybody volunteered. These properties are the
// ways it quietly stops being evidence:
//
//   - reading `Run.blockingFindings`, a column nothing writes, which would
//     score every run in the table as uniformly clean,
//   - scoring a run nobody reviewed, which is arithmetic on no evidence,
//   - counting artifacts instead of rounds, which scores a thoroughly
//     reviewed change as a troubled one,
//   - treating an unrecognised verdict as approval,
//   - burying the weights in the arithmetic, where no caller can revise the
//     judgement without editing the mechanism.
//
// Weights are passed explicitly in most assertions, so a test asserts the
// RULE rather than the default of the day. Where a default is asserted it is
// asserted as the default, deliberately.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNAL_WEIGHTS,
  confidenceFor,
  deriveRunSignal,
  isBlockingVerdict,
  isNitVerdict,
  type RunEvidence,
  type SignalWeights,
} from "@/lib/scoring/derived-signal";

/** Weights with a different value per field, so no two can be confused. */
const WEIGHTS: SignalWeights = {
  perExtraRound: 0.5,
  perBlockingRound: 2,
  perNitRound: 0.25,
  rework: 1,
  perSteering: 0.75,
};

function evidence(over: Partial<RunEvidence> = {}): RunEvidence {
  return { reviews: [], ...over };
}

describe("reading severity from the verdict", () => {
  it("treats a blocking verdict as blocking", () => {
    expect(isBlockingVerdict("changes_required")).toBe(true);
  });

  it("does not treat any approving tier as blocking", () => {
    for (const verdict of ["approved", "lgtm", "lgtm_with_nits", "lgtm_with_followups"]) {
      expect(isBlockingVerdict(verdict)).toBe(false);
    }
  });

  it("treats an absent verdict and the no-verdict label as neither blocking nor clean", () => {
    expect(isBlockingVerdict(null)).toBe(false);
    expect(isBlockingVerdict("na")).toBe(false);
  });

  it("treats an UNRECOGNISED verdict as blocking, which is the safe direction", () => {
    // A verdict added to the enum later must not score as clean until
    // somebody deliberately says it approves.
    expect(isBlockingVerdict("catastrophic")).toBe(true);
  });

  it("picks out the cosmetic tier and only that one", () => {
    expect(isNitVerdict("lgtm_with_nits")).toBe(true);
    expect(isNitVerdict("lgtm")).toBe(false);
    expect(isNitVerdict("lgtm_with_followups")).toBe(false);
  });
});

describe("confidence stands apart from the score", () => {
  it("has none with no rounds, low with one, high beyond", () => {
    expect(confidenceFor(0)).toBe("none");
    expect(confidenceFor(1)).toBe("low");
    expect(confidenceFor(2)).toBe("high");
  });

  it("scores a run with zero review rounds as null, not as clean", () => {
    // The boundary the brief names. Arithmetic alone would return a 5 here,
    // indistinguishable from a genuinely clean review.
    const signal = deriveRunSignal(evidence(), WEIGHTS);
    expect(signal.score).toBeNull();
    expect(signal.confidence).toBe("none");
    expect(signal.rounds).toBe(0);
    expect(signal.reasons).toEqual([]);
  });

  it("still reports the facts it has when it cannot score", () => {
    // Rework and steering are known even with no review; reporting them
    // keeps unscoreable from meaning nothing is known.
    const signal = deriveRunSignal(
      evidence({ reworkRequired: true, steeringInterventions: 2 }),
      WEIGHTS,
    );
    expect(signal.score).toBeNull();
    expect(signal.reworkRequired).toBe(true);
    expect(signal.steeringInterventions).toBe(2);
  });
});

describe("deriving the score", () => {
  it("gives a clean single-round review the top of the scale", () => {
    const signal = deriveRunSignal(
      evidence({ reviews: [{ reviewRound: 1, verdict: "lgtm" }] }),
      WEIGHTS,
    );
    expect(signal.score).toBe(5);
    expect(signal.confidence).toBe("low");
    expect(signal.reasons).toEqual([]);
  });

  it("counts distinct ROUNDS, not artifacts", () => {
    // One round that produced a code review and a visual review is one
    // round. Counting artifacts would penalise thorough review.
    const signal = deriveRunSignal(
      evidence({
        reviews: [
          { reviewRound: 1, verdict: "lgtm" },
          { reviewRound: 1, verdict: "lgtm" },
          { reviewRound: 1, verdict: "na" },
        ],
      }),
      WEIGHTS,
    );
    expect(signal.rounds).toBe(1);
    expect(signal.score).toBe(5);
  });

  it("subtracts for each extra round", () => {
    const signal = deriveRunSignal(
      evidence({
        reviews: [
          { reviewRound: 1, verdict: "lgtm" },
          { reviewRound: 2, verdict: "lgtm" },
        ],
      }),
      WEIGHTS,
    );
    // One extra round at 0.5.
    expect(signal.rounds).toBe(2);
    expect(signal.score).toBe(4.5);
    expect(signal.confidence).toBe("high");
  });

  it("subtracts more for a blocking round than for the extra round it caused", () => {
    const signal = deriveRunSignal(
      evidence({
        reviews: [
          { reviewRound: 1, verdict: "changes_required" },
          { reviewRound: 2, verdict: "lgtm" },
        ],
      }),
      WEIGHTS,
    );
    // 5 - (1 blocking * 2) - (1 extra round * 0.5).
    expect(signal.blockingRounds).toBe(1);
    expect(signal.score).toBe(2.5);
    expect(signal.reasons[0]).toContain("blocking");
  });

  it("does not charge a blocking round as a nit round as well", () => {
    // Both verdicts land on round 1; the blocking one is the stronger
    // statement about the same round.
    const signal = deriveRunSignal(
      evidence({
        reviews: [
          { reviewRound: 1, verdict: "changes_required" },
          { reviewRound: 1, verdict: "lgtm_with_nits" },
        ],
      }),
      WEIGHTS,
    );
    expect(signal.blockingRounds).toBe(1);
    expect(signal.nitRounds).toBe(0);
    // 5 - 2, with no nit deduction and no extra round.
    expect(signal.score).toBe(3);
  });

  it("subtracts a little for cosmetic findings on sound work", () => {
    const signal = deriveRunSignal(
      evidence({ reviews: [{ reviewRound: 1, verdict: "lgtm_with_nits" }] }),
      WEIGHTS,
    );
    expect(signal.nitRounds).toBe(1);
    expect(signal.score).toBe(4.75);
  });

  it("subtracts for rework", () => {
    const signal = deriveRunSignal(
      evidence({ reviews: [{ reviewRound: 1, verdict: "lgtm" }], reworkRequired: true }),
      WEIGHTS,
    );
    expect(signal.score).toBe(4);
    expect(signal.reasons).toContain("the work had to be redone");
  });

  it("subtracts per steering intervention", () => {
    const signal = deriveRunSignal(
      evidence({ reviews: [{ reviewRound: 1, verdict: "lgtm" }], steeringInterventions: 2 }),
      WEIGHTS,
    );
    // 5 - (2 * 0.75).
    expect(signal.score).toBe(3.5);
  });

  it("never falls below the bottom of the scale", () => {
    const signal = deriveRunSignal(
      evidence({
        reviews: [
          { reviewRound: 1, verdict: "changes_required" },
          { reviewRound: 2, verdict: "changes_required" },
          { reviewRound: 3, verdict: "changes_required" },
          { reviewRound: 4, verdict: "lgtm" },
        ],
        reworkRequired: true,
        steeringInterventions: 5,
      }),
      WEIGHTS,
    );
    expect(signal.score).toBe(1);
  });

  it("names the reasons strongest first", () => {
    const signal = deriveRunSignal(
      evidence({
        reviews: [
          { reviewRound: 1, verdict: "changes_required" },
          { reviewRound: 2, verdict: "lgtm_with_nits" },
        ],
        steeringInterventions: 1,
      }),
      WEIGHTS,
    );
    // Blocking (2) > steering (0.75) > extra round (0.5) > nit (0.25).
    expect(signal.reasons[0]).toContain("blocking");
    expect(signal.reasons.at(-1)).toContain("cosmetic");
  });
});

describe("the judgement is data, not a constant", () => {
  it("honours caller-supplied weights over the defaults", () => {
    const reviews = [{ reviewRound: 1, verdict: "changes_required" }];
    const harsh = deriveRunSignal(evidence({ reviews }), { ...WEIGHTS, perBlockingRound: 4 });
    const lenient = deriveRunSignal(evidence({ reviews }), { ...WEIGHTS, perBlockingRound: 0.5 });
    expect(harsh.score).toBe(1);
    expect(lenient.score).toBe(4.5);
  });

  it("uses the documented defaults when the caller supplies none", () => {
    const signal = deriveRunSignal(
      evidence({ reviews: [{ reviewRound: 1, verdict: "changes_required" }] }),
    );
    expect(DEFAULT_SIGNAL_WEIGHTS.perBlockingRound).toBe(1);
    expect(signal.score).toBe(4);
  });

  it("weights each observation independently of the others", () => {
    // Changing one weight must not move a score that observation did not
    // contribute to.
    const reviews = [{ reviewRound: 1, verdict: "lgtm" }];
    const base = deriveRunSignal(evidence({ reviews, steeringInterventions: 1 }), WEIGHTS);
    const movedUnrelated = deriveRunSignal(evidence({ reviews, steeringInterventions: 1 }), {
      ...WEIGHTS,
      perNitRound: 99,
    });
    expect(movedUnrelated.score).toBe(base.score);
  });
});
