// The review card's derivations — MILESTONES.md #68, and #69's flagging.
//
// ── Fixtures are deliberately asymmetric ───────────────────────────────
//
// Every score in here differs from every other, and the facets differ from
// each other. That is not decoration: a fixture where every field holds the
// same value cannot fail when two fields are swapped, and a fixture with
// one facet cannot test "only the facets in play". Several assertions below
// would pass against a broken implementation if the numbers were equal, so
// they are not.
import { describe, expect, it } from "vitest";
import {
  acceptedScores,
  canMarkSeen,
  facetsInPlay,
  hasAnythingToScore,
  reviewRows,
  scoresToSubmit,
  type DifficultyMap,
} from "@/lib/review/card";
import {
  DEFAULT_FLAG_BELOW_STRENGTH,
  flagReasonFor,
  flaggedRunLabel,
  flaggedRunQuestion,
  isFlaggedRun,
  type FlaggableRun,
} from "@/lib/review/flagged";
import type { RunFacetScore } from "@/lib/scoring/run-scores";

function run(overrides: Partial<FlaggableRun> = {}): FlaggableRun {
  return {
    selectionReason: "recommended",
    recommendationStrength: 0.9,
    model: "tier-a",
    ...overrides,
  };
}

describe("facetsInPlay — only the facets in play", () => {
  it("returns just the declared facets, not the whole union", () => {
    const declared: DifficultyMap = { reasoning: 4, precision: 2 };
    // The point of the row: `breadth`, `autonomy`, `visual` and `writing`
    // were not in play and must not be asked about.
    expect(facetsInPlay(declared)).toEqual(["reasoning", "precision"]);
  });

  it("returns nothing for an item that declared no facets", () => {
    expect(facetsInPlay({})).toEqual([]);
    expect(facetsInPlay(null)).toEqual([]);
    expect(facetsInPlay(undefined)).toEqual([]);
  });

  it("orders by the fixed facet list, not by the map's own key order", () => {
    // Written deliberately out of order. `FACETS` is
    // reasoning, breadth, precision, autonomy, visual, writing.
    const declared = { writing: 1, reasoning: 5, autonomy: 3 } as DifficultyMap;
    expect(facetsInPlay(declared)).toEqual(["reasoning", "autonomy", "writing"]);
  });

  it("drops a key that is not a known facet", () => {
    const declared = { reasoning: 3, coding: 5, nonsense: 1 } as unknown as DifficultyMap;
    expect(facetsInPlay(declared)).toEqual(["reasoning"]);
  });

  it("keeps a declared facet whose difficulty is out of range", () => {
    // A malformed difficulty is no reason to stop asking about work that
    // happened — the facet is in play, its difficulty is just unusable.
    const declared = { breadth: 99 } as DifficultyMap;
    expect(facetsInPlay(declared)).toEqual(["breadth"]);
  });

  it("distinguishes an item with facets from one without", () => {
    expect(hasAnythingToScore({ visual: 3 })).toBe(true);
    expect(hasAnythingToScore({})).toBe(false);
    expect(hasAnythingToScore(null)).toBe(false);
  });
});

describe("reviewRows — what the card renders", () => {
  it("builds one row per declared facet, carrying both scores apart", () => {
    const scores: RunFacetScore[] = [
      { facet: "reasoning", agentScore: 4, userScore: 2 },
      { facet: "precision", agentScore: 5, userScore: null },
    ];
    const rows = reviewRows({ reasoning: 3, precision: 1 }, scores);

    expect(rows).toHaveLength(2);
    // Every number here is distinct, so a mutant that read the wrong field
    // — difficulty for agentScore, agent for user — changes the assertion.
    expect(rows[0]).toEqual({
      facet: "reasoning",
      difficulty: 3,
      agentScore: 4,
      userScore: 2,
    });
    expect(rows[1]).toEqual({
      facet: "precision",
      difficulty: 1,
      agentScore: 5,
      userScore: null,
    });
  });

  it("ignores a score row for a facet the item never declared", () => {
    const scores: RunFacetScore[] = [
      { facet: "reasoning", agentScore: 4, userScore: null },
      { facet: "visual", agentScore: 1, userScore: 1 },
    ];
    const rows = reviewRows({ reasoning: 2 }, scores);
    expect(rows.map((r) => r.facet)).toEqual(["reasoning"]);
  });

  it("still gives a declared facet a row when nothing has scored it", () => {
    const rows = reviewRows({ autonomy: 4 }, []);
    expect(rows).toEqual([{ facet: "autonomy", difficulty: 4, agentScore: null, userScore: null }]);
  });

  it("reports a malformed difficulty as null rather than passing it through", () => {
    const rows = reviewRows({ writing: 0 } as DifficultyMap, []);
    expect(rows[0]?.difficulty).toBeNull();
  });
});

describe("canMarkSeen — the invariant: scoring never blocks Seen", () => {
  // This is the row's stated constraint, so it is asserted directly rather
  // than only through the component. The plausible regression is making
  // Seen depend on a score being set; `canMarkSeen` takes only a
  // `personId`, so such a change cannot be made without editing this
  // function's signature and failing here.
  it("is available with a profile and nothing scored", () => {
    expect(canMarkSeen("person-a")).toBe(true);
  });

  it("is unavailable only when there is no profile to attribute the read to", () => {
    expect(canMarkSeen(null)).toBe(false);
  });
});

