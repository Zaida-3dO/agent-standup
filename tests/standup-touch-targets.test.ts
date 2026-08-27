// The Standup home's tap targets at phone widths — the defect found in the
// M10 visual pass #3 (`/` at 320px).
//
// ── What was wrong, and why the earlier fix missed it ─────────────────
//
// PR #285 raised this page's tap targets to 44px and reported it done. It
// raised `.itemLink` and `.seeAll` — the Needs-you, In-flight and Overnight
// links — inside the `max-width: 640px` block, and those genuinely reach
// 44px. `.projectStripTitle`, the "Projects at a glance" links, is a
// separate class that block never mentioned, so the strip was never
// covered. A later reviewer measured it at 17px. #285's claim was narrower
// than it read rather than wrong.
//
// ── Why this test PARSES THE STYLESHEET ───────────────────────────────
//
// The same reason `tests/board-list-view-density.test.ts` gives at length:
// the claim is a property of the shipped `Standup.module.css`, and this
// repo's harness runs `environment: "node"` with no DOM and no layout
// engine.
//
// **This test does not measure a rendered layout, and does not claim to.**
// It asserts that the declarations a browser would act on are present, on
// every class that is a tap target. The rendered numbers come from a real
// headless browser and are recorded in the PR: the six strip links go from
// 17.4px to 44px at 320/360/390, the grid columns stay `150px 48px 40px`,
// and the bar stays on the title's row.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Deleting `min-height: 44px` from `.projectStripTitle` fails "every
//     tap target on this page declares 44px" — it is the fix itself.
//   - Lowering that 44 to any smaller number fails the same test.
//   - Deleting `display: flex` from it fails the box test: `min-height` on
//     an inline box is inert, which is the shape of bug that let a
//     `min-height` sit in the stylesheet doing nothing.
//   - Moving `.projectStripTitle`'s rule out of the narrow-width block
//     fails "declared where phones will read it".
//   - Adding a new anchor class to the page without a 44px rule fails the
//     roster test, which is what stops the next strip-shaped miss.
//   - Re-adding a `height` (not `min-height`) to `.projectStripItem` fails
//     the row test — a fixed row height would cap the cell it contains.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CSS = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/standup/Standup.module.css"),
  "utf8",
);

/** Strip comments, so a rule discussed in prose is never mistaken for a declared one. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The body of the one `@media (max-width: 640px)` block — what a phone
 * actually reads.
 *
 * Walks brace depth to the block's own closing brace rather than slicing to
 * end-of-file, and refuses to guess when the block is declared more than
 * once — the same shape as `atRuleBlock` in
 * `tests/board-list-view-density.test.ts`. A slice-to-EOF version would
 * silently absorb anything appended below the block as if it were inside
 * it; this stylesheet's single media block happening to sit last in the
 * file does not make that safe, since it is a property of this particular
 * ordering rather than a guarantee this test can rely on without asserting
 * it directly.
 *
 * **Requires the prelude to be EXACTLY `@media (max-width: 640px)`**, not
 * merely start with it — the same substring-prefix hole row 9a43b772 found
 * elsewhere, and the identical shape `atRuleBlock` carried until this
 * sweep: a bare `CODE.indexOf("{", start)` after the header matches a
 * narrowed prelude like `@media (max-width: 640px) and (min-width: 580px)`
 * too, and everything inside that block would be read as if it were
 * unconditional at the whole breakpoint.
 */
