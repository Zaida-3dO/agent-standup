// The shared region-state decision — `@/lib/states/empty`.
//
// **What would make this file hollow.** Asserting that `emptinessOf` returns
// *some* kind for an empty region proves nothing: a function that returned
// `"empty"` unconditionally would pass that, and it is precisely the
// implementation #123 exists to replace. The load-bearing assertions are
// therefore about which of the four answers is given for inputs that differ
// in exactly one field — a withheld region and an empty one differ only in
// `withheld`, and a filtered region and an empty one only in whether anything
// exists to have been filtered out.
import { describe, expect, it } from "vitest";
import { emptinessOf } from "@/lib/states/empty";

/** A region with nothing shown; each test varies only what it is about. */
function input(overrides: Partial<Parameters<typeof emptinessOf>[0]> = {}) {
  return { shown: 0, total: 0, withheld: false, filtered: false, ...overrides };
}

describe("emptinessOf", () => {
  it("returns null when the region has anything to show", () => {
    // Content beats every flag: a region with rows is not empty in any sense.
    expect(emptinessOf(input({ shown: 3 }))).toBeNull();
    expect(emptinessOf(input({ shown: 3, withheld: true, filtered: true, total: 99 }))).toBeNull();
  });

  it("calls a genuinely empty region empty", () => {
    expect(emptinessOf(input())).toBe("empty");
  });

  it("distinguishes withheld from empty on the withheld flag alone", () => {
    // The two inputs differ in exactly one field. This is #123: 175 terminal
    // items in the store and a column rendering as though there were none.
    const empty = input({ total: 0, withheld: false });
    const withheld = input({ total: 175, withheld: true });
    expect(emptinessOf(empty)).toBe("empty");
    expect(emptinessOf(withheld)).toBe("withheld");
    expect(emptinessOf(empty)).not.toBe(emptinessOf(withheld));
  });

  it("prefers withheld over filtered, because a region that was not read cannot blame the filter", () => {
    // Nothing was fetched, so whether the filter would have excluded these
    // rows is unknown — claiming it did would be a guess, and wrong whenever
    // the filter would in fact have matched them.
    expect(emptinessOf(input({ withheld: true, filtered: true, total: 40 }))).toBe("withheld");
  });

  it("calls a region filtered only when something exists to have been filtered out", () => {
    // A filter over a genuinely empty region has excluded nothing, so
    // "clear your filter to see more" would point at zero rows.
    expect(emptinessOf(input({ filtered: true, total: 12 }))).toBe("filtered");
    expect(emptinessOf(input({ filtered: true, total: 0 }))).toBe("empty");
  });
});
