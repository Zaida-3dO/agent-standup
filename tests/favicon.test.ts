// Guards the one real cost of the favicon build: `scripts/build-favicon.py`
// re-states the geometry from `src/app/icon.svg` as Python constants, so
// there are two copies of the same numbers and nothing but this file
// stopping them drifting apart.
//
// ── Why the duplication is tolerated at all ───────────────────────────
//
// The mark is three rounded rectangles on a rounded plate. Rasterising the
// SVG properly would mean adding a headless browser or a full SVG renderer
// to the toolchain; parsing it in Python would mean an XML dependency and a
// path parser. Both are far more machinery than three rectangles justify.
// Copying six numbers and testing the copy is the smaller thing.
//
// ── What would break these tests ──────────────────────────────────────
//
//   - Editing a bar's x/y/width/height in `icon.svg` without editing
//     `build-favicon.py` (or the reverse) fails the geometry test — which
//     is the entire drift this file exists to catch.
//   - Changing a fill colour in one file only fails the colour test.
//   - Narrowing the gap between bars below 6 units fails the 16px
//     legibility test.
//   - Deleting a generated asset fails the asset test.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SVG = readFileSync(path.join(ROOT, "src/app/icon.svg"), "utf8");
const PY = readFileSync(path.join(ROOT, "scripts/build-favicon.py"), "utf8");

/** One rectangle's geometry and fill. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
}

/**
 * The three bars as `icon.svg` declares them.
 *
 * Deliberately skips the plate: it is matched by its own `width="64"`,
 * which no bar has, so filtering on that is enough to separate them
 * without needing to parse the document structure.
 */
function svgBars(): Rect[] {
  const bars: Rect[] = [];
  const pattern =
    /<rect\s+x="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"\s+rx="[\d.]+"\s+fill="(#[0-9a-fA-F]{6})"/g;
  for (const m of SVG.matchAll(pattern)) {
    bars.push({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]!, fill: m[5]!.toLowerCase() });
  }
  return bars;
}

/** The three bars as `build-favicon.py` declares them in its `BARS` list. */
function pyBars(): Rect[] {
  const block = /BARS = \[([\s\S]*?)\]/.exec(PY);
  if (block === null) throw new Error("No BARS list found in scripts/build-favicon.py");
  const bars: Rect[] = [];
  const pattern = /\(\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*\d+,\s*"(#[0-9a-fA-F]{6})"\s*\)/g;
  for (const m of block[1]!.matchAll(pattern)) {
    bars.push({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]!, fill: m[5]!.toLowerCase() });
  }
  return bars;
}

describe("the favicon's two copies of the geometry agree", () => {
  it("finds three bars in each file — the parsers are actually matching", () => {
    // Guards the tests below from passing vacuously: two empty arrays are
    // equal, so a regex that silently stopped matching would turn the whole
    // file green while checking nothing.
    expect(svgBars()).toHaveLength(3);
    expect(pyBars()).toHaveLength(3);
  });

  it("declares identical bar geometry and colours in the SVG and the build script", () => {
    expect(pyBars()).toEqual(svgBars());
  });

  it("takes its plate colour and radius from the same values", () => {
    const svgPlate = /<rect width="64" height="64" rx="(\d+)" fill="(#[0-9a-fA-F]{6})"/.exec(SVG);
    expect(svgPlate).not.toBeNull();
    expect(PY).toContain(`PLATE_RADIUS = ${svgPlate![1]}`);
    expect(PY.toLowerCase()).toContain(`plate = "${svgPlate![2]!.toLowerCase()}"`);
  });
});

describe("the mark survives 16px", () => {
  // The size that actually matters — a browser tab. The 64-unit viewBox
  // scales by 0.25 there, so a detail under ~4 units is under a pixel.
  const SCALE = 16 / 64;

  it("keeps the bars at least 2px wide and the gaps at least 1.5px", () => {
    const bars = [...svgBars()].sort((a, b) => a.x - b.x);
    for (const bar of bars) {
      expect(bar.w * SCALE).toBeGreaterThanOrEqual(2);
    }
    for (let i = 1; i < bars.length; i += 1) {
      const gap = bars[i]!.x - (bars[i - 1]!.x + bars[i - 1]!.w);
      // The separation is what makes it read as three agents rather than
      // one striped block, so it is the measurement with the least room to
      // give — a zero gap here fuses them into a single shape.
      expect(gap * SCALE).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("gives the three bars visibly different heights", () => {
    // The heights are the content: different amounts of progress. If two
    // matched, the mark would read as a symmetrical logo rather than as a
    // status line-up.
    const heights = svgBars().map((b) => b.h);
    expect(new Set(heights).size).toBe(3);
    // ...and different by enough to see at 16px, not just numerically.
    const sorted = [...heights].sort((a, b) => a - b);
    expect((sorted[1]! - sorted[0]!) * SCALE).toBeGreaterThanOrEqual(1);
    expect((sorted[2]! - sorted[1]!) * SCALE).toBeGreaterThanOrEqual(1);
  });

  it("stands the bars on one baseline", () => {
    // Shared baseline, differing tops — that is what makes the heights read
    // as a comparison rather than as a scatter.
    const baselines = svgBars().map((b) => b.y + b.h);
    expect(new Set(baselines).size).toBe(1);
  });

  it("keeps every bar inside the plate", () => {
    for (const bar of svgBars()) {
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.w).toBeLessThanOrEqual(64);
      expect(bar.y).toBeGreaterThanOrEqual(0);
      expect(bar.y + bar.h).toBeLessThanOrEqual(64);
    }
  });
});

describe("the generated asset set", () => {
  it("ships every file the App Router convention looks for", () => {
    for (const asset of ["icon.svg", "favicon.ico", "icon.png", "apple-icon.png"]) {
      expect(existsSync(path.join(ROOT, "src/app", asset))).toBe(true);
    }
  });

  it("uses no red — a permanently red status would read as an error in a tab", () => {
    // The mark shows `executing`, `paused` and `in_review`. Red is reserved
    // for `blocked`, and an app icon cannot be permanently blocked.
    for (const bar of svgBars()) {
      const r = parseInt(bar.fill.slice(1, 3), 16);
      const g = parseInt(bar.fill.slice(3, 5), 16);
      const b = parseInt(bar.fill.slice(5, 7), 16);
      // Red-dominant means r clearly ahead of both others.
      const redDominant = r > g + 60 && r > b + 60;
      expect(redDominant).toBe(false);
    }
  });
});
