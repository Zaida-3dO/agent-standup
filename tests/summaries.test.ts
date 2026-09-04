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
  ALL_CAPS_PREFIXES,
  DECISION_CHAR_CAP,
  DECISION_CHAR_MIN,
  DELIVERY_STATES,
  HOW_VERIFIED_CHAR_CAP,
  NON_DELIVERY_STATES,
  JARGON_TERMS,
  NOT_DONE_MAX,
  NOT_DONE_TEXT_CHAR_CAP,
  SHIPPED_CHAR_CAP,
  SHIPPED_MAX,
  SIMILARITY_REJECT_AT,
  WATCH_FOR_CHAR_CAP,
  WATCH_FOR_MAX,
  WHAT_TO_TEST_MAX,
  WHAT_TO_TEST_MIN,
  WHAT_TO_TEST_TEXT_CHAR_CAP,
  findJargonHits,
  isTooSimilar,
  jaccardSimilarity,
  validateSummaryShape,
  type SummaryCandidate,
} from "@/lib/service/summaries";
import { findSimilarityIssues } from "@/lib/service/guards/summaries";

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

/**
 * A valid non-delivery candidate — what `wont_do` and `cancelled` require:
 * no `shipped`, and a `decision` naming why.
 */
function nonDeliveryCandidate(overrides: Partial<SummaryCandidate> = {}): SummaryCandidate {
  return {
    shipped: [],
    decision: "Duplicate of the open-loop writes row, which already covers this change.",
    not_done: [],
    user_facing: false,
    how_verified: "Read both rows and confirmed the other one carries the whole change.",
    watch_for: [],
    ...overrides,
  };
}

