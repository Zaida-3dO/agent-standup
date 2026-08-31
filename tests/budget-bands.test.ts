// The four budget bands — MILESTONES.md #57, SCHEMA.md §17.4, DECISIONS.md §7.
//
// Three properties carry this file, and each is easy to write a test that
// cannot fail on:
//
//   - The band edges. Asserted on both sides of every boundary, never in
//     the comfortable middle.
//   - Boundaries that MOVE. Every moving-boundary fixture is evaluated at
//     two different elapsed times and asserted to give two different
//     answers. A fixture evaluated at one moment cannot tell a boundary
//     that moves from a constant, which is exactly the shape that hides a
//     dropped clock term.
//   - Strictest wins. Asserted with the strict window in both positions, so
//     a fold that happened to return the last window would pass one and
//     fail the other.
import { describe, it, expect } from "vitest";
import { bandFor, decideBand, stricter, BANDS, BAND_SEVERITY } from "@/lib/budget/bands";
import type { BudgetWindow, BudgetWindows } from "@/lib/settings/budget-windows";
import type { UsageReading } from "@/lib/budget/reading";

/** A fresh reading of `value`. The age is irrelevant to these tests. */
function fresh(value: number): UsageReading {
  return { status: "fresh", value, takenAt: new Date("2026-08-31T12:00:00Z"), ageSeconds: 1 };
}

/** A window whose three boundaries are constants — the simple case. */
function constantWindow(selective: number, windDown: number, stop: number): BudgetWindow {
  return {
    enabled: true,
    lengthHours: 5,
    boundaries: {
      selective: { kind: "constant", value: selective },
      windDown: { kind: "constant", value: windDown },
      stop: { kind: "constant", value: stop },
    },
  };
}

