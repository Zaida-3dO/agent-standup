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

  it("refuses a non-array WITHOUT inventing an index, and names the shape it wanted", () => {
    // The regression this pins (row 94eed34b): the not-an-array branch used
    // to throw `InvalidFindingError(0, ...)`, rendering
    // `findings[0]: findings must be an array` — a message that reads as
    // though the validator had parsed an array and found its first ELEMENT
    // to be a non-array. It had not; the 0 was a placeholder for an index
    // that did not exist. A reviewer sending the correct shape read it as a
    // demand for a nesting level and could not find one.
    //
    // Single-character mutation this catches: changing `null` back to `0` in
    // the `!Array.isArray` branch of parseFindings makes the message
    // `findings[0]: ...` again and fails the `not.toMatch(/findings\[/)`.
    expect(() => parseFindings({ text: "x" })).toThrow(InvalidFindingError);
    for (const notAList of [null, "some prose", { text: "x" }, 7]) {
      let message = "";
      try {
        parseFindings(notAList);
      } catch (error) {
        message = (error as Error).message;
      }
      // No fabricated element index for a whole-list fault...
      expect(message).not.toMatch(/findings\[/);
      expect(message).toMatch(/^findings: /);
      // ...and the message states the shape that WOULD be accepted, which is
      // the thing a caller guessing at the field actually needs.
      expect(message).toMatch(/array of objects/);
      expect(message).toMatch(/text/);
      expect(message).toMatch(/info\|low\|medium\|high\|critical/);
    }
  });

  it("tells a caller who sent a JSON string of the right array exactly that", () => {
    // The near-miss worth its own branch: a caller one JSON.parse from
    // correct. "a string" would not tell them what to change.
    // Mutation this catches: deleting the `startsWith("[")` test in
    // describeReceived collapses this to the generic "a string" wording.
    let message = "";
    try {
      parseFindings(JSON.stringify([{ text: "x", severity: "medium" }]));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/JSON-encoded string/);
    expect(message).toMatch(/not a string containing it/);
  });

  it("still indexes the entry when the fault IS a particular entry", () => {
    // The other half of the same distinction: `index` is null only for a
    // whole-list fault. An entry fault must still name its position, or the
    // import-scale case ("one of your 1,117 findings") stops being fixable.
    const error = (() => {
      try {
        parseFindings([{ text: "fine" }, "not an object"]);
      } catch (caught) {
        return caught as InvalidFindingError;
      }
    })();
    expect(error).toBeInstanceOf(InvalidFindingError);
    expect(error!.index).toBe(1);
    expect(error!.message).toMatch(/^findings\[1\]: /);
    // And it names the element shape, not merely "must be an object".
    expect(error!.message).toMatch(/text, severity\?, where\?/);
  });

  it("refuses an entry with no text, and names which entry", () => {
    // Naming the index matters at import scale: "one of your 1,117 findings
    // is malformed" is not a fixable error message.
    expect(() => parseFindings([{ text: "fine" }, { severity: "low" }])).toThrow(/findings\[1\]/);
    expect(() => parseFindings([{ text: "   " }])).toThrow(/findings\[0\]/);
    expect(() => parseFindings([{ text: 7 }])).toThrow(/non-empty string/);
    expect(() => parseFindings(["just a string"])).toThrow(/must be an object/);
    // A whole-list fault carries a null index; an entry fault carries its own.
    expect(() => parseFindings([{ text: "fine" }, { severity: "low" }])).toThrow(
      /findings\[1\]: text is required/,
    );
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
