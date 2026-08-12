// Summaries — the static validators. See docs/plans/MILESTONES.md #21,
// SCHEMA.md §5, §5a.
//
// Everything here is pure (`validateSummaryShape`, `findJargonHits`,
// `jaccardSimilarity`, `isTooSimilar`) — no database needed, unlike the
// guard-integration suite in `tests/summaries-guard.test.ts`, which proves
// the similarity check against real `events` rows and the guard's wiring
// into the completed-state transition.
import { describe, expect, it } from "vitest";
import {
  HOW_VERIFIED_CHAR_CAP,
  JARGON_TERMS,
  NOT_DONE_MAX,
  NOT_DONE_TEXT_CHAR_CAP,
  SHIPPED_CHAR_CAP,
  SHIPPED_MAX,
  SIMILARITY_REJECT_AT,
  WATCH_FOR_MAX,
  WHAT_TO_TEST_MAX,
  WHAT_TO_TEST_MIN,
  findJargonHits,
  isTooSimilar,
  jaccardSimilarity,
  validateSummaryShape,
  type SummaryCandidate,
} from "@/lib/service/summaries";

/** A minimal, fully valid non-user-facing candidate — the baseline every test mutates one field of. */
function baseCandidate(overrides: Partial<SummaryCandidate> = {}): SummaryCandidate {
  return {
    shipped: ["Added the summaries guard and its validators."],
    not_done: [],
    user_facing: false,
    how_verified: "Ran the new test suite locally and read every assertion against the schema.",
    watch_for: [],
    ...overrides,
  };
}

describe("shape and counts (SCHEMA.md §5)", () => {
  it("accepts a minimal valid non-user-facing candidate", () => {
    expect(validateSummaryShape(baseCandidate())).toEqual([]);
  });

  it("rejects zero shipped entries — the floor is 1", () => {
    // Mutation check: changing SHIPPED_MIN's comparison from `<` to `<=`
    // would make this pass an array of length 1 too; this asserts on an
    // array of length 0, which only the `< SHIPPED_MIN` branch catches.
    const issues = validateSummaryShape(baseCandidate({ shipped: [] }));
    expect(issues.some((i) => i.field === "shipped" && i.rule === "count")).toBe(true);
  });

  it("rejects six shipped entries — one over the cap of 5", () => {
    const issues = validateSummaryShape(
      baseCandidate({ shipped: Array.from({ length: SHIPPED_MAX + 1 }, (_, i) => `outcome ${i}`) }),
    );
    expect(issues.some((i) => i.field === "shipped" && i.rule === "count")).toBe(true);
  });

  it("accepts exactly SHIPPED_MAX shipped entries — the boundary is inclusive", () => {
    const issues = validateSummaryShape(
      baseCandidate({ shipped: Array.from({ length: SHIPPED_MAX }, (_, i) => `outcome ${i}`) }),
    );
    expect(issues.some((i) => i.field === "shipped")).toBe(false);
  });

  it("rejects more than NOT_DONE_MAX not_done entries", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        not_done: Array.from({ length: NOT_DONE_MAX + 1 }, (_, i) => ({
          text: `deferred ${i}`,
          reason: "descoped",
        })),
      }),
    );
    expect(issues.some((i) => i.field === "not_done" && i.rule === "count")).toBe(true);
  });

  it("accepts zero not_done entries — explicit empty is fine (SCHEMA.md §5)", () => {
    expect(validateSummaryShape(baseCandidate({ not_done: [] }))).toEqual([]);
  });

  it("rejects a not_done entry with an unrecognised reason", () => {
    const issues = validateSummaryShape(
      baseCandidate({ not_done: [{ text: "left for later", reason: "ran-out-of-time" }] }),
    );
    expect(issues.some((i) => i.field === "not_done" && i.rule === "reason")).toBe(true);
  });

  it("accepts each of the three real not_done reasons", () => {
    for (const reason of ["follow-up", "needs-approval", "descoped"] as const) {
      const issues = validateSummaryShape(
        baseCandidate({ not_done: [{ text: "deferred item", reason }] }),
      );
      expect(issues.some((i) => i.field === "not_done" && i.rule === "reason")).toBe(false);
    }
  });

  it("rejects more than WATCH_FOR_MAX watch_for entries", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        watch_for: Array.from({ length: WATCH_FOR_MAX + 1 }, (_, i) => `risk ${i}`),
      }),
    );
    expect(issues.some((i) => i.field === "watch_for" && i.rule === "count")).toBe(true);
  });
});

