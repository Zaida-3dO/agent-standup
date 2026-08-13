// Review findings and their severity vocabulary — SCHEMA.md §6a,
// src/lib/findings.ts. Pure units, no database.
import { describe, expect, it } from "vitest";
import {
  FINDING_SEVERITIES,
  InvalidFindingError,
  isAtLeastSeverity,
  isFindingSeverity,
  parseFindings,
  severityRank,
} from "@/lib/findings";

describe("the severity vocabulary", () => {
  it("is ordered least to most severe", () => {
    // Single-character mutation this catches: swapping any adjacent pair in
    // FINDING_SEVERITIES. The order is not cosmetic — severityRank is the
    // array index, so every "at least this severe" comparison in the system
    // reads its answer off this ordering.
    expect(FINDING_SEVERITIES).toEqual(["info", "low", "medium", "high", "critical"]);
    expect(severityRank("info")).toBeLessThan(severityRank("low")!);
    expect(severityRank("low")).toBeLessThan(severityRank("medium")!);
    expect(severityRank("medium")).toBeLessThan(severityRank("high")!);
    expect(severityRank("high")).toBeLessThan(severityRank("critical")!);
  });

  it("refuses a value that is not on the ladder, rather than ranking it below the lowest", () => {
    // `null`, not -1, deliberately: a caller comparing ranks numerically
    // would read -1 as "less severe than info" and silently order an
    // unrecognised value below a real one.
    expect(isFindingSeverity("blocker")).toBe(false);
    expect(isFindingSeverity("MEDIUM")).toBe(false);
    expect(isFindingSeverity(3)).toBe(false);
    expect(isFindingSeverity(null)).toBe(false);
    expect(severityRank("blocker")).toBeNull();
    expect(severityRank(undefined)).toBeNull();
  });

  it("treats 'at least' as inclusive of the floor, and never true for an unrecognised value", () => {
    expect(isAtLeastSeverity("medium", "medium")).toBe(true);
    expect(isAtLeastSeverity("high", "medium")).toBe(true);
    expect(isAtLeastSeverity("critical", "medium")).toBe(true);
    // Single-character mutation this catches: flipping `>=` to `>` in
    // isAtLeastSeverity breaks the first assertion above; flipping it to `<`
    // breaks the next two.
    expect(isAtLeastSeverity("low", "medium")).toBe(false);
    expect(isAtLeastSeverity("info", "medium")).toBe(false);
    expect(isAtLeastSeverity("blocker", "medium")).toBe(false);
    expect(isAtLeastSeverity(undefined, "info")).toBe(false);
  });
});

describe("parsing a findings list", () => {
  it("accepts a well-formed list and preserves each entry", () => {
    const parsed = parseFindings([
      { text: "the retry path is untested", severity: "medium", where: "src/lib/retry.ts" },
      { text: "a stray console call" },
    ]);
    expect(parsed).toEqual([
      { text: "the retry path is untested", severity: "medium", where: "src/lib/retry.ts" },
      { text: "a stray console call" },
    ]);
  });

  it("leaves an ungraded finding ungraded rather than defaulting its severity", () => {
    // A historical review that never graded its findings did not grade them.
    // Defaulting would put a level nobody chose into the one field the
    // column exists to preserve — "ungraded" and "graded low" are different
    // claims and only one of them is true.
    const parsed = parseFindings([{ text: "no severity recorded" }]);
    expect(parsed[0]).not.toHaveProperty("severity");
  });

  it("refuses a non-array", () => {
    expect(() => parseFindings({ text: "x" })).toThrow(InvalidFindingError);
    expect(() => parseFindings(null)).toThrow(/must be an array/);
    expect(() => parseFindings("some prose")).toThrow(/must be an array/);
  });

  it("refuses an entry with no text, and names which entry", () => {
    // Naming the index matters at import scale: "one of your 1,117 findings
    // is malformed" is not a fixable error message.
    expect(() => parseFindings([{ text: "fine" }, { severity: "low" }])).toThrow(/findings\[1\]/);
    expect(() => parseFindings([{ text: "   " }])).toThrow(/findings\[0\]/);
    expect(() => parseFindings([{ text: 7 }])).toThrow(/non-empty string/);
    expect(() => parseFindings(["just a string"])).toThrow(/must be an object/);
  });

  it("refuses an off-vocabulary severity instead of silently dropping it", () => {
    // The rejection is the point. A coercing parser that dropped the
    // unrecognised severity would produce a list that looks complete and is
    // not, and no later reader could tell which entries lost their grade.
    expect(() => parseFindings([{ text: "x", severity: "blocker" }])).toThrow(
      /is not one of info, low, medium, high, critical/,
    );
    expect(() => parseFindings([{ text: "x", severity: "MEDIUM" }])).toThrow(InvalidFindingError);
    expect(() => parseFindings([{ text: "x", where: 3 }])).toThrow(/where must be a string/);
  });

  it("refuses the whole list when any one entry is bad, rather than returning the good ones", () => {
    const mixed = [{ text: "good" }, { text: "also good" }, { severity: "low" }];
    expect(() => parseFindings(mixed)).toThrow(InvalidFindingError);
  });
});