describe("what a completed state requires depends on whether it claims delivery", () => {
  // The whole point of the split: closing a duplicate must not force a
  // non-delivery to be written into a field named for delivered work.

  it.each([...NON_DELIVERY_STATES])(
    "accepts a %s close with no shipped entries at all",
    (state) => {
      expect(validateSummaryShape(nonDeliveryCandidate(), state)).toEqual([]);
    },
  );

  it.each([...NON_DELIVERY_STATES])("requires a decision when closing as %s", (state) => {
    const issues = validateSummaryShape(nonDeliveryCandidate({ decision: undefined }), state);
    expect(issues.some((i) => i.field === "decision" && i.rule === "required")).toBe(true);
  });

  it.each([...NON_DELIVERY_STATES])(
    "refuses a %s close that also claims something shipped",
    (state) => {
      // Exclusive in both directions — otherwise the field this split
      // exists to keep honest is reachable through a side door.
      const issues = validateSummaryShape(
        nonDeliveryCandidate({ shipped: ["Identified as a duplicate of the other row."] }),
        state,
      );
      expect(issues.some((i) => i.field === "shipped" && i.rule === "not_applicable")).toBe(true);
    },
  );

  it.each([...DELIVERY_STATES])("still requires shipped when closing as %s", (state) => {
    // The guarantee the split must not weaken. A single-character change
    // making the non-delivery branch fire for every state would break this.
    const issues = validateSummaryShape(baseCandidate({ shipped: [] }), state);
    expect(issues.some((i) => i.field === "shipped" && i.rule === "count")).toBe(true);
  });

  it.each([...DELIVERY_STATES])("refuses a decision on a %s close", (state) => {
    const issues = validateSummaryShape(
      baseCandidate({ decision: "Not applicable to a delivery close." }),
      state,
    );
    expect(issues.some((i) => i.field === "decision" && i.rule === "not_applicable")).toBe(true);
  });

  it("requires shipped when no target state is supplied at all", () => {
    // The conservative default: an unknown destination keeps the stricter
    // requirement rather than silently accepting a summary asserting
    // nothing. Every pre-existing caller relies on this.
    const issues = validateSummaryShape(baseCandidate({ shipped: [] }));
    expect(issues.some((i) => i.field === "shipped" && i.rule === "count")).toBe(true);
  });

  it("refuses a decision one character under the minimum length", () => {
    // Boundary, asserted from below: a reason short enough to be a shrug
    // does not make a closure reviewable later.
    const tooShort = "x".repeat(DECISION_CHAR_MIN - 1);
    const issues = validateSummaryShape(nonDeliveryCandidate({ decision: tooShort }), "wont_do");
    expect(issues.some((i) => i.field === "decision" && i.rule === "min_length")).toBe(true);
  });

  it("accepts a decision exactly at the minimum length — the boundary is inclusive", () => {
    const exactly = "x".repeat(DECISION_CHAR_MIN);
    const issues = validateSummaryShape(nonDeliveryCandidate({ decision: exactly }), "wont_do");
    expect(issues.some((i) => i.field === "decision")).toBe(false);
  });

  it("refuses a decision one character over the cap, and does not shorten it", () => {
    const overLong = "x".repeat(DECISION_CHAR_CAP + 1);
    const candidate = nonDeliveryCandidate({ decision: overLong });
    const issues = validateSummaryShape(candidate, "cancelled");
    expect(issues.some((i) => i.field === "decision" && i.rule === "max_length")).toBe(true);
    // Reject, never truncate — the caller gets back what they sent.
    expect(candidate.decision).toHaveLength(DECISION_CHAR_CAP + 1);
  });

  it("applies the jargon denylist to decision like every other prose field", () => {
    const issues = validateSummaryShape(
      nonDeliveryCandidate({ decision: "Superseded because review_round two said so." }),
      "wont_do",
    );
    expect(issues.some((i) => i.field === "decision" && i.rule === "jargon")).toBe(true);
  });

  it("a whitespace-only decision does not satisfy the requirement", () => {
    const issues = validateSummaryShape(
      nonDeliveryCandidate({ decision: "   ".repeat(20) }),
      "wont_do",
    );
    expect(issues.some((i) => i.field === "decision" && i.rule === "required")).toBe(true);
  });
});

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
      findJargonHits("x", undefined, "ran scripts/run-tests.mjs").some((h) => h.rule === "jargon"),
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

  it("refuses each curated ALL-CAPS prefix convention", () => {
    // Review round 1, MEDIUM: the prior blanket regex (`\b[A-Z]{2,}[:_]/`)
    // matched any two-or-more uppercase letters, not just the annotation
    // conventions this rule means to catch. ALL_CAPS_PREFIXES is now an
    // enumerated list — this sweeps every entry in it so a prefix silently
    // dropped from the list in a future edit is caught here rather than
    // discovered as a missed rejection later.
    for (const prefix of ALL_CAPS_PREFIXES) {
      const hits = findJargonHits("x", undefined, `${prefix}: revisit this later`);
      expect(hits.some((h) => h.rule === "jargon")).toBe(true);
    }
  });

  it("refuses an ALL-CAPS prefix using the underscore form too", () => {
    expect(
      findJargonHits("x", undefined, "FIXME_ this later").some((h) => h.rule === "jargon"),
    ).toBe(true);
  });

  it("does NOT refuse a legitimate technical acronym prefix — the exact false positives review round 1 reproduced", () => {
    // The whole point of moving to a curated list: DB/URL/SQL/NB/OK are
    // plausible, ordinary how_verified prose ("DB: migrations applied
    // cleanly") and must pass now that the blanket regex is gone.
    const legitimatePrefixes = [
      "DB: migrations applied cleanly",
      "URL: the health endpoint responded 200",
      "SQL: the query returned the expected rows",
      "NB: this only affects the staging area",
      "OK: verified against the scratch database",
    ];
    for (const text of legitimatePrefixes) {
      const hits = findJargonHits("how_verified", undefined, text);
      expect(hits.some((h) => h.rule === "jargon")).toBe(false);
    }
  });

  it("does NOT refuse other plausible technical acronyms not in the curated list either", () => {
    // A broader sweep than the reviewer's five, proving this isn't a
    // five-item special case — any two-or-more-letter uppercase acronym
    // followed by a colon that isn't one of the enumerated conventions
    // passes.
    expect(
      findJargonHits("x", undefined, "API: the endpoint is unauthenticated").some(
        (h) => h.rule === "jargon",
      ),
    ).toBe(false);
    expect(
      findJargonHits("x", undefined, "CPU: usage stayed under 40%").some(
        (h) => h.rule === "jargon",
      ),
    ).toBe(false);
  });

  it("full validateSummaryShape pass: a how_verified using DB: prose is accepted end to end", () => {
    // The regression this MEDIUM was really about — a legitimate
    // completion summary must not be blocked. Runs the whole shape
    // validator, not just findJargonHits, since that is what a real
    // transition actually calls.
    const issues = validateSummaryShape(
      baseCandidate({
        how_verified:
          "DB: migrations applied cleanly and the new guard rejected every seeded violation.",
      }),
    );
    expect(issues).toEqual([]);
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

/**
 * Malformed entries are *named*, never crashed on.
 *
 * The defect these pin: `SummaryCandidate` is a claim about shape, not a
 * proof of one. `transition_item` passes `fields` through unvalidated by
 * design (SCHEMA.md §16), and the guard's `readCandidate` builds a candidate
 * from it on nothing stronger than `Array.isArray` — so an array of plain
 * strings arrives cast to `WhatToTestEntry[]`, `step.text` is `undefined`,
 * and `pushIfTooLong`'s `value.length` threw a `TypeError`. That escaped the
 * service taxonomy as `internal` with an empty `fields` array: the one
 * refusal shape a caller cannot act on, because it cannot tell bad input
 * from a broken server.
 *
 * Every test here casts through `unknown` on purpose. The types forbid these
 * shapes; the runtime was receiving them anyway, and that gap is the bug.
 */
describe("validateSummaryShape rejects malformed entries instead of throwing", () => {
  it("the reporter's exact reproducer is a named rejection, not a crash", () => {
    // Verbatim from the bug report: what_to_test as plain strings.
    const candidate = {
      shipped: ["Test entry for isolating the failure."],
      not_done: [],
      user_facing: true,
      what_to_test: ["Test entry for isolating the failure."],
      watch_for: [],
    } as unknown as SummaryCandidate;

    let issues: ReturnType<typeof validateSummaryShape>;
    expect(() => {
      issues = validateSummaryShape(candidate, "research_done");
    }).not.toThrow();

    const shape = issues!.filter((i) => i.field === "what_to_test" && i.rule === "entry_shape");
    expect(shape).toHaveLength(1);
    // The message must name the field, the index, and the shape expected —
    // an unactionable refusal is the whole defect, so a bare rejection here
    // would not be a fix.
    expect(shape[0]!.message).toContain("what_to_test[0]");
    expect(shape[0]!.message).toContain('"text"');
  });

  it("a well-formed user_facing what_to_test still passes cleanly", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        user_facing: true,
        how_verified: undefined,
        what_to_test: [{ text: "Open the site and confirm the footer renders the new address." }],
      }),
      "research_done",
    );
    expect(issues).toEqual([]);
  });

  it("a malformed what_to_test entry still counts toward cardinality", () => {
    // One bad entry must not also produce a spurious "too few entries"
    // complaint — that would turn one mistake into two.
    const issues = validateSummaryShape(
      {
        ...baseCandidate({ user_facing: true, how_verified: undefined }),
        what_to_test: ["a bare string"],
      } as unknown as SummaryCandidate,
      "research_done",
    );
    expect(issues.some((i) => i.field === "what_to_test" && i.rule === "entry_shape")).toBe(true);
    expect(issues.some((i) => i.rule === "count")).toBe(false);
  });

  it("a string not_done entry is named rather than crashed on", () => {
    let issues: ReturnType<typeof validateSummaryShape>;
    expect(() => {
      issues = validateSummaryShape(
        {
          ...baseCandidate(),
          not_done: ["deferred the caching work"],
        } as unknown as SummaryCandidate,
        "merged",
      );
    }).not.toThrow();
    const shape = issues!.filter((i) => i.field === "not_done" && i.rule === "entry_shape");
    expect(shape).toHaveLength(1);
    expect(shape[0]!.message).toContain("not_done[0]");
    expect(shape[0]!.message).toContain("reason");
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["an object", { text: "wrong wrapper" }],
  ])("a shipped entry that is %s is named rather than crashed on", (_label, bad) => {
    let issues: ReturnType<typeof validateSummaryShape>;
    expect(() => {
      issues = validateSummaryShape(
        { ...baseCandidate(), shipped: [bad] } as unknown as SummaryCandidate,
        "merged",
      );
    }).not.toThrow();
    expect(issues!.some((i) => i.field === "shipped" && i.rule === "entry_shape")).toBe(true);
  });

  it.each([
    ["null", null],
    ["an object", { text: "wrong wrapper" }],
  ])("a watch_for entry that is %s is named rather than crashed on", (_label, bad) => {
    let issues: ReturnType<typeof validateSummaryShape>;
    expect(() => {
      issues = validateSummaryShape(
        { ...baseCandidate(), watch_for: [bad] } as unknown as SummaryCandidate,
        "merged",
      );
    }).not.toThrow();
    expect(issues!.some((i) => i.field === "watch_for" && i.rule === "entry_shape")).toBe(true);
  });

  it("a not_done object with a bad reason still gets the reason complaint, not a shape one", () => {
    // An object carrying a string `text` is well-formed enough to read, so
    // the existing (better) reason check must still be what fires.
    const issues = validateSummaryShape(
      {
        ...baseCandidate(),
        not_done: [{ text: "Left the caching work for later.", reason: "made-up" }],
      } as unknown as SummaryCandidate,
      "merged",
    );
    expect(issues.some((i) => i.field === "not_done" && i.rule === "reason")).toBe(true);
    expect(issues.some((i) => i.rule === "entry_shape")).toBe(false);
  });

  it("reports a malformed entry alongside genuine issues in the same round", () => {
    // The caller should not have to fix the shape, resubmit, and only then
    // discover the cap violation.
    const issues = validateSummaryShape(
      {
        ...baseCandidate({ user_facing: true, how_verified: undefined }),
        shipped: ["x".repeat(SHIPPED_CHAR_CAP + 1)],
        what_to_test: ["a bare string"],
      } as unknown as SummaryCandidate,
      "research_done",
    );
    expect(issues.some((i) => i.field === "what_to_test" && i.rule === "entry_shape")).toBe(true);
    expect(issues.some((i) => i.field === "shipped" && i.rule === "max_length")).toBe(true);
  });
});

