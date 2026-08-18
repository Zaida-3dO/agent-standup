// The band chart's geometry — MILESTONES.md #87.
//
// Geometry proved as data. The test environment is `node` with no DOM, so a
// path string assembled inside a component could only be checked by
// rendering; computed by a pure function it can be asserted directly, which
// is why the module is split that way in the first place.
//
// No database: these are functions over plain values, and gating them would
// mean they skip in exactly the runs where somebody is moving fast.
import { describe, expect, it } from "vitest";
import type { BudgetWindow } from "@/lib/settings/budget-windows";
import {
  BAND_KEYS,
  DEFAULT_BOX,
  markerX,
  pathFrom,
  samplePoints,
  seriesFor,
  xFor,
  yFor,
} from "@/lib/budget-page/chart";

const constant = (value: number) => ({ kind: "constant" as const, value });

function windowWith(
  boundaries: Partial<BudgetWindow["boundaries"]> = {},
  lengthHours = 5,
): BudgetWindow {
  return {
    enabled: true,
    lengthHours,
    boundaries: {
      selective: constant(60),
      windDown: constant(80),
      stop: constant(95),
      ...boundaries,
    },
  };
}

describe("xFor / yFor", () => {
  it("maps the window's start and end across the box's width", () => {
    expect(xFor(0, 5)).toBe(0);
    expect(xFor(5, 5)).toBe(DEFAULT_BOX.width);
    expect(xFor(2.5, 5)).toBe(DEFAULT_BOX.width / 2);
  });

  // A zero-length window is not drawable, and dividing by it would put every
  // point at infinity — a chart that renders as nothing, with no clue why.
  it("does not divide by a zero length", () => {
    expect(xFor(3, 0)).toBe(0);
  });

  // Inverted, because a percentage grows upward and SVG's y grows downward.
  // Getting this backwards would draw every window upside down while still
  // producing a plausible-looking picture, which is the kind of fault a
  // rendering test would miss and this one cannot.
  it("puts 100% at the top and 0% at the bottom", () => {
    expect(yFor(100)).toBe(0);
    expect(yFor(0)).toBe(DEFAULT_BOX.height);
    expect(yFor(50)).toBe(DEFAULT_BOX.height / 2);
  });

  // A boundary outside 0–100 is a validation error the chart still has to
  // draw somewhere; dropping it would hide the very fault being shown.
  it("clamps a value outside 0–100 rather than dropping it", () => {
    expect(yFor(140)).toBe(yFor(100));
    expect(yFor(-20)).toBe(yFor(0));
  });
});

describe("samplePoints", () => {
  it("covers both endpoints", () => {
    const points = samplePoints(windowWith({}, 5));
    expect(points[0]).toBe(0);
    expect(points[points.length - 1]).toBe(5);
  });

  // A piecewise function jumps at its switch points, and a grid that does
  // not land on a jump draws a straight line through it — rendering a step
  // as a ramp, which misinforms the reader about what the boundary does.
  it("includes a schedule's switch point even when it falls between grid points", () => {
    const window = windowWith(
      {
        stop: {
          kind: "schedule",
          entries: [
            { at: { elapsed: 0, per: "hour" }, value: constant(90) },
            // 4.973h is deliberately off the 101-point grid over 5h.
            { at: { elapsed: 4.973, per: "hour" }, value: constant(99) },
          ],
        },
      },
      5,
    );
    expect(samplePoints(window)).toContain(4.973);
  });

  it("ignores a switch point outside the window", () => {
    const window = windowWith(
      {
        stop: {
          kind: "schedule",
          entries: [{ at: { elapsed: 40, per: "hour" }, value: constant(90) }],
        },
      },
      5,
    );
    expect(samplePoints(window).every((point) => point <= 5)).toBe(true);
  });
});

describe("pathFrom", () => {
  it("moves to the first point and lines to the rest", () => {
    expect(pathFrom([[0, 10] as const, [5, 20] as const])).toBe("M0 10 L5 20");
  });

  // A gap is drawn as a gap rather than joined across, because joining
  // would assert a value the boundary does not have.
  it("breaks the line at a point with no value, and starts a new one after", () => {
    const path = pathFrom([
      [0, 10] as const,
      [5, Number.NaN] as const,
      [10, 30] as const,
      [15, 40] as const,
    ]);
    expect(path).toBe("M0 10 M10 30 L15 40");
  });

  it("is empty for no points", () => {
    expect(pathFrom([])).toBe("");
  });
});

describe("seriesFor", () => {
  it("returns one series per band, in drawing order", () => {
    const series = seriesFor(windowWith());
    expect(series.map((entry) => entry.key)).toEqual([...BAND_KEYS]);
  });

  it("draws a constant boundary as a flat line at its own height", () => {
    const series = seriesFor(windowWith({ selective: constant(50) }));
    const selective = series.find((entry) => entry.key === "selective");
    const ys = selective?.points.map(([, y]) => y) ?? [];
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBe(yFor(50));
  });

  it("draws a linear boundary as a line that moves", () => {
    const series = seriesFor(
      windowWith({ selective: { kind: "linear", slope: 10, offset: 20, per: "hour" } }),
    );
    const selective = series.find((entry) => entry.key === "selective");
    const first = selective?.points[0]?.[1] ?? 0;
    const last = selective?.points[selective.points.length - 1]?.[1] ?? 0;
    // Rising percentage means a falling y, since y is inverted.
    expect(last).toBeLessThan(first);
  });

  // A schedule's first entry applies *before* its own anchor as well as
  // after — the model reads the last entry whose anchor has passed and
  // falls back to the first when none has. So a schedule anchored to the
  // final hour is a flat line across the whole window rather than a line
  // that begins late, and the chart draws exactly that. Asserted because
  // the opposite is the intuitive reading, and a chart drawn on the
  // intuitive reading would show a gap the configuration does not have.
  it("draws a late-anchored schedule from the start, matching the model", () => {
    const series = seriesFor(
      windowWith(
        {
          selective: {
            kind: "schedule",
            entries: [{ at: { remaining: 1, per: "hour" }, value: constant(70) }],
          },
        },
        5,
      ),
    );
    const selective = series.find((entry) => entry.key === "selective");
    expect(selective?.points.every(([, y]) => y === yFor(70))).toBe(true);
    expect(selective?.path).not.toContain("NaN");
  });

  // A step is drawn as a step: the value before the switch and after it
  // differ, and the switch point is sampled so the change is not smoothed
  // into a ramp.
  it("draws a schedule's step at its switch point", () => {
    const window = windowWith(
      {
        selective: {
          kind: "schedule",
          entries: [
            { at: { elapsed: 0, per: "hour" }, value: constant(40) },
            { at: { elapsed: 2, per: "hour" }, value: constant(70) },
          ],
        },
      },
      5,
    );
    const selective = seriesFor(window).find((entry) => entry.key === "selective");
    const heights = new Set(selective?.points.map(([, y]) => y));
    expect(heights).toEqual(new Set([yFor(40), yFor(70)]));
  });
});

describe("markerX", () => {
  it("puts a crossing where it happens on the x axis", () => {
    const window = windowWith({}, 10);
    expect(markerX(5, window)).toBe(DEFAULT_BOX.width / 2);
  });
});
