// The Reviews tab's pure derivations: the verdict tiers and the findings
// read-back.
//
// Both run with no DOM and no database — plain functions over plain data,
// which is why the display decisions live in `@/lib/item-detail/*` rather
// than inside the components. Same split as `tests/item-detail-view.test.ts`.
import { describe, expect, it } from "vitest";
import { VERDICTS } from "@/lib/verdicts";
import {
  allVerdictDisplays,
  verdictDisplay,
  type VerdictTone,
} from "@/lib/item-detail/verdicts-display";
import {
  displayFindings,
  groupFindingsBySeverity,
  highestSeverity,
  severityLabel,
} from "@/lib/item-detail/findings-view";
import { FINDING_SEVERITIES } from "@/lib/findings";

describe("verdict tiers", () => {
  it("gives every verdict in the vocabulary its own display", () => {
    // Ranges over `VERDICTS` rather than a list written here, so a verdict
    // added to the enum fails this until it is given a label and a meaning —
    // the drift that would otherwise let a tier reach a reader as its raw
    // identifier.
    for (const verdict of VERDICTS) {
      const display = verdictDisplay(verdict);
      expect(display.label).toBeTruthy();
      expect(display.meaning).toBeTruthy();
      // The label is not the id with its underscores removed. That IS the
      // defect: `lgtm_with_nits` reaching a reader as "lgtm with nits".
      expect(display.label).not.toBe(verdict.replace(/_/g, " "));
    }
  });

  it("gives all six verdicts distinguishable labels", () => {
    // The acceptance criterion, asserted directly: no two verdicts may read
    // the same. Deleting one entry from `DISPLAY` makes that verdict fall
    // through to `unknownDisplay`, whose label is the raw value — which
    // still differs from the others, so this alone would not catch it;
    // the meanings check below is what does.
    const labels = allVerdictDisplays().map((display) => display.label);
    expect(new Set(labels).size).toBe(VERDICTS.length);
  });

  it("gives all six verdicts distinguishable meanings", () => {
    const meanings = allVerdictDisplays().map((display) => display.meaning);
    expect(new Set(meanings).size).toBe(VERDICTS.length);
  });

  it("separates the two lgtm-with-work tiers from a clean lgtm", () => {
    // The distinction the task exists to restore. `lgtm` merges on its own;
    // the other two say something else must still happen, and a UI that
    // paints all three identically has flattened the reviewer's actual
    // message. Changing `lgtm_with_nits`'s tone to "pass" fails this.
    expect(verdictDisplay("lgtm").tone).toBe("pass");
    expect(verdictDisplay("lgtm_with_nits").tone).toBe("pass_with_work");
    expect(verdictDisplay("lgtm_with_followups").tone).toBe("pass_with_work");
  });

  it("separates nits from follow-ups in what they oblige", () => {
    // Same tone, different obligation: nits are owed against THIS change,
    // follow-ups are owed as separate filed work. Two tiers sharing a tone
    // must not share a sentence.
    const nits = verdictDisplay("lgtm_with_nits");
    const followups = verdictDisplay("lgtm_with_followups");
    expect(nits.meaning).not.toBe(followups.meaning);
    expect(followups.meaning.toLowerCase()).toContain("follow-up");
  });

  it("reads changes_required as blocked and na as neither", () => {
    // `na` means "this artifact has no verdict to give". Painting it as a
    // pass would let evidence read as an approval; painting it as blocked
    // would report a refusal nobody made. Changing either `tone` here
    // fails.
    expect(verdictDisplay("changes_required").tone).toBe("blocked");
    expect(verdictDisplay("na").tone).toBe("neutral");
  });

  it("treats approved as a pass, since the gate does", () => {
    expect(verdictDisplay("approved").tone).toBe("pass");
  });

  it("shows an unrecognised verdict as stored, and claims nothing about it", () => {
    // A verdict this build has never heard of keeps its raw value on screen
    // — the only true thing available — and takes the tone that asserts
    // nothing. Returning "pass" here would let an unknown value read as an
    // approval.
    const display = verdictDisplay("lgtm_with_reservations");
    expect(display.label).toBe("lgtm_with_reservations");
    expect(display.tone).toBe<VerdictTone>("neutral");
  });
});

