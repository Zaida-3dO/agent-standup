// The Standup home's stylesheet, pinned where a phone and a keyboard read it:
// 44px tap targets below 720px, the desktop grid areas that let the DOM stay in
// reading order, and the skeleton's shimmer running only when motion is welcome.
//
// ── Why this test PARSES THE STYLESHEET ───────────────────────────────
//
// The claims are properties of the shipped `Standup.module.css`, and this
// repo's harness runs `environment: "node"` with no DOM and no layout engine
// (the same reason `tests/board-list-view-density.test.ts` gives at length).
//
// **This test does not measure a rendered layout, and does not claim to.** A
// green run means the declarations a browser would act on are present, on every
// class that is a tap target, in the block phones read. It does not mean the
// page looks right or that nothing overflows at 320px; that is the reviewer's
// render at 1536 and 420.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Deleting `min-height: 44px` from any tap target in the phone block, or
//     lowering it, fails "declares 44px on every tap target".
//   - Deleting the `display` that makes `min-height` bind (flex, inline-flex)
//     fails the box test: `min-height` on a bare inline box is inert.
//   - Moving a rule out of the phone block fails the same 44px test, which
//     reads only that block.
//   - Adding a link or button class to a component without a 44px rule fails
//     the roster test, which is what stops the next miss.
//   - Dropping a grid area, or the Done-moves-up variant, fails the layout test.
//   - Declaring `animation` outside the no-preference block fails the motion
//     test: a permanently moving skeleton is a vestibular trigger.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { matchingBrace } from "./helpers/css-blocks";

const CSS = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/standup/Standup.module.css"),
  "utf8",
);

/** Strip comments, so a rule discussed in prose is never mistaken for a declared one. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The body of the one `@media` block whose prelude is EXACTLY `header`, braces
 * excluded.
 *
 * **Accepts:** the comment-stripped stylesheet, containing exactly one block
 * with this prelude. A narrowed prelude (`... and (min-width: 580px)`) is a
 * different block and is not matched, so its rules are never read as if they
 * were unconditional at the whole breakpoint.
 *
 * **Cardinality: exactly one, checked with `expect()`.** A split breakpoint is
 * the drift this file exists to catch, so more than one is a failure rather
 * than something to concatenate.
 *
 * **On malformed input it THROWS**, via `matchingBrace`, when the block is
 * never closed. The brace walk is quote-aware and independent of where the
 * block sits in the file.
 */