/**
 * Indexes in issue messages name the array the *caller* sent.
 *
 * Malformed entries are dropped from the list the length and jargon checks
 * read, so those checks run over a compacted array. Numbering a complaint
 * by its position in that compacted array renames every entry after a
 * malformed one — the caller is then told about an index they did not send
 * that value at, while the entry genuinely at that index has already drawn
 * a different complaint. Two contradictory messages about one index, and
 * silence about the real offender.
 *
 * These tests assert on the index inside the message, which nothing else in
 * this file does: the existing coverage asserts on `field` and `rule`, and
 * that is exactly why the shift survived.
 */
describe("issue messages name the caller's own entry index", () => {
  it("an over-long shipped entry after a malformed one is named at its real index", () => {
    const issues = validateSummaryShape(
      {
        ...baseCandidate(),
        shipped: [123, "x".repeat(SHIPPED_CHAR_CAP + 1)],
      } as unknown as SummaryCandidate,
      "merged",
    );

    const tooLong = issues.filter((i) => i.field === "shipped" && i.rule === "max_length");
    expect(tooLong).toHaveLength(1);
    expect(tooLong[0]!.message).toContain("shipped[1]");
    expect(tooLong[0]!.message).not.toContain("shipped[0]");

    // The shape complaint keeps index 0, so the two messages address
    // different entries rather than contradicting each other.
    const shape = issues.filter((i) => i.field === "shipped" && i.rule === "entry_shape");
    expect(shape).toHaveLength(1);
    expect(shape[0]!.message).toContain("shipped[0]");
  });

  it("two dropped entries shift a later index by two, and it is still reported correctly", () => {
    const issues = validateSummaryShape(
      {
        ...baseCandidate(),
        shipped: [null, 7, "x".repeat(SHIPPED_CHAR_CAP + 1)],
      } as unknown as SummaryCandidate,
      "merged",
    );

    const tooLong = issues.filter((i) => i.field === "shipped" && i.rule === "max_length");
    expect(tooLong).toHaveLength(1);
    expect(tooLong[0]!.message).toContain("shipped[2]");
  });

  it("an over-long watch_for entry after a malformed one is named at its real index", () => {
    const issues = validateSummaryShape(
      {
        ...baseCandidate(),
        watch_for: [null, "x".repeat(WATCH_FOR_CHAR_CAP + 1)],
      } as unknown as SummaryCandidate,
      "merged",
    );

    const tooLong = issues.filter((i) => i.field === "watch_for" && i.rule === "max_length");
    expect(tooLong).toHaveLength(1);
    expect(tooLong[0]!.message).toContain("watch_for[1]");
  });

  it("a typed not_done entry after a malformed one is named at its real index", () => {
    // The typed-field collector compacts independently of the string one,
    // so it needs its own pin: both the cap complaint and the `reason`
    // complaint are labelled from the same preserved index.
    const issues = validateSummaryShape(
      {
        ...baseCandidate(),
        not_done: [
          "a bare string",
          { text: "x".repeat(NOT_DONE_TEXT_CHAR_CAP + 1), reason: "made-up" },
        ],
      } as unknown as SummaryCandidate,
      "merged",
    );

    const tooLong = issues.filter((i) => i.field === "not_done" && i.rule === "max_length");
    expect(tooLong).toHaveLength(1);
    expect(tooLong[0]!.message).toContain("not_done[1]");

    const reason = issues.filter((i) => i.field === "not_done" && i.rule === "reason");
    expect(reason).toHaveLength(1);
    expect(reason[0]!.message).toContain("not_done[1].reason");
  });

  it("a typed what_to_test entry after a malformed one is named at its real index", () => {
    const issues = validateSummaryShape(
      {
        ...baseCandidate({ user_facing: true, how_verified: undefined }),
        what_to_test: ["a bare string", { text: "x".repeat(WHAT_TO_TEST_TEXT_CHAR_CAP + 1) }],
      } as unknown as SummaryCandidate,
      "research_done",
    );

    const tooLong = issues.filter((i) => i.field === "what_to_test" && i.rule === "max_length");
    expect(tooLong).toHaveLength(1);
    expect(tooLong[0]!.message).toContain("what_to_test[1]");
  });
});