describe("scoresToSubmit — an untouched slider sends nothing", () => {
  it("sends only the facets a person actually moved", () => {
    const rows = reviewRows({ reasoning: 3, precision: 4, breadth: 2 }, [
      { facet: "reasoning", agentScore: 5, userScore: 2 },
      { facet: "precision", agentScore: 4, userScore: null },
      { facet: "breadth", agentScore: 3, userScore: 5 },
    ]);
    // `precision` had an agent score and no user score — it must not be
    // submitted, because writing agent-equals-user for it would record an
    // agreement nobody expressed.
    expect(scoresToSubmit(rows)).toEqual([
      { facet: "reasoning", userScore: 2 },
      { facet: "breadth", userScore: 5 },
    ]);
  });

  it("sends nothing at all when no slider was moved", () => {
    const rows = reviewRows({ reasoning: 3, visual: 5 }, [
      { facet: "reasoning", agentScore: 4, userScore: null },
      { facet: "visual", agentScore: 2, userScore: null },
    ]);
    expect(scoresToSubmit(rows)).toEqual([]);
  });
});

describe("acceptedScores — an explicit accept copies the agent's score", () => {
  it("copies each agent score onto the user score", () => {
    const rows = reviewRows({ reasoning: 1, breadth: 2 }, [
      { facet: "reasoning", agentScore: 5, userScore: null },
      { facet: "breadth", agentScore: 3, userScore: null },
    ]);
    // Distinct values, so a mutant copying the wrong row's score fails.
    expect(acceptedScores(rows)).toEqual([
      { facet: "reasoning", userScore: 5 },
      { facet: "breadth", userScore: 3 },
    ]);
  });

  it("skips a facet the agent never scored — there is nothing to agree with", () => {
    const rows = reviewRows({ reasoning: 3, autonomy: 4 }, [
      { facet: "reasoning", agentScore: 4, userScore: null },
    ]);
    expect(acceptedScores(rows)).toEqual([{ facet: "reasoning", userScore: 4 }]);
  });
});

describe("flagged runs — #69's specific question", () => {
  it("flags an exploration", () => {
    expect(flagReasonFor(run({ selectionReason: "exploration" }))).toBe("exploration");
    expect(isFlaggedRun(run({ selectionReason: "exploration" }))).toBe(true);
  });

  it("flags a run dispatched with low confidence", () => {
    expect(flagReasonFor(run({ recommendationStrength: 0.2 }))).toBe("low_confidence");
  });

  it("does not flag a confident, ordinary recommendation", () => {
    expect(flagReasonFor(run())).toBeNull();
    expect(isFlaggedRun(run())).toBe(false);
    expect(flaggedRunQuestion(run())).toBeNull();
  });

  it("treats the threshold as inclusive at its boundary and not beyond", () => {
    // At exactly the default, flagged; a hair above, not. Pins the
    // comparison direction, which a `<` for `<=` mutant would flip.
    expect(flagReasonFor(run({ recommendationStrength: DEFAULT_FLAG_BELOW_STRENGTH }))).toBe(
      "low_confidence",
    );
    expect(
      flagReasonFor(run({ recommendationStrength: DEFAULT_FLAG_BELOW_STRENGTH + 0.01 })),
    ).toBeNull();
  });

  it("honours a caller-supplied threshold over the default", () => {
    // 0.7 is above the 0.5 default, so this run flags only because the
    // caller said so — proving the parameter is read, not ignored.
    expect(flagReasonFor(run({ recommendationStrength: 0.6 }), 0.7)).toBe("low_confidence");
    expect(flagReasonFor(run({ recommendationStrength: 0.6 }))).toBeNull();
  });

  it("prefers the exploration reason when a run is both", () => {
    const both = run({ selectionReason: "exploration", recommendationStrength: 0.1 });
    expect(flagReasonFor(both)).toBe("exploration");
  });

  it("does not flag a run with no dispatch decision behind it", () => {
    // Null selectionReason and null strength: telemetry saw which model
    // served the call, never why. There is no tradeoff to ask about.
    expect(flagReasonFor(run({ selectionReason: null, recommendationStrength: null }))).toBeNull();
  });

  it("asks the cheaper-model question, naming the model", () => {
    const question = flaggedRunQuestion(run({ selectionReason: "exploration", model: "tier-c" }));
    // Asserting on the specific sentence, not on ambient text: the row's
    // framing IS the spec.
    expect(question).toContain("cheaper model");
    expect(question).toContain("up to standard");
    expect(question).toContain("tier-c");
  });

  it("asks a different question about a close call than about an experiment", () => {
    const experiment = flaggedRunQuestion(run({ selectionReason: "exploration" }));
    const closeCall = flaggedRunQuestion(run({ recommendationStrength: 0.1 }));
    expect(experiment).not.toEqual(closeCall);
    expect(closeCall).toContain("close call");
  });

  it("omits the model from the question when it is not known", () => {
    const question = flaggedRunQuestion(run({ selectionReason: "exploration", model: null }));
    expect(question).toContain("cheaper model");
    expect(question).not.toContain("()");
  });

  it("labels a flagged run as an invitation, not as blocked work", () => {
    // SCHEMA.md §12 keeps "flagged" and "blocked" distinct; conflating
    // them makes the urgent list untrustworthy.
    expect(flaggedRunLabel("exploration")).not.toMatch(/block/i);
    expect(flaggedRunLabel("low_confidence")).not.toMatch(/block/i);
  });
});