function blockOf(header: string): string {
  const occurrences = CODE.split(header).length - 1;
  expect(occurrences, `${occurrences} \`${header}\` blocks, expected exactly one`).toBe(1);
  const start = CODE.indexOf(header);
  const afterHeader = CODE.slice(start + header.length).match(/^\s*\{/);
  expect(
    afterHeader,
    `no \`${header}\` block: something other than whitespace sits between the header and the brace`,
  ).not.toBeNull();
  const open = start + header.length + afterHeader![0].length - 1;
  return CODE.slice(open + 1, matchingBrace(CODE, open));
}

const narrowBlock = () => blockOf("@media (max-width: 719px)");

/** One class's declarations inside a stylesheet chunk. */
function ruleFor(chunk: string, selector: string): string {
  // Matches `.a, .b { ... }` as well as `.a { ... }`, so a class raised in a
  // shared rule counts.
  const rules = [...chunk.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter((m) => m[1]!.split(",").some((s) => s.trim() === selector))
    .map((m) => m[2]!)
    .join(" ");
}

/**
 * Every class on this page that is a tap target: an anchor or a button.
 *
 * A literal roster rather than derived, because its point is to fail when
 * somebody adds another link and does not think about its height.
 */
const TAP_TARGET_CLASSES = [
  ".needsTitle",
  ".btn",
  ".headLink",
  ".stuckTitle",
  ".doneTitle",
  ".footLink",
  ".card",
  ".nameLink",
  ".allProjects",
  ".emptyLink",
  ".retry",
];

const COMPONENTS = [
  "StandupHomeView",
  "StandupParts",
  "NeedsYouPanel",
  "StuckPanel",
  "DoneSincePanel",
  "ProjectCard",
  "ProjectGrid",
];

describe("Standup home: tap targets at phone widths", () => {
  it("names every link and button class the components render, so the roster is not stale", () => {
    // Guards the roster against drifting from the markup: a class used by a
    // component but missing above would never be height-checked.
    const used = new Set<string>();
    for (const name of COMPONENTS) {
      const source = readFileSync(
        path.resolve(import.meta.dirname, `../src/components/standup/${name}.tsx`),
        "utf8",
      );
      for (const m of source.matchAll(/<(?:Link|a|button)\b[^>]*className=\{styles\.(\w+)\}/g)) {
        used.add(`.${m[1]!}`);
      }
    }
    expect([...used].sort()).toEqual([...TAP_TARGET_CLASSES].sort());
  });

  it("declares 44px on every tap target where a phone will read it", () => {
    const narrow = narrowBlock();
    for (const selector of TAP_TARGET_CLASSES) {
      const match = /min-height:\s*(\d+)px/.exec(ruleFor(narrow, selector));
      expect(match, `${selector} declares no min-height at phone widths`).not.toBeNull();
      expect(Number(match![1]), `${selector} is under the 44px minimum`).toBeGreaterThanOrEqual(44);
    }
  });

  it("gives each tap target a box that min-height actually binds on", () => {
    // `min-height` on a bare inline box does nothing: every target must be
    // flex, inline-flex or block for the declaration to have an effect.
    for (const selector of TAP_TARGET_CLASSES) {
      expect(
        ruleFor(CODE, selector),
        `${selector} sets no display, so its min-height is inert`,
      ).toMatch(/display:\s*(inline-flex|flex|block|inline-block|grid)/);
    }
  });

  it("drops the Needs-you button under its text at phone width, and hides the legend", () => {
    const narrow = narrowBlock();
    expect(ruleFor(narrow, ".needsRow")).toMatch(/display:\s*flex/);
    expect(ruleFor(narrow, ".needsRow")).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleFor(narrow, ".needsMain")).toMatch(/flex:\s*1 0 100%/);
    expect(ruleFor(narrow, ".legend")).toMatch(/display:\s*none/);
  });
});

describe("Standup home: layout and motion", () => {
  it("places the four panels in grid areas from 1100px, so the DOM can stay in reading order", () => {
    const wide = blockOf("@media (min-width: 1100px)");
    const layout = ruleFor(wide, ".layout");
    expect(layout).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) 360px/);
    for (const row of ["needs stuck", "projects done"]) {
      expect(layout, `the busy layout is missing the row "${row}"`).toContain(`"${row}"`);
    }
    // With nothing stuck, Done moves up beside Needs you instead of leaving a hole.
    const noStuck = ruleFor(wide, '.layout[data-has-stuck="false"]');
    expect(noStuck).toContain('"needs done"');
    expect(noStuck).toContain('"projects done"');
    for (const [selector, area] of [
      [".areaNeeds", "needs"],
      [".areaStuck", "stuck"],
      [".areaProjects", "projects"],
      [".areaDone", "done"],
    ] as const) {
      expect(ruleFor(wide, selector), `${selector} is not placed in the ${area} area`).toMatch(
        new RegExp(`grid-area:\\s*${area}\\b`),
      );
    }
  });

  it("stacks in one column below 1100px and shows two columns of cards from 720px", () => {
    // The base rule is one column: grid areas are only declared in the wide block.
    const outsideWide = CODE.replace(blockOf("@media (min-width: 1100px)"), "");
    expect(ruleFor(outsideWide, ".layout")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(ruleFor(outsideWide, ".layout")).not.toContain("grid-template-areas");
    expect(ruleFor(blockOf("@media (min-width: 720px)"), ".grid")).toMatch(
      /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
    );
  });

  it("runs the skeleton's shimmer only when motion is welcome", () => {
    const allowed = blockOf("@media (prefers-reduced-motion: no-preference)");
    expect(allowed).toMatch(/animation:\s*standupShimmer/);
    // Every `animation` declaration in the sheet is the one inside that block.
    expect(CODE.split(/animation:/).length - 1).toBe(allowed.split(/animation:/).length - 1);
  });
});