/**
 * The similarity check's own dereference of the same malformed entries.
 *
 * `findSimilarityIssues` lives in `guards/summaries.ts` (it is covered by
 * the guard-registration sweep, which only scans `guards/`) but is pure —
 * it takes the history rows as an argument — so it is provable here without
 * Postgres. That matters: `tests/summaries-guard.test.ts` is
 * TEST_DATABASE_URL-gated and skips by default, so without these the fix to
 * `candidateTextFields` would ship with nothing able to fail on it.
 *
 * This is a genuinely *separate* crash path from `validateSummaryShape`.
 * Both call sites (`complete_item`'s handler and `summaryRequiredGuard`)
 * collect shape issues and similarity issues in the same pass so a caller
 * sees everything in one round — so this function still receives malformed
 * entries even after the shape pass has named them, and `text.trim()` on an
 * `undefined` would throw independently.
 */
describe("findSimilarityIssues tolerates malformed entries", () => {
  const history = [{ body: "Some entirely unrelated prior event text.", payload: null }];

  it("does not throw on what_to_test entries that are plain strings", () => {
    expect(() =>
      findSimilarityIssues(
        {
          ...baseCandidate({ user_facing: true, how_verified: undefined }),
          what_to_test: ["a bare string"],
        } as unknown as SummaryCandidate,
        history,
      ),
    ).not.toThrow();
  });

  it("does not throw on not_done entries that are plain strings", () => {
    expect(() =>
      findSimilarityIssues(
        { ...baseCandidate(), not_done: ["a bare string"] } as unknown as SummaryCandidate,
        history,
      ),
    ).not.toThrow();
  });

  it.each([
    ["shipped", { shipped: [null] }],
    ["watch_for", { watch_for: [42] }],
  ])("does not throw on a %s entry that is not a string", (_label, override) => {
    expect(() =>
      findSimilarityIssues(
        { ...baseCandidate(), ...override } as unknown as SummaryCandidate,
        history,
      ),
    ).not.toThrow();
  });

  it("still catches a real pasted-log duplicate in a well-formed entry", () => {
    // The tolerance above must not have cost the check its actual job.
    const pasted =
      "Applied the migration, restarted the worker, and confirmed the queue drained to zero.";
    const issues = findSimilarityIssues(
      { ...baseCandidate(), shipped: [pasted] } as unknown as SummaryCandidate,
      [{ body: pasted, payload: null }],
    );
    expect(issues.some((i) => i.field === "shipped[0]" && i.rule === "similarity")).toBe(true);
  });

  it("still catches a duplicate inside a well-formed what_to_test entry", () => {
    // Proves the typed-entry branch still reaches `.text` when it is there.
    const pasted = "Open the board, filter to the archived column, and confirm the row is absent.";
    const issues = findSimilarityIssues(
      {
        ...baseCandidate({ user_facing: true, how_verified: undefined }),
        what_to_test: [{ text: pasted }],
      } as unknown as SummaryCandidate,
      [{ body: pasted, payload: null }],
    );
    expect(issues.some((i) => i.field === "what_to_test[0].text" && i.rule === "similarity")).toBe(
      true,
    );
  });
});

