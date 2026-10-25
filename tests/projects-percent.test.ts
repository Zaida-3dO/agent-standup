// The percentage a project's progress label prints — `percentOf`.
//
// **What would make this file hollow.** Asserting that 1 of 2 reads 50 proves
// the rounding and nothing else; every implementation passes it. The
// assertions that carry weight are the ones at the two ends, where a
// whole-number label tells a lie:
//
//   - 880 of 882 children closed must NOT read 100, and 1 of 500 must NOT
//     read 0 — the label has to be able to say "nearly" in both directions,
//   - the decimal that fixes it must not itself round into the lie: 1999 of
//     2000 is 99.95 before the clamp and would print 100 without it,
//   - 100 and 0 must still be reachable, and only by "all" and "none" —
//     otherwise the fix just moves the lie.
//
// Each test names the single-character change that would break it.
import { describe, expect, it } from "vitest";
import { PERCENT_ALMOST_DONE, PERCENT_JUST_STARTED, percentOf } from "@/lib/projects/percent";

/** What a label prints for `finished` of `total` — the ratio is the plain quotient. */
const labelFor = (finished: number, total: number) => `${percentOf(finished / total)}%`;

describe("percentOf — the two ends are never rounded into a lie", () => {
  it.each([
    // [finished, total, expected percent]
    [880, 882, 99.8],
    [881, 882, 99.9],
    [1, 500, 0.2],
    [996, 1000, 99.6],
    [4, 1000, 0.4],
    [1, 1000, 0.1],
  ])(
    "%i of %i reads %f — one decimal, because the whole number would be 100 or 0",
    (n, d, want) => {
      // Breaks if: the `whole !== 100 && whole !== 0` test is dropped (every
      // ratio then rounds to a whole number, 880/882 reads 100), or the
      // decimal step is `Math.round(ratio * 100) / 10` (a factor of ten out).
      expect(percentOf(n / d)).toBe(want);
    },
  );

  it("holds a ratio that rounds to 100.0 at 99.9", () => {
    // 1999/2000 is 99.95%: one decimal place rounds it UP to 100.0, which
    // is the exact lie the decimal was introduced to remove.
    //
    // Breaks if: the `Math.min(PERCENT_ALMOST_DONE, …)` is removed — the
    // result is 100. Also breaks if the constant is changed to 100.
    expect(percentOf(1999 / 2000)).toBe(99.9);
    expect(percentOf(99999 / 100000)).toBe(99.9);
  });

  it("holds a ratio that rounds to 0.0 at 0.1", () => {
    // 1/5000 is 0.02%: one decimal place rounds it DOWN to 0.0, which
    // claims that nothing is closed when something is.
    //
    // Breaks if: the `Math.max(PERCENT_JUST_STARTED, …)` is removed — the
    // result is 0.
    expect(percentOf(1 / 5000)).toBe(0.1);
    expect(percentOf(1 / 100000)).toBe(0.1);
  });

  it("reads 100 only when every child is closed", () => {
    // Breaks if: the `ratio >= 1` guard is removed — the ratio falls into
    // the decimal branch and the clamp turns 100 into 99.9, so a finished
    // project could never read as finished.
    expect(percentOf(882 / 882)).toBe(100);
    expect(percentOf(1)).toBe(100);
  });

  it("reads 0 only when no child is closed", () => {
    // Breaks if: the `ratio <= 0` guard is removed — the clamp turns 0 into
    // 0.1, so a project with nothing closed claims something is.
    expect(percentOf(0 / 882)).toBe(0);
    expect(percentOf(0)).toBe(0);
  });
});