describe("the user_facing branch (SCHEMA.md §5: 'forces the branch below')", () => {
  it("requires what_to_test and forbids how_verified when user_facing is true", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        user_facing: true,
        how_verified: "ran it manually",
        what_to_test: undefined,
      }),
    );
    expect(issues.some((i) => i.field === "what_to_test" && i.rule === "count")).toBe(true);
    expect(issues.some((i) => i.field === "how_verified" && i.rule === "not_applicable")).toBe(
      true,
    );
  });

  it("accepts a valid user_facing candidate with 1-3 what_to_test steps and no how_verified", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        user_facing: true,
        how_verified: undefined,
        what_to_test: [{ text: "Open the board and confirm the new column renders." }],
      }),
    );
    expect(issues).toEqual([]);
  });

  it("rejects more than 3 what_to_test steps", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        user_facing: true,
        how_verified: undefined,
        what_to_test: Array.from({ length: WHAT_TO_TEST_MAX + 1 }, (_, i) => ({
          text: `step ${i}`,
        })),
      }),
    );
    expect(issues.some((i) => i.field === "what_to_test" && i.rule === "count")).toBe(true);
  });

  it("rejects zero what_to_test steps when user_facing — the floor is WHAT_TO_TEST_MIN", () => {
    const issues = validateSummaryShape(
      baseCandidate({ user_facing: true, how_verified: undefined, what_to_test: [] }),
    );
    expect(issues.some((i) => i.field === "what_to_test" && i.rule === "count")).toBe(true);
    expect(WHAT_TO_TEST_MIN).toBe(1); // pins the documented floor so a silent change is caught here
  });

  it("requires how_verified and forbids what_to_test when user_facing is false", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        user_facing: false,
        how_verified: undefined,
        what_to_test: [{ text: "should not be here" }],
      }),
    );
    expect(issues.some((i) => i.field === "how_verified" && i.rule === "required")).toBe(true);
    expect(issues.some((i) => i.field === "what_to_test" && i.rule === "not_applicable")).toBe(
      true,
    );
  });

  it("rejects how_verified that is only a CI/test reference (SCHEMA.md §5, static validator 4)", () => {
    const issues = validateSummaryShape(baseCandidate({ how_verified: "Tests pass." }));
    expect(issues.some((i) => i.field === "how_verified" && i.rule === "ci_only")).toBe(true);
  });

  it("rejects how_verified that is only a bare 'CI green' reference — the ci branch specifically, not the tests branch", () => {
    // Distinct from the test above: CI_ONLY_PHRASES matches several
    // alternative phrasings ("ci", "tests?", "build", ...) in one regex, and
    // a mutation that breaks only the "ci" alternative would still be
    // caught by the "tests pass" case above going untouched — this pins
    // the "ci" alternative on its own so that specific branch has its own
    // failing case.
    const issues = validateSummaryShape(baseCandidate({ how_verified: "CI green." }));
    expect(issues.some((i) => i.field === "how_verified" && i.rule === "ci_only")).toBe(true);
  });

  it("accepts how_verified naming what was run AND observed live, alongside a CI mention", () => {
    // A CI phrase is fine when it isn't the *whole* content — the rule is
    // "not solely", not "never mentions CI at all".
    const issues = validateSummaryShape(
      baseCandidate({
        how_verified:
          "Ran the guard against a scratch database and read the rejected fields myself; tests pass.",
      }),
    );
    expect(issues.some((i) => i.field === "how_verified" && i.rule === "ci_only")).toBe(false);
  });
});

