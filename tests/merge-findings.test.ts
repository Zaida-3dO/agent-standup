// The severity rule the merge gate applies to a review's findings —
// `src/lib/service/guards/merge-findings.ts`, SCHEMA.md §6a.
//
// Pure functions over a verdict and a findings document, so no database:
// these decide whether a merge is allowed, and they are testable without one.
// The composed behaviour — that the gate grades the artifact it actually
// rests on, and that the override/historical paths return before this clause
// — is asserted against Postgres in `merge-guards.test.ts`.
import { describe, expect, it } from "vitest";
import {
  BLOCKING_SEVERITY_FLOOR,
  SEVERITY_GATED_VERDICT,
  blockingFindings,
  describeBlockingFindings,
} from "@/lib/service/guards";

const MEDIUM = { text: "the retry path is untested", severity: "medium" };
const LOW = { text: "a stray log line", severity: "low" };

describe("blockingFindings — which findings stop a merge", () => {
  describe("the gated verdict", () => {
    it("blocks a medium finding under lgtm_with_nits", () => {
      const blocking = blockingFindings(SEVERITY_GATED_VERDICT, [MEDIUM]);
      expect(blocking).toHaveLength(1);
      expect(blocking[0]).toMatchObject({ severity: "medium", text: MEDIUM.text });
    });

    it("blocks high and critical too", () => {
      for (const severity of ["high", "critical"]) {
        const blocking = blockingFindings(SEVERITY_GATED_VERDICT, [{ text: "x", severity }]);
        expect(blocking).toHaveLength(1);
      }
    });

    it("does NOT block info or low — nits are what the verdict is for", () => {
      for (const severity of ["info", "low"]) {
        expect(blockingFindings(SEVERITY_GATED_VERDICT, [{ text: "x", severity }])).toEqual([]);
      }
    });

    it("returns every blocking finding, not just the first", () => {
      const blocking = blockingFindings(SEVERITY_GATED_VERDICT, [
        MEDIUM,
        LOW,
        { text: "second real one", severity: "high" },
      ]);
      expect(blocking.map((f) => f.text)).toEqual([MEDIUM.text, "second real one"]);
    });

    it("carries `where` through when present, and omits it when absent", () => {
      const withWhere = blockingFindings(SEVERITY_GATED_VERDICT, [
        { ...MEDIUM, where: "src/a.ts:1" },
      ]);
      expect(withWhere[0]?.where).toBe("src/a.ts:1");
      const without = blockingFindings(SEVERITY_GATED_VERDICT, [MEDIUM]);
      expect(without[0]).not.toHaveProperty("where");
    });
  });

  describe("the ungated verdicts — the deliberate asymmetry", () => {
    // The property most likely to be "corrected" by a later reader who reads
    // it as an oversight. A plain `lgtm` makes no claim about what was found;
    // a reviewer recording a critical finding under it has stated
    // attributably that it does not block, and reading severity there would
    // let an observation silently overrule an explicit approval.
    it("does not read severity under lgtm, approved, or lgtm_with_followups", () => {
      for (const verdict of ["lgtm", "approved", "lgtm_with_followups"]) {
        expect(blockingFindings(verdict, [{ text: "boom", severity: "critical" }])).toEqual([]);
      }
    });

    it("does not read severity under a non-approving or unknown verdict either", () => {
      // Those never reach this clause — an unapproved review is refused
      // earlier — so this asserts the function does not invent a second,
      // independent rejection path for them.
      for (const verdict of ["changes_required", "na", "not-a-verdict", null]) {
        expect(blockingFindings(verdict, [{ text: "boom", severity: "critical" }])).toEqual([]);
      }
    });
  });

  describe("what is not gradeable does not block", () => {
    it("treats an ungraded finding as not blocking", () => {
      // Absent severity is "ungraded", a different claim from "graded low".
      // Blocking on it would be the gate grading what the reviewer declined
      // to grade, and every pre-vocabulary review is ungraded.
      expect(blockingFindings(SEVERITY_GATED_VERDICT, [{ text: "no severity here" }])).toEqual([]);
    });

    it("treats an unrecognised severity as not blocking", () => {
      expect(
        blockingFindings(SEVERITY_GATED_VERDICT, [{ text: "x", severity: "catastrophic" }]),
      ).toEqual([]);
    });

    it("returns nothing for null, undefined, or an empty list", () => {
      expect(blockingFindings(SEVERITY_GATED_VERDICT, null)).toEqual([]);
      expect(blockingFindings(SEVERITY_GATED_VERDICT, undefined)).toEqual([]);
      expect(blockingFindings(SEVERITY_GATED_VERDICT, [])).toEqual([]);
    });

    it("returns nothing for a document that does not parse, rather than throwing", () => {
      // A malformed row must not become an item that can never merge, refused
      // for a column the merging party did not write and cannot correct.
      for (const malformed of [{ not: "an array" }, "[]", [{ noText: true }], [null], 42]) {
        expect(() => blockingFindings(SEVERITY_GATED_VERDICT, malformed)).not.toThrow();
        expect(blockingFindings(SEVERITY_GATED_VERDICT, malformed)).toEqual([]);
      }
    });

    it("blocks on the valid entries only when the whole document parses", () => {
      // parseFindings refuses per-entry rather than dropping, so a list with
      // one bad entry is entirely unreadable — asserted so a future switch to
      // a coercing parser, which would silently change what gates, fails here.
      expect(blockingFindings(SEVERITY_GATED_VERDICT, [MEDIUM, { noText: true }])).toEqual([]);
    });
  });

  describe("the constants are the ones the rule is stated in", () => {
    it("gates beneath lgtm_with_nits, with a floor of medium", () => {
      expect(SEVERITY_GATED_VERDICT).toBe("lgtm_with_nits");
      expect(BLOCKING_SEVERITY_FLOOR).toBe("medium");
    });
  });
});

describe("describeBlockingFindings — what the refusal quotes", () => {
  it("quotes severity and text, one per line", () => {
    const text = describeBlockingFindings([{ severity: "medium", text: "the retry path" }]);
    expect(text).toBe("  - [medium] the retry path");
  });

  it("appends `where` in parentheses when present", () => {
    const text = describeBlockingFindings([
      { severity: "high", text: "leak", where: "src/a.ts:12" },
    ]);
    expect(text).toContain("(src/a.ts:12)");
  });

  it("truncates past five and says how many remain", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      severity: "medium",
      text: `finding ${i}`,
    }));
    const text = describeBlockingFindings(many);
    expect(text).toContain("finding 4");
    expect(text).not.toContain("finding 5");
    expect(text).toContain("and 3 more");
  });

  it("does not add a remainder line at exactly five", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      severity: "medium",
      text: `finding ${i}`,
    }));
    expect(describeBlockingFindings(five)).not.toContain("more");
  });
});
