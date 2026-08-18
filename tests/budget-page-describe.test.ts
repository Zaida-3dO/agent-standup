// The three boundary kinds in plain words — MILESTONES.md #87.
//
// The phrasing *is* the behaviour this row asks for: §17.4 tabulates each
// kind with how it should read, and a boundary a reader cannot say out loud
// is one they cannot check. Asserting the sentences is therefore asserting
// the feature, not its presentation.
import { describe, expect, it } from "vitest";
import { describeAnchor, describeBoundary, KIND_HELP } from "@/lib/budget-page/describe";

describe("describeBoundary — constant", () => {
  it("reads as a percentage", () => {
    expect(describeBoundary({ kind: "constant", value: 80 })).toBe("80%");
  });

  it("does not pad a whole number with decimals", () => {
    expect(describeBoundary({ kind: "constant", value: 92 })).toBe("92%");
  });

  it("keeps a fractional value readable rather than exact", () => {
    expect(describeBoundary({ kind: "constant", value: 87.456 })).toBe("87.46%");
  });
});

describe("describeBoundary — linear", () => {
  it("reads as a rate and a starting point", () => {
    expect(describeBoundary({ kind: "linear", slope: 15, offset: -5, per: "day" })).toBe(
      "15% per day, starting at -5%",
    );
  });

  // A zero offset is not worth a clause: "15% per day, starting at 0%" says
  // less than "15% per day" while taking longer to read.
  it("omits the starting point when there is none", () => {
    expect(describeBoundary({ kind: "linear", slope: 4, offset: 0, per: "hour" })).toBe(
      "4% per hour",
    );
  });
});

describe("describeAnchor", () => {
  it("says the start plainly rather than as zero", () => {
    expect(describeAnchor({ elapsed: 0, per: "hour" })).toBe("from the start");
  });

  it("reads an elapsed anchor forwards", () => {
    expect(describeAnchor({ elapsed: 3, per: "day" })).toBe("after 3 days");
  });

  it("reads a remaining anchor from the end", () => {
    expect(describeAnchor({ remaining: 1, per: "hour" })).toBe("in the final 1 hour");
  });

  it("says the very end plainly rather than as zero remaining", () => {
    expect(describeAnchor({ remaining: 0, per: "hour" })).toBe("at the very end");
  });

  // Singular and plural, because "1 hours" is the kind of detail that makes
  // a reader distrust everything else on the page.
  it("matches the unit to the count", () => {
    expect(describeAnchor({ elapsed: 1, per: "hour" })).toBe("after 1 hour");
    expect(describeAnchor({ elapsed: 2, per: "hour" })).toBe("after 2 hours");
  });
});

describe("describeBoundary — schedule", () => {
  // Described entry by entry rather than summarised, because the sequence
  // is the thing a reader came to check — "three steps" would hide it.
  it("reads as a sequence, in order", () => {
    const words = describeBoundary({
      kind: "schedule",
      entries: [
        { at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 80 } },
        { at: { remaining: 1, per: "hour" }, value: { kind: "constant", value: 92 } },
      ],
    });
    expect(words).toBe("80% from the start, then 92% in the final 1 hour");
  });

  it("describes an entry holding a linear as a rate", () => {
    const words = describeBoundary({
      kind: "schedule",
      entries: [
        {
          at: { elapsed: 2, per: "hour" },
          value: { kind: "linear", slope: 3, offset: 10, per: "hour" },
        },
      ],
    });
    expect(words).toBe("3% per hour, starting at 10% after 2 hours");
  });
});

describe("KIND_HELP", () => {
  it("explains every kind a boundary can be", () => {
    expect(Object.keys(KIND_HELP).sort()).toEqual(["constant", "linear", "schedule"]);
    for (const help of Object.values(KIND_HELP)) {
      expect(help.length).toBeGreaterThan(20);
    }
  });
});