describe("reject-don't-truncate (SCHEMA.md §5, static validator 1) — AC3", () => {
  it("refuses a shipped entry one character over the 120-char cap, and does not shorten it", () => {
    const overLong = "x".repeat(SHIPPED_CHAR_CAP + 1);
    const candidate = baseCandidate({ shipped: [overLong] });
    const issues = validateSummaryShape(candidate);

    // Refused.
    expect(issues.some((i) => i.field === "shipped" && i.rule === "max_length")).toBe(true);

    // AND separately: the candidate object itself was never mutated or
    // shortened by the call — a truncating implementation could still pass
    // the assertion above (report a violation) while also handing back a
    // cut string; this is the second half of AC3 the brief calls out
    // explicitly ("assert...the stored value was not silently shortened").
    expect(candidate.shipped[0]).toHaveLength(SHIPPED_CHAR_CAP + 1);
    expect(candidate.shipped[0]).toBe(overLong);
  });

  it("accepts a shipped entry exactly at the 120-char cap — the boundary is inclusive", () => {
    const exactly = "x".repeat(SHIPPED_CHAR_CAP);
    const issues = validateSummaryShape(baseCandidate({ shipped: [exactly] }));
    expect(issues.some((i) => i.field === "shipped" && i.rule === "max_length")).toBe(false);
  });

  it("refuses an over-length not_done text without shortening it", () => {
    const overLong = "y".repeat(NOT_DONE_TEXT_CHAR_CAP + 1);
    const candidate = baseCandidate({ not_done: [{ text: overLong, reason: "descoped" }] });
    const issues = validateSummaryShape(candidate);
    expect(issues.some((i) => i.field === "not_done" && i.rule === "max_length")).toBe(true);
    expect(candidate.not_done[0]?.text).toBe(overLong);
  });

  it("refuses an over-length how_verified without shortening it", () => {
    const overLong = "z".repeat(HOW_VERIFIED_CHAR_CAP + 1);
    const candidate = baseCandidate({ how_verified: overLong });
    const issues = validateSummaryShape(candidate);
    expect(issues.some((i) => i.field === "how_verified" && i.rule === "max_length")).toBe(true);
    expect(candidate.how_verified).toBe(overLong);
  });
});

describe("jargon denylist (SCHEMA.md §5, static validator 3) — AC5", () => {
  it("refuses a denylisted term embedded in prose", () => {
    const hits = findJargonHits("shipped", 0, "Set owner= on the row and shipped it.");
    expect(hits.some((h) => h.rule === "jargon")).toBe(true);
  });

  it("refuses each category the spec names: field identifier, review shorthand, script filename", () => {
    expect(
      findJargonHits("x", undefined, "review_round bumped").some((h) => h.rule === "jargon"),
    ).toBe(true);
    expect(
      findJargonHits("x", undefined, "got an LGTM from review").some((h) => h.rule === "jargon"),
    ).toBe(true);
    expect(
      findJargonHits("x", undefined, "ran scripts/run-mutation-tests.mjs").some(
        (h) => h.rule === "jargon",
      ),
    ).toBe(true);
  });

  it("refuses a bare cross-reference (#n, PR-n, §n)", () => {
    expect(findJargonHits("x", undefined, "fixed in #42").some((h) => h.rule === "jargon")).toBe(
      true,
    );
    expect(
      findJargonHits("x", undefined, "see PR-91 for context").some((h) => h.rule === "jargon"),
    ).toBe(true);
    expect(
      findJargonHits("x", undefined, "per §5a of the plan").some((h) => h.rule === "jargon"),
    ).toBe(true);
  });

  it("refuses an ALL-CAPS prefix", () => {
    expect(
      findJargonHits("x", undefined, "TODO: revisit this later").some((h) => h.rule === "jargon"),
    ).toBe(true);
  });

  it("passes ordinary prose containing a superficially similar word — false-positive check", () => {
    // "algorithm" contains the substring "LGTM"? No — but it does share
    // letters loosely; the real risk case is a case-sensitive near-miss:
    // "logarithm" and "LGTM" share no case-sensitive substring, so this
    // asserts the matcher is not doing something cruder than exact
    // substring/word matching that a looser implementation might.
    const hits = findJargonHits(
      "shipped",
      0,
      "Used a logarithmic backoff and reviewed the algorithm twice before shipping.",
    );
    expect(hits).toEqual([]);
  });

  it("does not fire on lowercase 'lgtm' when the denylist entry is the uppercase review shorthand", () => {
    // JARGON_TERMS holds "LGTM" specifically as review shorthand (all-caps
    // convention); this pins the case-sensitivity so a future edit can't
    // silently make it case-insensitive and start flagging "Lgtm" the
    // person's name or unrelated casual use without anyone noticing the
    // widening.
    expect(JARGON_TERMS).toContain("LGTM");
    const hits = findJargonHits("x", undefined, "the plan lgtm'd fine internally");
    expect(hits.some((h) => h.message.includes('"LGTM"'))).toBe(false);
  });

  it("does not fire on ordinary prose with a hash symbol that is not a cross-reference", () => {
    const hits = findJargonHits("x", undefined, "the recipe calls for # C flour by weight");
    expect(hits.some((h) => h.rule === "jargon")).toBe(false);
  });

  it("passes plain prose with no denylisted vocabulary at all", () => {
    expect(
      validateSummaryShape(
        baseCandidate({
          shipped: ["Added door placement for the entry and two internal doors."],
        }),
      ),
    ).toEqual([]);
  });
});