describe("findings, read back", () => {
  it("reads a well-formed findings list", () => {
    const findings = displayFindings([
      { text: "Unbounded read", severity: "high", where: "src/a.ts:12" },
      { text: "Naming", severity: "info" },
    ]);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({
      text: "Unbounded read",
      severity: "high",
      where: "src/a.ts:12",
      malformed: false,
    });
    expect(findings[1]?.where).toBeNull();
  });

  it("returns nothing for null, for absent, and for a non-array", () => {
    // All three mean "no findings to show" on screen, and none of them may
    // throw — a view that threw would take out the whole tab, including the
    // well-formed findings beside the bad row.
    expect(displayFindings(null)).toEqual([]);
    expect(displayFindings(undefined)).toEqual([]);
    expect(displayFindings({ text: "not a list" })).toEqual([]);
    expect(displayFindings("findings")).toEqual([]);
  });

  it("keeps a malformed entry, marked, rather than dropping it", () => {
    // The one genuinely dangerous option is silence: a findings list is the
    // material for "is this safe to merge", and showing two of three gives a
    // confident answer built on a list the reader believes is whole.
    // Changing `displayFindings` to filter these out fails here.
    const findings = displayFindings([
      { text: "Real finding", severity: "low" },
      { severity: "critical" },
      42,
    ]);
    expect(findings).toHaveLength(3);
    expect(findings[0]?.malformed).toBe(false);
    expect(findings[1]?.malformed).toBe(true);
    expect(findings[2]?.malformed).toBe(true);
  });

  it("treats an unrecognised severity as ungraded, never as a level", () => {
    // "ungraded" and "graded low" are different claims. Coercing an
    // unrecognised label into a real level would sort it among the graded
    // findings and misreport how severe the review actually was.
    const [finding] = displayFindings([{ text: "x", severity: "catastrophic" }]);
    expect(finding?.severity).toBeNull();
  });

  it("groups by severity, most severe first, ungraded last", () => {
    // The ordering IS the feature: the group that changes a merge decision
    // must not be below the fold. Reversing the loop in
    // `groupFindingsBySeverity` fails this.
    const groups = groupFindingsBySeverity(
      displayFindings([
        { text: "a", severity: "info" },
        { text: "b" },
        { text: "c", severity: "critical" },
        { text: "d", severity: "medium" },
      ]),
    );
    expect(groups.map((group) => group.severity)).toEqual(["critical", "medium", "info", null]);
  });

  it("emits no group for a severity nothing was graded at", () => {
    const groups = groupFindingsBySeverity(displayFindings([{ text: "a", severity: "high" }]));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.severity).toBe("high");
  });

  it("preserves the order the reviewer wrote them, within a group", () => {
    // Nothing better exists to replace the reviewer's own sequencing with,
    // so it is kept. Sorting inside a group fails this.
    const groups = groupFindingsBySeverity(
      displayFindings([
        { text: "second", severity: "low" },
        { text: "first", severity: "low" },
      ]),
    );
    expect(groups[0]?.findings.map((finding) => finding.text)).toEqual(["second", "first"]);
  });

  it("reports the most severe grade present", () => {
    // What the review's lead line says, so a reader learns whether opening
    // the groups matters without opening them.
    expect(highestSeverity(displayFindings([{ text: "a", severity: "low" }]))).toBe("low");
    expect(
      highestSeverity(
        displayFindings([
          { text: "a", severity: "low" },
          { text: "b", severity: "critical" },
          { text: "c", severity: "medium" },
        ]),
      ),
    ).toBe("critical");
  });

  it("reports no most-severe grade when nothing is graded", () => {
    expect(highestSeverity(displayFindings([{ text: "a" }]))).toBeNull();
    expect(highestSeverity([])).toBeNull();
  });

  it("labels every severity in the ladder, and the ungraded group", () => {
    for (const severity of FINDING_SEVERITIES) {
      expect(severityLabel(severity)).toBe(severity.charAt(0).toUpperCase() + severity.slice(1));
    }
    expect(severityLabel(null)).toBe("Ungraded");
  });
});