describe("the band vocabulary", () => {
  it("names four bands, ordered least to most restrictive", () => {
    expect(BANDS).toEqual(["free", "selective", "wind_down", "stop"]);
  });

  it("orders severity strictly, so no two bands compare equal", () => {
    const severities = BANDS.map((band) => BAND_SEVERITY[band]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
    expect(new Set(severities).size).toBe(BANDS.length);
  });

  it("picks the stricter of two bands regardless of argument order", () => {
    expect(stricter("free", "stop")).toBe("stop");
    expect(stricter("stop", "free")).toBe("stop");
    expect(stricter("selective", "wind_down")).toBe("wind_down");
    expect(stricter("wind_down", "wind_down")).toBe("wind_down");
  });
});

describe("bandFor — the four bands and their edges", () => {
  // Boundaries at 50 / 80 / 95. Every assertion below is on an edge or one
  // step either side of it; none is in the middle of a band, where an
  // off-by-one would survive.
  const window = constantWindow(50, 80, 95);
  const at = (usage: number) => bandFor(window, usage, 0)?.band;

  it("is free below the first boundary", () => {
    expect(at(0)).toBe("free");
    expect(at(49.9)).toBe("free");
  });

  it("becomes selective exactly AT the first boundary, which is where it begins", () => {
    // §17.4: a boundary is "where each of the last three begins", so the
    // comparison is inclusive at the lower edge. This is the assertion that
    // fails if it is ever written as strictly greater than.
    expect(at(50)).toBe("selective");
  });

  it("stays selective up to just below the second boundary", () => {
    expect(at(79.9)).toBe("selective");
  });

  it("becomes wind_down exactly AT the second boundary", () => {
    expect(at(80)).toBe("wind_down");
  });

  it("stays wind_down up to just below the third boundary", () => {
    expect(at(94.9)).toBe("wind_down");
  });

  it("becomes stop exactly AT the third boundary", () => {
    expect(at(95)).toBe("stop");
  });

  it("stays stop above the third boundary, including past 100", () => {
    expect(at(99)).toBe("stop");
    // Over-spend is representable and must not wrap round to free.
    expect(at(140)).toBe("stop");
  });

  it("reports the boundary values it decided from", () => {
    expect(bandFor(window, 60, 0)?.boundaries).toEqual({
      selective: 50,
      windDown: 80,
      stop: 95,
    });
  });
});

describe("bandFor — boundaries that move with the clock", () => {
  // The weekly pace line from DECISIONS.md §7, as a linear: 15 per day,
  // starting 5 below zero. Over a 168-hour window.
  const paced: BudgetWindow = {
    enabled: true,
    lengthHours: 168,
    boundaries: {
      selective: { kind: "linear", slope: 15, offset: -5, per: "day" },
      windDown: { kind: "linear", slope: 15, offset: 5, per: "day" },
      stop: { kind: "linear", slope: 15, offset: 15, per: "day" },
    },
  };

  it("puts the SAME usage in different bands at different points in the window", () => {
    // The single most important assertion in this file. 40% spent is a
    // different judgement on day one than on day three, and a fixture that
    // evaluated one moment could not tell this implementation from one that
    // ignored elapsed time entirely.
    const early = bandFor(paced, 40, 24)?.band; // 1 day in: line at 10/20/30
    const later = bandFor(paced, 40, 72)?.band; // 3 days in: line at 40/50/60

    expect(early).toBe("stop");
    expect(later).toBe("selective");
    expect(early).not.toBe(later);
  });

  it("computes the boundary from the elapsed time, not from a fixed point", () => {
    // The arithmetic stated outright, so a wrong slope or a dropped offset
    // is visible rather than merely changing a band.
    expect(bandFor(paced, 0, 24)?.boundaries).toEqual({
      selective: 10,
      windDown: 20,
      stop: 30,
    });
    expect(bandFor(paced, 0, 48)?.boundaries).toEqual({
      selective: 25,
      windDown: 35,
      stop: 45,
    });
  });

  it("respects the per unit — an hourly slope is not a daily one", () => {
    const hourly: BudgetWindow = {
      enabled: true,
      lengthHours: 5,
      boundaries: {
        selective: { kind: "linear", slope: 10, offset: 0, per: "hour" },
        windDown: { kind: "linear", slope: 10, offset: 10, per: "hour" },
        stop: { kind: "linear", slope: 10, offset: 20, per: "hour" },
      },
    };
    // Two hours in: 20 / 30 / 40. The same numbers read per day would be
    // barely off zero, so this fails if the unit is ignored.
    expect(bandFor(hourly, 0, 2)?.boundaries).toEqual({
      selective: 20,
      windDown: 30,
      stop: 40,
    });
  });

  it("follows a schedule across its switch point", () => {
    // DECISIONS.md §7's 5-hour rule: 80, rising to 92 in the final hour.
    const scheduled: BudgetWindow = {
      enabled: true,
      lengthHours: 5,
      boundaries: {
        selective: { kind: "constant", value: 50 },
        windDown: { kind: "constant", value: 70 },
        stop: {
          kind: "schedule",
          entries: [
            { at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 80 } },
            { at: { remaining: 1, per: "hour" }, value: { kind: "constant", value: 92 } },
          ],
        },
      },
    };

    // 85% spent: over the stop line for most of the window, under it once
    // the final hour raises the line. Two moments, two answers.
    expect(bandFor(scheduled, 85, 2)?.band).toBe("stop");
    expect(bandFor(scheduled, 85, 4.5)?.band).toBe("wind_down");
  });

  it("produces no band when a boundary has no value at that moment", () => {
    // A schedule with no entries is rejected on write, but a value stored
    // before the schema tightened can still be one (§17.3). An undefined
    // boundary must not read as infinitely permissive.
    const holed: BudgetWindow = {
      enabled: true,
      lengthHours: 5,
      boundaries: {
        selective: { kind: "constant", value: 50 },
        windDown: { kind: "constant", value: 70 },
        stop: { kind: "schedule", entries: [] },
      },
    } as unknown as BudgetWindow;

    expect(bandFor(holed, 99, 1)).toBeNull();
  });
});