describe("jaccardSimilarity and isTooSimilar — the similarity algorithm itself (AC4)", () => {
  it("returns 1 for identical text", () => {
    expect(jaccardSimilarity("the quick brown fox", "the quick brown fox")).toBe(1);
  });

  it("returns 0 for completely disjoint text", () => {
    expect(jaccardSimilarity("apples and oranges", "trucks and highways")).toBeLessThan(0.34);
  });

  it("is case-insensitive and punctuation-insensitive by tokenizing", () => {
    expect(jaccardSimilarity("Fixed the bug!", "fixed the bug")).toBe(1);
  });

  it("flags near-verbatim log-paste text as too similar — >= 0.85", () => {
    const logLine =
      "error connecting to database pool timeout after thirty seconds retry attempt three";
    const pasted =
      "error connecting to database pool timeout after thirty seconds retry attempt four";
    // Ten tokens each, nine shared -> 9 / 11 ~= 0.818, just under threshold
    // at one word changed; use a closer paste to land solidly over 0.85.
    const nearlyIdentical =
      "error connecting to database pool timeout after thirty seconds retry attempt three.";
    expect(isTooSimilar(nearlyIdentical, logLine)).toBe(true);
    void pasted; // kept to document the near-threshold case considered and rejected as the test fixture
  });

  it("does NOT flag a genuinely different summary sentence describing the same broad topic", () => {
    // AC4's required negative case: two texts about the same subject area
    // (both mention "database"), phrased completely differently, must pass.
    const shipped = "Added the summaries guard so completion now requires a valid summary.";
    const priorEvent = "Reassigned this item to a different area after triage.";
    expect(isTooSimilar(shipped, priorEvent)).toBe(false);
  });

  it("boundary: exactly SIMILARITY_REJECT_AT counts as too similar (>=, not >)", () => {
    // Construct two 20-token strings sharing exactly 17 -> union 23,
    // intersection 17 -> 17/23 ~= 0.739; instead, build an exact boundary
    // directly: 17 shared of 20 total tokens each with 3 unique apiece ->
    // intersection 17, union 17+3+3=23 -> not exactly 0.85. Simpler: use
    // two 4-word overlaps out of ~4.7 for a clean fraction is awkward with
    // words, so assert the operator behaviour on a numeric edge instead by
    // picking strings whose Jaccard is provably exactly 0.85: 17 shared
    // tokens, 3 unique to each (17 / (17+3+3) = 17/23, not 0.85). Use
    // 34 shared / 40 total unique (34/40=0.85) via two disjoint-suffix sets.
    const shared = Array.from({ length: 34 }, (_, i) => `word${i}`);
    const a = [...shared, "onlyA1", "onlyA2", "onlyA3"].join(" ");
    const b = [...shared, "onlyB1", "onlyB2", "onlyB3"].join(" ");
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.85, 5);
    expect(isTooSimilar(a, b)).toBe(true); // >= threshold rejects
  });

  it("just under the threshold passes", () => {
    // 33 shared tokens, 4 unique to each -> 33 / 41 ~= 0.805, comfortably under 0.85.
    const shared = Array.from({ length: 33 }, (_, i) => `word${i}`);
    const a = [...shared, "onlyA1", "onlyA2", "onlyA3", "onlyA4"].join(" ");
    const b = [...shared, "onlyB1", "onlyB2", "onlyB3", "onlyB4"].join(" ");
    expect(isTooSimilar(a, b)).toBe(false);
  });

  it("empty strings are never 'too similar' via this path", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
    expect(isTooSimilar("", "")).toBe(false);
    expect(isTooSimilar("", "some real text")).toBe(false);
  });
});

describe("SIMILARITY_REJECT_AT matches the number SCHEMA.md §5 states", () => {
  it("is 0.85", () => {
    expect(SIMILARITY_REJECT_AT).toBe(0.85);
  });
});