function narrowBlock(): string {
  const header = "@media (max-width: 640px)";
  const occurrences = CODE.split(header).length - 1;
  expect(occurrences, `${occurrences} \`${header}\` blocks — expected exactly one`).toBe(1);
  const start = CODE.indexOf(header);
  const afterHeader = CODE.slice(start + header.length).match(/^\s*\{/);
  expect(
    afterHeader,
    `no \`${header}\` block — found the prelude as a substring prefix only (something sits between the header and the brace)`,
  ).not.toBeNull();
  const open = start + header.length + afterHeader![0].length - 1;
  let depth = 0;
  for (let i = open; i < CODE.length; i += 1) {
    if (CODE[i] === "{") depth += 1;
    if (CODE[i] === "}") {
      depth -= 1;
      if (depth === 0) return CODE.slice(open + 1, i);
    }
  }
  throw new Error(`Unterminated \`${header}\` block.`);
}

/** One class's declarations inside a stylesheet chunk. */
function ruleFor(chunk: string, selector: string): string {
  // Matches `.a, .b { ... }` as well as `.a { ... }`, so a class raised in
  // a shared rule counts — that is how `.itemLink`/`.seeAll` are written.
  const rules = [...chunk.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter((m) => m[1]!.split(",").some((s) => s.trim() === selector))
    .map((m) => m[2]!)
    .join(" ");
}

/**
 * Every class on this page that is a tap target — an anchor or a button.
 *
 * Kept as a literal roster rather than derived, because the point of it is
 * to fail when somebody adds a seventh link and does not think about its
 * height. Derived from the components: `.itemLink` (Needs-you, In-flight,
 * Overnight), `.seeAll` (all four blocks' footers), `.projectStripTitle`
 * (the strip).
 */
const TAP_TARGET_CLASSES = [".itemLink", ".seeAll", ".projectStripTitle"];

describe("Standup home — tap targets at phone widths", () => {
  it("names every anchor class the components actually render, so the roster is not stale", () => {
    // Guards the roster above against drifting from the markup: a link
    // class in a component but missing here would never be height-checked.
    const components = ["NeedsYouBlock", "InFlightBlock", "OvernightBlock", "ProjectsStrip"];
    const used = new Set<string>();
    for (const name of components) {
      const source = readFileSync(
        path.resolve(import.meta.dirname, `../src/components/standup/${name}.tsx`),
        "utf8",
      );
      for (const m of source.matchAll(/<(?:Link|a)\b[^>]*className=\{styles\.(\w+)\}/g)) {
        used.add(`.${m[1]!}`);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].sort()).toEqual([...TAP_TARGET_CLASSES].sort());
  });

  it("declares 44px on every tap target where a phone will read it", () => {
    const narrow = narrowBlock();
    for (const selector of TAP_TARGET_CLASSES) {
      const rule = ruleFor(narrow, selector);
      const match = /min-height:\s*(\d+)px/.exec(rule);
      expect(match, `${selector} declares no min-height at narrow widths`).not.toBeNull();
      expect(Number(match![1]), `${selector} is under the 44px minimum`).toBeGreaterThanOrEqual(44);
    }
  });

  it("gives each tap target a box that min-height actually binds on", () => {
    // `min-height` on a bare inline box does nothing. Every one of these
    // must be flex, inline-flex or block for the declaration to have an
    // effect — the difference between a fix and a fix-shaped comment.
    const narrow = narrowBlock();
    for (const selector of TAP_TARGET_CLASSES) {
      const rule = ruleFor(narrow, selector);
      expect(rule, `${selector} sets no display, so its min-height is inert`).toMatch(
        /display:\s*(inline-flex|flex|block|inline-block|grid)/,
      );
    }
  });

  it("lets the strip's row grow, rather than capping it at a fixed height", () => {
    // A `height` on the row would override the cell's min-height and put
    // the number back to 17px while leaving the fix in place above.
    const item = ruleFor(CODE, ".projectStripItem");
    expect(item).not.toMatch(/(^|[^-])height:\s*\d/);
  });

  it("keeps the strip's three columns, which is what the height fix must not cost", () => {
    // The strip exists for an at-a-glance comparison; the reason its links
    // were left short was a belief that raising them would force the bar
    // onto its own line. Measured: it does not, because the title is one
    // grid cell. This pins the column count so a later edit cannot quietly
    // trade the comparison away.
    const narrow = narrowBlock();
    const item = ruleFor(narrow, ".projectStripItem");
    const cols = /grid-template-columns:\s*([^;]+);/.exec(item);
    expect(cols).not.toBeNull();
    expect(cols![1]!.trim().split(/\s+(?![^(]*\))/)).toHaveLength(3);
  });
});
