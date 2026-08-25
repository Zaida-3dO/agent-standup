// Comparing two versions of `budget.windows` — MILESTONES.md #87.
//
// The behaviour under test is what the editor shows somebody whose save was
// refused because another session wrote first. The decision they have to
// make — keep mine, or take theirs — depends on *what* moved, so these
// assert that the message names it.
import { describe, expect, it } from "vitest";
import type { BudgetWindow, BudgetWindows } from "@/lib/settings/budget-windows";
import { describeConcurrentChange, sameWindows } from "@/lib/budget-page/concurrency";

function aWindow(stop = 90): BudgetWindow {
  return {
    enabled: true,
    lengthHours: 24,
    boundaries: {
      selective: { kind: "constant", value: 50 },
      windDown: { kind: "constant", value: 75 },
      stop: { kind: "constant", value: stop },
    },
  };
}

describe("sameWindows", () => {
  it("treats an identical configuration as unchanged", () => {
    expect(sameWindows({ weekly: aWindow() }, { weekly: aWindow() })).toBe(true);
  });

  it("ignores key order, so a database round-trip is not reported as a change", () => {
    // The value comes back as parsed JSON whose key order is not promised.
    // Without normalising, every save after a reload would falsely conflict.
    const mine: BudgetWindows = { weekly: aWindow(), nightly: aWindow() };
    const theirs: BudgetWindows = { nightly: aWindow(), weekly: aWindow() };
    expect(sameWindows(mine, theirs)).toBe(true);
  });

  it("notices a changed value inside a window", () => {
    expect(sameWindows({ weekly: aWindow(90) }, { weekly: aWindow(95) })).toBe(false);
  });

  it("notices an added window", () => {
    expect(sameWindows({ weekly: aWindow() }, { weekly: aWindow(), nightly: aWindow() })).toBe(
      false,
    );
  });

  it("notices a removed window", () => {
    expect(sameWindows({ weekly: aWindow(), nightly: aWindow() }, { weekly: aWindow() })).toBe(
      false,
    );
  });

  it("treats two empty configurations as the same", () => {
    expect(sameWindows({}, {})).toBe(true);
  });
});

describe("describeConcurrentChange", () => {
  it("names an added window", () => {
    const said = describeConcurrentChange(
      { weekly: aWindow() },
      { weekly: aWindow(), nightly: aWindow() },
    );
    expect(said).toContain("added");
    expect(said).toContain('"nightly"');
  });

  it("names a removed window", () => {
    const said = describeConcurrentChange(
      { weekly: aWindow(), nightly: aWindow() },
      { weekly: aWindow() },
    );
    expect(said).toContain("removed");
    expect(said).toContain('"nightly"');
  });

  it("names a window whose contents changed", () => {
    const said = describeConcurrentChange({ weekly: aWindow(90) }, { weekly: aWindow(95) });
    expect(said).toContain("changed");
    expect(said).toContain('"weekly"');
  });

  it("reports several kinds of change in one sentence", () => {
    const said = describeConcurrentChange(
      { weekly: aWindow(90), gone: aWindow() },
      { weekly: aWindow(95), fresh: aWindow() },
    );
    expect(said).toContain('added "fresh"');
    expect(said).toContain('removed "gone"');
    expect(said).toContain('changed "weekly"');
  });

  it("lists several names readably rather than as an array", () => {
    const said = describeConcurrentChange({}, { a: aWindow(), b: aWindow(), c: aWindow() });
    expect(said).toContain('"a", "b" and "c"');
  });

  it("promises plainly that nothing of theirs was overwritten", () => {
    // The reassurance is the point: a conflict message that only said
    // "failed" would leave somebody wondering whether they had destroyed
    // the other session's work.
    const said = describeConcurrentChange({ weekly: aWindow(90) }, { weekly: aWindow(95) });
    expect(said).toContain("not been saved");
    expect(said).toContain("nothing of theirs was overwritten");
  });

  it("still says something useful when no individual window differs", () => {
    // Reachable when the values differ by canonical JSON but no window does
    // — an unexpected top-level shape. Naming nothing would be worse.
    const said = describeConcurrentChange({}, {});
    expect(said).toContain("changed the budget windows");
  });
});
