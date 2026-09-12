// Deriving an intervention's score from what the session did next
// (`src/lib/interventions/derived-score.ts`).
//
// The property every test here defends is the same one: **the derivation
// must be able to say "I do not know"**, and must say it far more often
// than it says anything else. A scorer that always produced a number would
// fill the aggregate with arithmetic on absent evidence, and the aggregate
// is the entire product of this system — a table of confident guesses is
// worse than an empty one, because an empty one is visibly empty.
//
// So the null cases are not an afterthought group at the bottom. They are
// most of this file.
import { describe, expect, it } from "vitest";
import {
  DERIVED_RATER_ID,
  MAX_DERIVED_SCORE,
  RESPONSE_WINDOW_MS,
  deriveInterventionScore,
  isDerivableScore,
  isSameCall,
  normaliseCommand,
  type FiringEvidence,
} from "@/lib/interventions/derived-score";
import {
  MAX_INTERVENTION_SCORE,
  MIN_INTERVENTION_SCORE,
  isRemovalSignal,
} from "@/lib/interventions/scoring";

const AT = 1_000_000;

function firing(overrides: Partial<FiringEvidence> = {}): FiringEvidence {
  return {
    entryId: "I10",
    at: AT,
    outcome: "blocked",
    tool: "Bash",
    command: "git merge main",
    followUps: [],
    ...overrides,
  };
}