describe("decideBand — strictest window wins", () => {
  // Two windows, deliberately disagreeing. 60% spent is selective against
  // the loose one and stop against the tight one.
  const loose = constantWindow(50, 80, 95);
  const tight = constantWindow(10, 30, 55);

  function windows(entries: Record<string, BudgetWindow>): BudgetWindows {
    return entries as BudgetWindows;
  }

  it("takes the strict window when it sorts first", () => {
    const decision = decideBand(
      {
        windows: windows({ aTight: tight, bLoose: loose }),
        reading: fresh(60),
        elapsedHours: { aTight: 0, bLoose: 0 },
      },
      true,
    );

    expect(decision.status).toBe("banded");
    if (decision.status !== "banded") throw new Error("expected a band");
    expect(decision.band).toBe("stop");
    expect(decision.governing.window).toBe("aTight");
  });

  it("takes the strict window when it sorts last", () => {
    // The same disagreement with the names swapped. A fold that returned
    // the first or the last window rather than the strictest passes exactly
    // one of this pair and fails the other.
    const decision = decideBand(
      {
        windows: windows({ aLoose: loose, bTight: tight }),
        reading: fresh(60),
        elapsedHours: { aLoose: 0, bTight: 0 },
      },
      true,
    );

    if (decision.status !== "banded") throw new Error("expected a band");
    expect(decision.band).toBe("stop");
    expect(decision.governing.window).toBe("bTight");
  });

  it("keeps every window's verdict, not only the governing one", () => {
    const decision = decideBand(
      {
        windows: windows({ aLoose: loose, bTight: tight }),
        reading: fresh(60),
        elapsedHours: { aLoose: 0, bTight: 0 },
      },
      true,
    );

    if (decision.status !== "banded") throw new Error("expected a band");
    expect(decision.verdicts.map((v) => [v.window, v.band])).toEqual([
      ["aLoose", "selective"],
      ["bTight", "stop"],
    ]);
  });

  it("breaks a tie deterministically, on the first window by name", () => {
    // Both windows agree. The band is not in question; which window is
    // reported as governing is, and it must not depend on object order.
    const decision = decideBand(
      {
        windows: windows({ zebra: loose, alpha: loose }),
        reading: fresh(60),
        elapsedHours: { zebra: 0, alpha: 0 },
      },
      true,
    );

    if (decision.status !== "banded") throw new Error("expected a band");
    expect(decision.band).toBe("selective");
    expect(decision.governing.window).toBe("alpha");
  });

  it("lets the strictest change as the clock moves", () => {
    // The pace line overtakes the constant partway through the window, so
    // which window governs is itself time-dependent. A fixture evaluated at
    // one moment could not show this.
    const paced: BudgetWindow = {
      enabled: true,
      lengthHours: 168,
      boundaries: {
        selective: { kind: "linear", slope: 15, offset: -5, per: "day" },
        windDown: { kind: "linear", slope: 15, offset: 5, per: "day" },
        stop: { kind: "linear", slope: 15, offset: 15, per: "day" },
      },
    };
    const shape = { windows: windows({ fiveHour: loose, weekly: paced }), reading: fresh(40) };

    const early = decideBand({ ...shape, elapsedHours: { fiveHour: 0, weekly: 24 } }, true);
    const later = decideBand({ ...shape, elapsedHours: { fiveHour: 0, weekly: 96 } }, true);

    if (early.status !== "banded" || later.status !== "banded") {
      throw new Error("expected bands");
    }
    // Day 1: the pace line is at 10/20/30, so 40% is stop and the weekly
    // window governs. Day 4: the line has risen past 40, and the loose
    // 5-hour window's own verdict (free) is the strictest available.
    expect(early.band).toBe("stop");
    expect(early.governing.window).toBe("weekly");
    expect(later.band).toBe("free");
  });
});

