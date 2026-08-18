// The density block in `src/app/globals.css` (§10).
//
// This test PARSES THE STYLESHEET, for the reason
// `tests/design-tokens-contrast.test.ts` gives: the claim being made —
// "density changes spacing and line-height, never font size" — is a
// property of the shipped file, and a test carrying its own copy of the
// values would pass forever after someone edited the CSS.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Adding a single `--text-*` line inside `html.density-compact` fails
//     `changes no font size`. That is the ONE change this file exists to
//     prevent, and one line is enough to trip it.
//   - Making a compact spacing step larger than its comfortable
//     counterpart fails `every spacing step is tighter or equal`.
//   - Raising `--leading-normal` in the compact block above its
//     comfortable value fails the line-height test.
//   - Dropping `--space-2` below 8px fails the touch-target floor test.
//   - Deleting the whole `html.density-compact` block fails every test
//     here, starting with the one that finds it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CSS = readFileSync(path.resolve(import.meta.dirname, "../src/app/globals.css"), "utf8");

/** The declarations inside one rule, by selector. Braces do not nest inside these blocks. */
function blockFor(selector: string): string {
  const index = CSS.indexOf(`${selector} {`);
  if (index === -1) throw new Error(`No \`${selector}\` rule in globals.css.`);
  const start = CSS.indexOf("{", index);
  const end = CSS.indexOf("}", start);
  return CSS.slice(start + 1, end);
}

/** Every `--name: value` in a block, as a map. */
function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1]!, match[2]!.trim());
  }
  return found;
}

function pixels(value: string): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  if (match === null) throw new Error(`Expected a px value, got \`${value}\`.`);
  return Number(match[1]);
}

const compact = declarations(blockFor("html.density-compact"));
// The comfortable baseline is the type/spacing block in §8. It is the
// `:root` rule that declares `--space-1`, not any of the earlier ones.
const baselineBlock = (() => {
  for (const match of CSS.matchAll(/:root\s*\{([^}]*)\}/g)) {
    if (match[1]!.includes("--space-1:")) return match[1]!;
  }
  throw new Error("No `:root` block declaring the spacing scale in globals.css.");
})();
const baseline = declarations(baselineBlock);

describe("the compact density block", () => {
  it("exists and declares something", () => {
    expect(compact.size).toBeGreaterThan(0);
  });

  it("changes NO font size — the type scale is the same in both densities", () => {
    // The whole reason this feature is safe. Shrinking the type would not
    // give a denser version of the same design, it would give a second,
    // unstated scale under which none of the contrast and legibility work
    // in §2–§6 still holds — and `--text-3xs` (11px) is already at the
    // floor. A single `--text-*` line here fails this.
    const typeTokens = [...compact.keys()].filter((name) => name.startsWith("--text-"));
    expect(typeTokens).toEqual([]);
  });

  it("changes no weight, radius, colour or font family either", () => {
    // Density is a spacing decision. Anything else redeclared here is a
    // second theme wearing density's name.
    const allowed = /^--(space-\d+|leading-[a-z]+)$/;
    const unexpected = [...compact.keys()].filter((name) => !allowed.test(name));
    expect(unexpected).toEqual([]);
  });

  it("only overrides tokens the baseline actually declares", () => {
    // A typo (`--space-7`) would declare a token nothing reads, and the
    // density would silently do less than it claims.
    for (const name of compact.keys()) {
      expect(baseline.has(name), `${name} is not declared in the baseline scale`).toBe(true);
    }
  });

  it("makes every spacing step tighter than or equal to comfortable, never looser", () => {
    const steps = [...compact.keys()].filter((name) => name.startsWith("--space-"));
    expect(steps.length).toBeGreaterThan(0);
    for (const name of steps) {
      const tight = pixels(compact.get(name)!);
      const roomy = pixels(baseline.get(name)!);
      expect(tight, `${name} is looser in compact than in comfortable`).toBeLessThanOrEqual(roomy);
    }
    // …and at least one is strictly tighter, or "compact" is a no-op that
    // every assertion above would still pass.
    const anyTighter = steps.some(
      (name) => pixels(compact.get(name)!) < pixels(baseline.get(name)!),
    );
    expect(anyTighter).toBe(true);
  });

  it("keeps --space-2 at 8px, which is what holds a nav row at the 44px touch target", () => {
    // `Sidebar.module.css` builds its 44px minimum on this step. Compacting
    // it further would take the sidebar's rows under the touch-target floor
    // on exactly the screens where they are tapped rather than clicked.
    expect(pixels(compact.get("--space-2")!)).toBeGreaterThanOrEqual(8);
  });

  it("tightens line-height without going under the tight step", () => {
    const normal = Number(compact.get("--leading-normal"));
    expect(normal).toBeLessThan(Number(baseline.get("--leading-normal")));
    // `--leading-tight` (1.25) is the floor: below it, descenders start
    // clipping against the line above.
    expect(normal).toBeGreaterThanOrEqual(Number(baseline.get("--leading-tight")));
  });

  it("leaves --leading-tight alone — it is already at the floor", () => {
    expect(compact.has("--leading-tight")).toBe(false);
  });
});