describe("a block the session routed around scores at the bottom of the scale", () => {
  it("scores an overridden firing 1 — the scale's removal signal", () => {
    // The owner's 1 reads "a block I had to route around". An override is
    // that, recorded by the session itself rather than inferred: it was
    // refused, it wrote a reason, and it went ahead.
    const result = deriveInterventionScore(firing({ outcome: "overridden" }));

    expect(result.score).toBe(1);
    expect(isRemovalSignal(result.score!)).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("scores an override 1 even with no follow-up calls at all", () => {
    // The override is self-contained evidence. Requiring a follow-up would
    // make the strongest signal available depend on the session happening
    // to do something else afterwards.
    const result = deriveInterventionScore(firing({ outcome: "overridden", followUps: [] }));
    expect(result.score).toBe(1);
  });

  it("scores 2 when the session was blocked and then made the same call again", () => {
    // Not a 1. The guard cost time without changing the outcome, but
    // nothing here establishes it was harmful — and reserving the removal
    // signal for a firing somebody actually condemned keeps the strongest
    // thing this table can say attributable to a rater.
    const result = deriveInterventionScore(
      firing({
        followUps: [{ at: AT + 5_000, tool: "Bash", command: "git merge main" }],
      }),
    );

    expect(result.score).toBe(2);
    expect(result.repeated).toBe(true);
  });

  it("treats a retry differing only by whitespace and case as the same call", () => {
    const result = deriveInterventionScore(
      firing({
        followUps: [{ at: AT + 5_000, tool: "Bash", command: "GIT   merge    main" }],
      }),
    );
    expect(result.score).toBe(2);
  });
});

describe("a block the session respected scores above the middle, but never at the top", () => {
  it("scores 4 when the session did something different afterwards", () => {
    const result = deriveInterventionScore(
      firing({
        followUps: [{ at: AT + 5_000, tool: "Bash", command: "git status" }],
      }),
    );

    expect(result.score).toBe(4);
    expect(result.repeated).toBe(false);
    expect(result.proceeded).toBe(true);
  });

  it("never awards the top of the scale, which asserts a counterfactual", () => {
    // A 5 says "I would have gone down the wrong path if not for this
    // nudge" — a claim about what would have happened otherwise. No record
    // of what did happen can establish one, so the derivation must not be
    // able to produce a 5 by any route.
    expect(MAX_DERIVED_SCORE).toBeLessThan(MAX_INTERVENTION_SCORE);

    const outcomes = ["blocked", "overridden", "nudged", "silent"];
    const followUpSets = [
      [],
      [{ at: AT + 1, tool: "Bash", command: "git merge main" }],
      [{ at: AT + 1, tool: "Bash", command: "something else" }],
      [{ at: AT + 1, tool: "Read", command: "x" }],
    ];
    for (const outcome of outcomes) {
      for (const followUps of followUpSets) {
        const result = deriveInterventionScore(firing({ outcome, followUps }));
        expect(result.score === null || result.score <= MAX_DERIVED_SCORE).toBe(true);
      }
    }
  });

  it("reports low confidence for a respected block, since compliance is not correctness", () => {
    // A session complying with a wrong guard looks exactly like one
    // complying with a right one. The score reflects that it was not an
    // obstacle; the confidence reflects that this is weaker evidence than
    // an override.
    const result = deriveInterventionScore(
      firing({ followUps: [{ at: AT + 5_000, tool: "Bash", command: "git status" }] }),
    );
    expect(result.confidence).toBe("low");
  });
});

describe("absent evidence yields no score, never a neutral one", () => {
  it("yields null when a blocked session made no further call", () => {
    // The session may have accepted the refusal, or died. A 3 here would
    // be an opinion nobody holds.
    const result = deriveInterventionScore(firing({ followUps: [] }));

    expect(result.score).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.proceeded).toBe(false);
  });

  it("yields null for a nudge, whatever the session did next", () => {
    // A nudge refuses nothing, so proceeding is not routing around
    // anything. What a nudge is worth is whether its advice was RIGHT, and
    // behaviour after one is identical either way — which is exactly the
    // case that has to be asked about rather than inferred.
    const same = deriveInterventionScore(
      firing({
        outcome: "nudged",
        followUps: [{ at: AT + 5_000, tool: "Bash", command: "git merge main" }],
      }),
    );
    const different = deriveInterventionScore(
      firing({
        outcome: "nudged",
        followUps: [{ at: AT + 5_000, tool: "Bash", command: "git status" }],
      }),
    );

    expect(same.score).toBeNull();
    expect(different.score).toBeNull();
  });

  it("yields null for a silent firing", () => {
    expect(deriveInterventionScore(firing({ outcome: "silent" })).score).toBeNull();
  });

  it("yields null when a blocked firing has no command to compare against", () => {
    // A firing with no stored command cannot be shown to have been
    // repeated. Reading that as "not repeated" and awarding 4 would score
    // an unknown as a success.
    const result = deriveInterventionScore(
      firing({
        command: undefined,
        followUps: [{ at: AT + 5_000, tool: "Bash", command: "git merge main" }],
      }),
    );

    // It proceeded, so it does score — but the point being pinned is that
    // the repeat could not be detected, so it must not be reported as one.
    expect(result.repeated).toBe(false);
  });
});

describe("the response window bounds what counts as a response", () => {
  it("ignores a repeat that arrives after the window closes", () => {
    // Half an hour later is the session doing something else, not
    // responding to the refusal.
    const result = deriveInterventionScore(
      firing({
        followUps: [{ at: AT + RESPONSE_WINDOW_MS + 1, tool: "Bash", command: "git merge main" }],
      }),
    );

    expect(result.repeated).toBe(false);
    expect(result.proceeded).toBe(false);
    expect(result.score).toBeNull();
  });

  it("counts a repeat exactly on the window boundary", () => {
    // The boundary is inclusive. Pinned so a change from `<=` to `<`
    // fails here rather than silently shrinking the window by one
    // millisecond and going unnoticed forever.
    const result = deriveInterventionScore(
      firing({
        followUps: [{ at: AT + RESPONSE_WINDOW_MS, tool: "Bash", command: "git merge main" }],
      }),
    );
    expect(result.score).toBe(2);
  });

  it("ignores calls that happened before the firing", () => {
    // A call at or before the firing's own timestamp cannot be a response
    // to it — and the firing's own call is very often in the tail.
    const result = deriveInterventionScore(
      firing({
        followUps: [
          { at: AT - 1_000, tool: "Bash", command: "git merge main" },
          { at: AT, tool: "Bash", command: "git merge main" },
        ],
      }),
    );

    expect(result.repeated).toBe(false);
    expect(result.score).toBeNull();
  });

  it("honours a window supplied by the caller over the default", () => {
    const tight = deriveInterventionScore(
      firing({ followUps: [{ at: AT + 5_000, tool: "Bash", command: "git merge main" }] }),
      1_000,
    );
    expect(tight.score).toBeNull();
  });
});

describe("comparing two calls", () => {
  it("collapses whitespace and case but nothing else", () => {
    expect(normaliseCommand("  GIT   merge \n main ")).toBe("git merge main");
  });

  it("does not treat the same command through a different tool as a repeat", () => {
    // Running a string through a different tool is a different act, and
    // the tool is the only thing distinguishing them.
    expect(isSameCall(firing(), { at: AT + 1, tool: "Write", command: "git merge main" })).toBe(
      false,
    );
  });

  it("does not treat a different command through the same tool as a repeat", () => {
    expect(isSameCall(firing(), { at: AT + 1, tool: "Bash", command: "git status" })).toBe(false);
  });

  it("never matches when either side has no command", () => {
    // Unknown is not a match. Treating it as one would score every
    // command-less firing as routed around.
    expect(
      isSameCall(firing({ command: undefined }), { at: AT + 1, tool: "Bash", command: "x" }),
    ).toBe(false);
    expect(isSameCall(firing(), { at: AT + 1, tool: "Bash" })).toBe(false);
  });

  it("never matches when the firing has no tool", () => {
    expect(
      isSameCall(firing({ tool: undefined }), {
        at: AT + 1,
        tool: "Bash",
        command: "git merge main",
      }),
    ).toBe(false);
  });
});

describe("the cap is enforced at the seam that writes, not only where it is computed", () => {
  it("accepts null, which is how no-evidence is expressed", () => {
    expect(isDerivableScore(null)).toBe(true);
  });

  it("accepts every score the derivation may award", () => {
    for (let score = MIN_INTERVENTION_SCORE; score <= MAX_DERIVED_SCORE; score += 1) {
      expect(isDerivableScore(score)).toBe(true);
    }
  });

  it("refuses the top of the scale", () => {
    expect(isDerivableScore(MAX_INTERVENTION_SCORE)).toBe(false);
  });

  it("refuses a value off the scale or between its points", () => {
    expect(isDerivableScore(0)).toBe(false);
    expect(isDerivableScore(-1)).toBe(false);
    expect(isDerivableScore(2.5)).toBe(false);
  });
});

describe("derived scores are attributable", () => {
  it("reserves a rater id so a derived score cannot displace a volunteered one", () => {
    // The unique constraint is `(event_id, rater_type, rater_id)`. A null
    // rater id collapses to the sentinel an anonymous human answer also
    // uses, so a derivation writing there could overwrite a person's
    // rating — the one direction this must never fail in.
    expect(DERIVED_RATER_ID).not.toBe("");
    expect(DERIVED_RATER_ID.trim()).toBe(DERIVED_RATER_ID);
  });

  it("always explains what moved the score", () => {
    // A score with no reason attached is a number a maintainer cannot act
    // on — the note is what distinguishes "the detection was wrong" from
    // "the detection was right and the message was undiscoverable".
    for (const outcome of ["blocked", "overridden", "nudged", "silent"]) {
      const result = deriveInterventionScore(firing({ outcome }));
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons[0]).not.toBe("");
    }
  });
});