describe("decideBand — when there is no band, and why", () => {
  const window = constantWindow(50, 80, 95);
  const enabledWindows = { fiveHour: window } as BudgetWindows;

  it("is unbanded when budgets are switched off, whatever the usage", () => {
    const decision = decideBand(
      { windows: enabledWindows, reading: fresh(99), elapsedHours: { fiveHour: 0 } },
      false,
    );

    // 99% would be stop if bands applied. The master switch is checked
    // first and unconditionally (DECISIONS.md §7).
    expect(decision).toMatchObject({ status: "unbanded", reason: "budget-disabled" });
  });

  it("is unbanded when no window is configured at all", () => {
    const decision = decideBand(
      { windows: {} as BudgetWindows, reading: fresh(99), elapsedHours: {} },
      true,
    );

    // The shipped default for budget.windows is an empty map, so this is
    // the state every fresh installation is in.
    expect(decision).toMatchObject({ status: "unbanded", reason: "no-windows" });
  });

  it("is unbanded when every configured window is disabled", () => {
    const decision = decideBand(
      {
        windows: { fiveHour: { ...window, enabled: false } } as BudgetWindows,
        reading: fresh(99),
        elapsedHours: { fiveHour: 0 },
      },
      true,
    );

    // Distinct from no-windows: one is configured, and switched off.
    expect(decision).toMatchObject({ status: "unbanded", reason: "window-disabled" });
  });

  it("is unbanded, and says so, when the only reading is STALE", () => {
    // The seam between #56 and #57, and the reason one lands before the
    // other. A stale figure is not quietly used: it would apply an earlier
    // window's headroom to the current one, and a reading that stopped
    // arriving usually means the machine reporting it stopped, which is
    // when usage is least predictable.
    const stale: UsageReading = {
      status: "stale",
      value: 5,
      takenAt: new Date("2026-08-30T12:00:00Z"),
      ageSeconds: 86_400,
    };

    const decision = decideBand(
      { windows: enabledWindows, reading: stale, elapsedHours: { fiveHour: 0 } },
      true,
    );

    // 5% would be free — the most permissive answer there is. Being
    // unbanded for a stated reason is not the same as being told there is
    // headroom, and a caller can tell the two apart.
    expect(decision).toMatchObject({ status: "unbanded", reason: "reading-stale" });
  });

  it("is unbanded when there is no reading at all, distinctly from stale", () => {
    const decision = decideBand(
      {
        windows: enabledWindows,
        reading: { status: "absent", reason: "never-reported" },
        elapsedHours: { fiveHour: 0 },
      },
      true,
    );

    expect(decision).toMatchObject({ status: "unbanded", reason: "reading-absent" });
  });

  it("is unbanded when no window has an elapsed time to be evaluated at", () => {
    // A window the caller could not locate on the clock — a vendor whose
    // billing window this build cannot compute. Skipped rather than
    // evaluated at an invented zero.
    const decision = decideBand(
      { windows: enabledWindows, reading: fresh(99), elapsedHours: {} },
      true,
    );

    expect(decision).toMatchObject({ status: "unbanded", reason: "boundary-undefined" });
  });

  it("still bands on the windows it can evaluate when only some are locatable", () => {
    const decision = decideBand(
      {
        windows: { fiveHour: window, weekly: window } as BudgetWindows,
        reading: fresh(96),
        elapsedHours: { fiveHour: 0 },
      },
      true,
    );

    if (decision.status !== "banded") throw new Error("expected a band");
    expect(decision.band).toBe("stop");
    expect(decision.verdicts).toHaveLength(1);
  });
});

describe("decideBand — an account that overrides the global windows", () => {
  // #57 reads budget.windows as a typed setting, and
  // accounts.budget_windows where an account overrides it. The resolution
  // itself is effectiveBudgetWindows (settings/overrides.ts); what matters
  // here is that the band follows whichever value that returns, so an
  // override genuinely changes the answer rather than being read and
  // discarded.
  const globalWindow = constantWindow(50, 80, 95);
  const strictOverride = constantWindow(10, 20, 30);

  it("bands against the global windows when the account overrides nothing", () => {
    const decision = decideBand(
      {
        windows: { fiveHour: globalWindow } as BudgetWindows,
        reading: fresh(40),
        elapsedHours: { fiveHour: 0 },
      },
      true,
    );

    if (decision.status !== "banded") throw new Error("expected a band");
    expect(decision.band).toBe("free");
  });

  it("bands against the override when the account carries one", () => {
    // The same usage figure, the same clock, a different answer — which is
    // the only thing that shows the override is being read.
    const decision = decideBand(
      {
        windows: { fiveHour: strictOverride } as BudgetWindows,
        reading: fresh(40),
        elapsedHours: { fiveHour: 0 },
      },
      true,
    );

    if (decision.status !== "banded") throw new Error("expected a band");
    expect(decision.band).toBe("stop");
  });

  it("lets an override name windows the global value does not", () => {
    // An override supplies the whole map rather than merging into it, so
    // an account may be evaluated against a window no other account has.
    const decision = decideBand(
      {
        windows: { bespoke: strictOverride } as BudgetWindows,
        reading: fresh(25),
        elapsedHours: { bespoke: 0 },
      },
      true,
    );

    if (decision.status !== "banded") throw new Error("expected a band");
    expect(decision.governing.window).toBe("bespoke");
    expect(decision.band).toBe("wind_down");
  });
});