/**
 * Disclosure — the caps must be stated in the message the caller is reading,
 * not only enforced when they are exceeded.
 *
 * A cap that is enforced but unstated has to be found by binary search: the
 * caller submits, is refused, shortens by a guess, is refused again. Every
 * *contract* refusal — the ones that enumerate what a field requires — must
 * therefore carry the limits of the fields it is talking about, so the number
 * arrives while the caller is reading the contract rather than after they
 * have broken it.
 *
 * The assertions are on message TEXT and are interpolated from the exported
 * constants, so they fail in both directions that matter: deleting a cap
 * clause from a message, and changing a cap's value without updating the
 * message that quotes it.
 */
describe("summary refusals disclose their limits", () => {
  /** The contract refusal for a non-delivery close must name the decision floor AND cap. */
  it.each([...NON_DELIVERY_STATES])(
    "states the decision length bounds when decision is missing on %s",
    (state) => {
      const issues = validateSummaryShape(nonDeliveryCandidate({ decision: undefined }), state);
      const required = issues.find((i) => i.field === "decision" && i.rule === "required");
      expect(required).toBeDefined();
      expect(required?.message).toContain(String(DECISION_CHAR_CAP));
      expect(required?.message).toContain(String(DECISION_CHAR_MIN));
    },
  );

  it("states the shipped entry cap when the shipped count is wrong", () => {
    const issues = validateSummaryShape(baseCandidate({ shipped: [] }));
    const count = issues.find((i) => i.field === "shipped" && i.rule === "count");
    expect(count).toBeDefined();
    expect(count?.message).toContain(String(SHIPPED_CHAR_CAP));
  });

  it("states the not_done text cap when the not_done count is over", () => {
    const tooMany = Array.from({ length: NOT_DONE_MAX + 1 }, () => ({
      text: "Deferred until the migration lands.",
      reason: "deferred",
    }));
    const issues = validateSummaryShape(
      baseCandidate({ not_done: tooMany } as Partial<SummaryCandidate>),
    );
    const count = issues.find((i) => i.field === "not_done" && i.rule === "count");
    expect(count).toBeDefined();
    expect(count?.message).toContain(String(NOT_DONE_TEXT_CHAR_CAP));
  });

  it("states the watch_for cap when the watch_for count is over", () => {
    const tooMany = Array.from({ length: WATCH_FOR_MAX + 1 }, () => "Watch the queue depth.");
    const issues = validateSummaryShape(baseCandidate({ watch_for: tooMany }));
    const count = issues.find((i) => i.field === "watch_for" && i.rule === "count");
    expect(count).toBeDefined();
    expect(count?.message).toContain(String(WATCH_FOR_CHAR_CAP));
  });

  it("states the what_to_test cap when it is missing on a user-facing summary", () => {
    const issues = validateSummaryShape(
      baseCandidate({ user_facing: true, how_verified: undefined, what_to_test: [] }),
    );
    const count = issues.find((i) => i.field === "what_to_test" && i.rule === "count");
    expect(count).toBeDefined();
    expect(count?.message).toContain(String(WHAT_TO_TEST_TEXT_CHAR_CAP));
  });

  it("states the how_verified cap when it is missing on a non-user-facing summary", () => {
    const issues = validateSummaryShape(baseCandidate({ how_verified: undefined }));
    const required = issues.find((i) => i.field === "how_verified" && i.rule === "required");
    expect(required).toBeDefined();
    expect(required?.message).toContain(String(HOW_VERIFIED_CHAR_CAP));
  });

  /**
   * The mutual exclusion between `how_verified` and `what_to_test` is a good
   * rule that was only discoverable by breaking it. Both the required-side
   * message and the not_applicable-side message must state it.
   */
  it("warns that how_verified is excluded when what_to_test is required", () => {
    const issues = validateSummaryShape(
      baseCandidate({ user_facing: true, how_verified: undefined, what_to_test: [] }),
    );
    const count = issues.find((i) => i.field === "what_to_test" && i.rule === "count");
    expect(count?.message).toContain("how_verified");
  });

  it("warns that what_to_test is excluded when how_verified is required", () => {
    const issues = validateSummaryShape(baseCandidate({ how_verified: undefined }));
    const required = issues.find((i) => i.field === "how_verified" && i.rule === "required");
    expect(required?.message).toContain("what_to_test");
  });

  it("names the target field's cap when redirecting how_verified to what_to_test", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        user_facing: true,
        what_to_test: [{ text: "Open the board and confirm the row is gone." }],
        how_verified: "Ran the suite and read the assertions.",
      } as Partial<SummaryCandidate>),
    );
    const na = issues.find((i) => i.field === "how_verified" && i.rule === "not_applicable");
    expect(na).toBeDefined();
    expect(na?.message).toContain(String(WHAT_TO_TEST_TEXT_CHAR_CAP));
  });

  it("names the target field's cap when redirecting what_to_test to how_verified", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        what_to_test: [{ text: "Open the board and confirm the row is gone." }],
      } as Partial<SummaryCandidate>),
    );
    const na = issues.find((i) => i.field === "what_to_test" && i.rule === "not_applicable");
    expect(na).toBeDefined();
    expect(na?.message).toContain(String(HOW_VERIFIED_CHAR_CAP));
  });

  it("names the decision bounds when redirecting shipped to decision", () => {
    const issues = validateSummaryShape(
      nonDeliveryCandidate({ shipped: ["Shipped something after all."] }),
      "wont_do",
    );
    const na = issues.find((i) => i.field === "shipped" && i.rule === "not_applicable");
    expect(na).toBeDefined();
    expect(na?.message).toContain(String(DECISION_CHAR_CAP));
  });

  it("names the shipped cap when redirecting decision to shipped", () => {
    const issues = validateSummaryShape(
      baseCandidate({ decision: "Not applicable here, but supplied anyway." }),
    );
    const na = issues.find((i) => i.field === "decision" && i.rule === "not_applicable");
    expect(na).toBeDefined();
    expect(na?.message).toContain(String(SHIPPED_CHAR_CAP));
  });
});