describe("percentOf — everything in between is unchanged", () => {
  it.each([
    [1, 2, 50],
    [1, 3, 33],
    [2, 3, 67],
    [1, 4, 25],
    [5, 9, 56],
    // The last whole numbers before each end: they still round to a whole
    // number, because whole-number rounding does not reach 100 or 0.
    [994, 1000, 99],
    [6, 1000, 1],
    [2, 300, 1],
  ])("%i of %i reads %f", (n, d, want) => {
    // Breaks if: the decimal branch is entered for every ratio (50 would
    // read 50 still, but 1/3 would read 33.3) — the 33 and 67 rows fail.
    expect(percentOf(n / d)).toBe(want);
  });

  it("rounds to nearest rather than down at either end", () => {
    // Just inside each end: 99.51% rounds to the whole number 100, so it
    // takes the decimal branch and prints 99.5; 0.49% rounds to the whole
    // number 0 and prints 0.5. 0.51% rounds to the whole number 1 and stays
    // a whole number.
    //
    // Breaks if: `Math.round(ratio * 100)` becomes `Math.floor(ratio * 100)`
    // - 0.9951 reads 99 (not 99.5) and 0.0051 reads 0.5 (not 1).
    expect(percentOf(0.9951)).toBe(99.5);
    expect(percentOf(0.0049)).toBe(0.5);
    expect(percentOf(0.0051)).toBe(1);
  });
});

describe("percentOf — what the label prints", () => {
  it("prints without trailing zeros or float noise", () => {
    // The number is interpolated straight into the label, so it has to
    // stringify cleanly.
    //
    // Breaks if: the tenths step divides by a different power of ten or
    // skips the rounding — 1/500 prints 0.2 only by luck of the quotient,
    // while 880/882 prints 99.77324263038548.
    expect(labelFor(880, 882)).toBe("99.8%");
    expect(labelFor(881, 882)).toBe("99.9%");
    expect(labelFor(1999, 2000)).toBe("99.9%");
    expect(labelFor(1, 500)).toBe("0.2%");
    expect(labelFor(1, 5000)).toBe("0.1%");
    expect(labelFor(1, 2)).toBe("50%");
    expect(labelFor(882, 882)).toBe("100%");
    expect(labelFor(0, 882)).toBe("0%");
  });

  it("exports the clamp values the rule is stated in", () => {
    // Breaks if: either constant is edited — the rule is "99.9 / 0.1".
    expect(PERCENT_ALMOST_DONE).toBe(99.9);
    expect(PERCENT_JUST_STARTED).toBe(0.1);
  });
});

describe("percentOf — the invariant, swept over real counts", () => {
  // Every finished/total pair for totals up to 400, then a few large ones.
  // The point is not the cases but the invariant: no count can make the
  // label say "all" or "none" when it is not, and no count can make it
  // fail to say so when it is.
  const totals = [...Array.from({ length: 400 }, (_, i) => i + 1), 1000, 2000, 5000, 10000, 100000];

  it("is 100 iff all are closed, 0 iff none are, and otherwise strictly between", () => {
    for (const total of totals) {
      // Every count for small totals; for the large ones, the ends of the
      // range, where the interesting rounding is.
      const counts =
        total <= 400
          ? Array.from({ length: total + 1 }, (_, i) => i)
          : [0, 1, 2, 3, total - 3, total - 2, total - 1, total];
      for (const finished of counts) {
        const percent = percentOf(finished / total);
        const at = `${finished} of ${total} -> ${percent}`;
        if (finished === total) expect(percent, at).toBe(100);
        else if (finished === 0) expect(percent, at).toBe(0);
        else {
          expect(percent, at).toBeGreaterThanOrEqual(PERCENT_JUST_STARTED);
          expect(percent, at).toBeLessThanOrEqual(PERCENT_ALMOST_DONE);
        }
      }
    }
  });

  it("is never more than one decimal place, and is monotonic in the count", () => {
    for (const total of totals) {
      let previous = -1;
      const counts =
        total <= 400
          ? Array.from({ length: total + 1 }, (_, i) => i)
          : [0, 1, 2, 3, total - 3, total - 2, total - 1, total];
      for (const finished of counts) {
        const percent = percentOf(finished / total);
        const at = `${finished} of ${total} -> ${percent}`;
        expect(Number(percent.toFixed(1)), at).toBe(percent);
        // More closed children can never read as less progress.
        expect(percent, at).toBeGreaterThanOrEqual(previous);
        previous = percent;
      }
    }
  });
});
