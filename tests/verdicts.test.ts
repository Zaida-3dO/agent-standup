// The tiered review vocabulary — SCHEMA.md §6a, src/lib/verdicts.ts.
//
// Pure units, no database. What these assert is which verdicts a merge may
// rest on, which is a decision worth pinning down independently of whether
// any particular row exists.
import { describe, expect, it } from "vitest";
import {
  APPROVING_VERDICTS,
  VERDICTS,
  isApprovingVerdict,
  isVerdict,
  requiresLinkedFollowUp,
} from "@/lib/verdicts";

describe("the verdict vocabulary", () => {
  it("holds exactly the six labels the schema's enum holds", () => {
    // Single-character mutation this catches: dropping any one entry from
    // VERDICTS, or adding one, changes this set. It is deliberately spelled
    // out rather than compared against a derived list — a test that computed
    // the expectation from the same array would pass for any array.
    expect([...VERDICTS].sort()).toEqual(
      [
        "approved",
        "changes_required",
        "lgtm",
        "lgtm_with_followups",
        "lgtm_with_nits",
        "na",
      ].sort(),
    );
  });

  it("recognises every label, and refuses one that only looks like a label", () => {
    for (const verdict of VERDICTS) {
      expect(isVerdict(verdict)).toBe(true);
    }
    // The hyphenated spelling is the one a source store or a human would
    // naturally write, and it is NOT a database label — the enum uses
    // underscores throughout, like every other enum in this schema.
    expect(isVerdict("lgtm-with-nits")).toBe(false);
    expect(isVerdict("LGTM")).toBe(false);
    expect(isVerdict("")).toBe(false);
    expect(isVerdict(null)).toBe(false);
    expect(isVerdict(undefined)).toBe(false);
  });
});

describe("which verdicts approve", () => {
  it("counts all three lgtm tiers, plus the legacy label, as approvals", () => {
    // Single-character mutation this catches: removing any one entry from
    // APPROVING_VERDICTS. Each of these is asserted individually rather than
    // as one set comparison so a failure names the tier that broke.
    expect(isApprovingVerdict("lgtm")).toBe(true);
    expect(isApprovingVerdict("lgtm_with_nits")).toBe(true);
    expect(isApprovingVerdict("lgtm_with_followups")).toBe(true);
    expect(isApprovingVerdict("approved")).toBe(true);
  });

  it("does NOT count changes_required, na, null, or an unrecognised string", () => {
    // `na` is the interesting one: it is a legal verdict, so a set built by
    // "everything that is not changes_required" would wrongly include it and
    // let an item merge on the strength of an artifact that reviewed nothing.
    expect(isApprovingVerdict("na")).toBe(false);
    expect(isApprovingVerdict("changes_required")).toBe(false);
    expect(isApprovingVerdict(null)).toBe(false);
    expect(isApprovingVerdict(undefined)).toBe(false);
    expect(isApprovingVerdict("lgtm-with-nits")).toBe(false);
    expect(isApprovingVerdict("approve")).toBe(false);
  });

  it("keeps the approving set a strict subset of the vocabulary", () => {
    for (const verdict of APPROVING_VERDICTS) {
      expect(isVerdict(verdict)).toBe(true);
    }
    expect(APPROVING_VERDICTS.length).toBeLessThan(VERDICTS.length);
  });
});

describe("which verdict requires a linked follow-up", () => {
  it("requires one for lgtm_with_followups and for nothing else", () => {
    // Single-character mutation this catches: broadening the comparison in
    // requiresLinkedFollowUp (e.g. to `startsWith("lgtm")`) would make the
    // next three assertions fail — and that broadening is exactly the
    // plausible mistake, because all three tiers start with the same word.
    expect(requiresLinkedFollowUp("lgtm_with_followups")).toBe(true);
    expect(requiresLinkedFollowUp("lgtm")).toBe(false);
    expect(requiresLinkedFollowUp("lgtm_with_nits")).toBe(false);
    expect(requiresLinkedFollowUp("approved")).toBe(false);
    expect(requiresLinkedFollowUp("changes_required")).toBe(false);
    expect(requiresLinkedFollowUp(null)).toBe(false);
    expect(requiresLinkedFollowUp(undefined)).toBe(false);
  });

  it("requires one only for a verdict that also approves", () => {
    // Stated as its own property because the two ideas are independent and
    // could drift: a verdict that demanded a follow-up but did not approve
    // would be a requirement nothing ever evaluates, since the merge is
    // already refused for lack of an approval.
    for (const verdict of VERDICTS) {
      if (requiresLinkedFollowUp(verdict)) {
        expect(isApprovingVerdict(verdict)).toBe(true);
      }
    }
  });
});