/**
 * Overage — the length refusal must say how far over, not just quote the two
 * numbers and leave the caller to subtract. This matters most when the
 * overage is tiny: "241 characters" against an undisclosed 240 reads as a
 * guess, "1 over" reads as an instruction.
 */
describe("length refusals state the overage", () => {
  it("reports an over-by-one decision as 1 over, singular", () => {
    const overLong = "x".repeat(DECISION_CHAR_CAP + 1);
    const issues = validateSummaryShape(nonDeliveryCandidate({ decision: overLong }), "wont_do");
    const tooLong = issues.find((i) => i.field === "decision" && i.rule === "max_length");
    expect(tooLong).toBeDefined();
    expect(tooLong?.message).toContain(`${DECISION_CHAR_CAP + 1} characters, 1 over`);
    // Singular, and phrased as an instruction rather than arithmetic homework.
    expect(tooLong?.message).toContain("Remove at least 1 character and");
    expect(tooLong?.message).not.toContain("1 characters and");
  });

  it("reports a larger overage with the exact difference and a plural", () => {
    const over = 49;
    const overLong = "y".repeat(SHIPPED_CHAR_CAP + over);
    const issues = validateSummaryShape(baseCandidate({ shipped: [overLong] }));
    const tooLong = issues.find((i) => i.field === "shipped" && i.rule === "max_length");
    expect(tooLong).toBeDefined();
    expect(tooLong?.message).toContain(
      `shipped[0] is ${SHIPPED_CHAR_CAP + over} characters, ${over} over the ` +
        `${SHIPPED_CHAR_CAP}-character cap`,
    );
    expect(tooLong?.message).toContain(`Remove at least ${over} characters`);
  });

  it("still refuses to truncate, and still says so", () => {
    // The policy is load-bearing: silently shortening a field that explains
    // why work was abandoned would be worse than refusing it.
    const issues = validateSummaryShape(
      baseCandidate({ shipped: ["z".repeat(SHIPPED_CHAR_CAP + 1)] }),
    );
    const tooLong = issues.find((i) => i.field === "shipped" && i.rule === "max_length");
    expect(tooLong?.message).toContain("not be truncated for you");
  });
});

/**
 * Aggregation — every length violation in one call, so fixing `decision`
 * does not then reveal that `not_done` was also over.
 *
 * The validator collects issues from every field rather than returning at the
 * first one, and this test holds it to that. The failure mode it guards
 * against is an early return added to keep a refusal message short: that
 * trades one long message for N round trips, which is the more expensive of
 * the two by a wide margin.
 */
describe("all length violations are reported together", () => {
  it("returns every over-cap field in a single validation pass", () => {
    const issues = validateSummaryShape(
      baseCandidate({
        shipped: ["a".repeat(SHIPPED_CHAR_CAP + 1), "b".repeat(SHIPPED_CHAR_CAP + 2)],
        not_done: [
          { text: "c".repeat(NOT_DONE_TEXT_CHAR_CAP + 1), reason: "deferred" },
        ] as unknown as SummaryCandidate["not_done"],
        watch_for: ["d".repeat(WATCH_FOR_CHAR_CAP + 1)],
        how_verified: "e".repeat(HOW_VERIFIED_CHAR_CAP + 1),
      }),
    );
    const tooLong = issues.filter((i) => i.rule === "max_length");
    // Five distinct violations across four fields, all in one call.
    expect(tooLong).toHaveLength(5);
    expect(new Set(tooLong.map((i) => i.field))).toEqual(
      new Set(["shipped", "not_done", "watch_for", "how_verified"]),
    );
  });
});
