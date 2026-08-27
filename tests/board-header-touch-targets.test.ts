// The board header's tap targets at phone widths — PR #311 (row
// f79b3528-c298-4360-91b1-e5d90387ace3), which shipped seven `44px`
// declarations across four stylesheets with zero tests.
//
// ── Why this test PARSES THE STYLESHEETS ───────────────────────────────
//
// Exactly the precedent named in the row: `tests/standup-touch-targets.test.ts`
// caught the #285 gap this way, for the same underlying reason
// `tests/board-list-view-density.test.ts`'s header gives at length — the
// claim is a property of the shipped CSS, and this repo's harness runs
// `environment: "node"` (vitest.config.ts) with no DOM and no layout
// engine. PR #311's own numbers were verified in a real browser (68/80/80
// under-44px targets at 320/360/390 down to 0, 135 targets rendering on
// both branches) and are recorded in its history rather than re-derived
// here — `scripts/measure-board-mobile.mjs` produces those and is
// deliberately not wired into CI (needs a browser binary and two running
// servers), so it cannot be the regression guard either.
//
// **This test does not measure a rendered layout, and does not claim to.**
// It asserts that the declarations a browser would act on are present, on
// every class PR #311 touched.
//
// ── Two mechanisms, not one ─────────────────────────────────────────────
//
// Six of the seven declarations are `min-height: 44px` on a box whose
// `display` makes `min-height` bind (the precedent's shape exactly).
// `TopBar.module.css`'s `.densityButton` is the seventh and uses a
// different, equally valid mechanism — a fixed 44x44px square, because it
// is an icon-only button with no label to let grow — so it gets its own
// assertion rather than being forced into the `min-height` roster.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Deleting or lowering any of the six `min-height: 44px` declarations
//     below fails "declares 44px" for that selector.
//   - Deleting the `display` that makes one of those `min-height`s bind
//     fails the box test — `min-height` on an inline box is inert, which is
//     the shape of bug `standup-touch-targets.test.ts` names in its own
//     header.
//   - Shrinking `.densityButton`'s narrow-width `width`/`height` below 44px
//     fails its own test.
//   - Moving any of these seven rules out of their `max-width: 640px` block
//     fails "declared where a phone will read it".
//   - Adding a new interactive control to one of these four files with no
//     44px rule fails the roster test — the one that stops the next
//     `.projectStripTitle`-shaped miss, this time on the board header.
//   - Shrinking `.axesSummary`'s or `.menuButton`'s BASE-rule size below
//     44px fails "declares >=44px on every base-rule roster target" —
//     row afd1b4b4: both escaped every test above, mutation-verified
//     (44px -> 20px/24px, all green), because the roster and completeness
//     tests only ever look inside `max-width: 640px` blocks and both of
//     these declare their real size in a base rule instead.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/** One of the four stylesheets PR #311 touched, comment-stripped. */
function css(relPath: string): string {
  const raw = readFileSync(path.resolve(import.meta.dirname, relPath), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "");
}

const BOARD_CSS = css("../src/components/board/Board.module.css");
const FILTER_BAR_CSS = css("../src/components/board/BoardFilterBar.module.css");
const LAYOUT_TOGGLE_CSS = css("../src/components/board/LayoutToggle.module.css");
const TOP_BAR_CSS = css("../src/components/top-bar/TopBar.module.css");

/**
 * The concatenated bodies of every `@media (max-width: 640px)` block in a
 * stylesheet.
 *
 * **Not "the one block"** — unlike `ListView.module.css` (which
 * `board-list-view-density.test.ts` can assume declares each breakpoint
 * exactly once), `BoardFilterBar.module.css` and `TopBar.module.css` each
 * split this breakpoint across multiple blocks (the disclosure and the
 * touch-target sweep landed as separate edits at different points in the
 * file). A helper that stopped at the first block would silently read as
 * "no rule" for every selector declared in the second one — which is
 * exactly where `.select` and five of its roster siblings live.
 *
 * **Requires the prelude to be EXACTLY `@media (max-width: 640px)`**, not
 * merely start with it. Row 9a43b772 found this file's original version —
 * `code.indexOf(header, index)` followed by `code.indexOf("{", start)` —
 * matches by substring prefix, so a narrowed prelude like
 * `@media (max-width: 640px) and (min-width: 500px)` is still found and
 * everything inside it is read as if it were unconditional at the whole
 * breakpoint. That row's own mutation was against
 * `BoardFilterBar.module.css`'s disclosure block, not this file's
 * `.select`-roster block, but the same substring match is used here and
 * the row names this file explicitly as carrying the identical hole.
 */
function narrowBlock(code: string): string {
  const header = "@media (max-width: 640px)";
  let out = "";
  let index = 0;
  let found = 0;
  while (true) {
    const start = code.indexOf(header, index);
    if (start === -1) break;
    const afterHeader = code.slice(start + header.length).match(/^\s*\{/);
    if (!afterHeader) {
      // Prefix match only — an `and (...)` (or anything else) sits between
      // the header and the brace, so this is not a real occurrence of the
      // exact block. Skip past it and keep looking.
      index = start + header.length;
      continue;
    }
    found += 1;
    const open = start + header.length + afterHeader[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out += code.slice(open + 1, i) + "\n";
    index = i + 1;
  }
  expect(found, "no @media (max-width: 640px) block").toBeGreaterThan(0);
  return out;
}

/** Every rule whose selector list includes this exact selector, across the whole stylesheet. */
function rulesFor(code: string, selector: string): string[] {
  const rules = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules.filter((m) => m[1]!.split(",").some((s) => s.trim() === selector)).map((m) => m[2]!);
}

function declaration(body: string, property: string): string | undefined {
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    if (part.slice(0, colon).trim() === property) return part.slice(colon + 1).trim();
  }
  return undefined;
}

/**
 * Every class in `BoardFilterBar.module.css`, `Board.module.css` and
 * `LayoutToggle.module.css` that PR #311 raised with `min-height: 44px` —
 * the roster this test's own header explains the purpose of. `TopBar`'s
 * `.densityButton` is deliberately excluded: it uses fixed width/height
 * instead and has its own dedicated test below.
 *
 * `inlineByDefault` records whether the element this class is applied to is
 * `display: inline` in the browser's UA stylesheet with nothing declared —
 * true for `<span>`/`<a>` (used by `.viewChip` and `.cardTitle`), false for
 * `<select>`/`<input>`/`<button>` (already `inline-block` or better with no
 * CSS at all). It is what "min-height binds" actually depends on: a
 * `<select>` needs no explicit `display` for its `min-height` to take
 * effect, but a `<span>` does. Verified against the component source
 * (`BoardFilterBarView.tsx`, `SavedViewsView.tsx`, `Board.module.css`'s
 * `.cardTitle` anchor, `LayoutToggle.tsx`'s `.option` anchor, `TopBar.tsx`).
 */
const MIN_HEIGHT_TARGETS: ReadonlyArray<{
  readonly name: string;
  readonly code: string;
  readonly selector: string;
  readonly inlineByDefault: boolean;
}> = [
  { name: ".select", code: FILTER_BAR_CSS, selector: ".select", inlineByDefault: false },
  { name: ".direction", code: FILTER_BAR_CSS, selector: ".direction", inlineByDefault: false },
  {
    name: ".search (filter bar)",
    code: FILTER_BAR_CSS,
    selector: ".search",
    inlineByDefault: false,
  },
  { name: ".clear", code: FILTER_BAR_CSS, selector: ".clear", inlineByDefault: false },
  { name: ".viewName", code: FILTER_BAR_CSS, selector: ".viewName", inlineByDefault: false },
  {
    name: ".pickerToggle",
    code: FILTER_BAR_CSS,
    selector: ".pickerToggle",
    inlineByDefault: false,
  },
  // `.viewChip` decorates both a `<span>` (SavedViewsView.tsx) and a
  // `<button>` inside it — the span is what makes this one inline by
  // default, and it does declare `display: inline-flex` in the narrow
  // block, so the assertion holds either way.
  { name: ".viewChip", code: FILTER_BAR_CSS, selector: ".viewChip", inlineByDefault: true },
  { name: ".levelChip", code: FILTER_BAR_CSS, selector: ".levelChip", inlineByDefault: false },
  { name: ".levelMode", code: FILTER_BAR_CSS, selector: ".levelMode", inlineByDefault: false },
  { name: ".cardTitle", code: BOARD_CSS, selector: ".cardTitle", inlineByDefault: true },
  {
    name: ".option (layout toggle)",
    code: LAYOUT_TOGGLE_CSS,
    selector: ".option",
    inlineByDefault: true,
  },
  { name: ".search (top bar)", code: TOP_BAR_CSS, selector: ".search", inlineByDefault: false },
  { name: ".create", code: TOP_BAR_CSS, selector: ".create", inlineByDefault: false },
  { name: ".switcher", code: TOP_BAR_CSS, selector: ".switcher", inlineByDefault: false },
];

/**
 * Tap targets whose >=44px size lives in a BASE rule rather than inside a
 * `max-width: 640px` block — found missing entirely in review (row
 * afd1b4b4). `narrowBlock()` only ever looks inside narrow-width blocks, so
 * neither of these was checked by anything: `.axesSummary`'s `min-height`
 * is set once, in its base rule, and only its `display` is toggled inside
 * the narrow block; `.menuButton`'s fixed `width`/`height` is likewise a
 * base-rule declaration, gated behind a DIFFERENT breakpoint entirely
 * (`@media (max-width: 900px)`, not 640px) that this file's `narrowBlock`
 * does not even search for. Both escaped mutation (44px -> 20px/24px) with
 * every test in this file green.
 */
const BASE_RULE_TARGETS: ReadonlyArray<{
  readonly name: string;
  readonly code: string;
  readonly selector: string;
  readonly property: "min-height" | "width" | "height";
}> = [
  // The <label> that opens the axes disclosure — the only thing a thumb
  // taps to reach the filters at all on a phone.
  { name: ".axesSummary", code: FILTER_BAR_CSS, selector: ".axesSummary", property: "min-height" },
  // The mobile nav sheet trigger, a fixed 44x44px square (same mechanism as
  // .densityButton), shown only under @media (max-width: 900px).
  { name: ".menuButton (width)", code: TOP_BAR_CSS, selector: ".menuButton", property: "width" },
  { name: ".menuButton (height)", code: TOP_BAR_CSS, selector: ".menuButton", property: "height" },
];

describe("board header — tap targets at phone widths (PR #311)", () => {
  it("declares min-height 44px on every roster target, where a phone will read it", () => {
    for (const target of MIN_HEIGHT_TARGETS) {
      const narrow = narrowBlock(target.code);
      const bodies = rulesFor(narrow, target.selector);
      expect(bodies.length, `${target.name} has no rule in the narrow-width block`).toBeGreaterThan(
        0,
      );
      const declared = bodies.map((b) => declaration(b, "min-height")).find((v) => v !== undefined);
      expect(declared, `${target.name} declares no min-height at narrow widths`).toBeDefined();
      expect(
        Number(/(\d+)px/.exec(declared!)?.[1]),
        `${target.name} is under the 44px minimum`,
      ).toBeGreaterThanOrEqual(44);
    }
  });

  it("gives each inline-by-default roster target a box that min-height actually binds on", () => {
    // `min-height` on a bare INLINE box does nothing — the exact shape of
    // bug `standup-touch-targets.test.ts` was written to catch, there for
    // `.projectStripTitle`. That precedent's targets were all `<a>`, whose
    // UA default is `display: inline`, so every one of them genuinely
    // needed an explicit `display` for `min-height` to bind.
    //
    // This roster is not uniform the same way: `.select`/`.search`/
    // `.viewName` are `<select>`/`<input>`, and `.direction`/`.clear`/
    // `.pickerToggle`/`.levelChip`/`.levelMode`/TopBar's `.search`/
    // `.create`/`.switcher` are `<button>` — form controls and buttons are
    // `inline-block` (or better) in every browser's UA stylesheet with zero
    // author CSS, so `min-height` already binds on them without a `display`
    // declaration, and requiring one would be asserting a property these
    // targets do not need and PR #311 correctly did not add. Only the
    // `inlineByDefault` targets (`<span>`/`<a>`) carry the real risk this
    // test exists to catch, so only those are checked here — checked
    // against BOTH the narrow block and the base rule, since `.search`/
    // `.create`/`.switcher` on TopBar declare `display: flex`
    // unconditionally rather than inside the breakpoint.
    for (const target of MIN_HEIGHT_TARGETS.filter((t) => t.inlineByDefault)) {
      const narrow = narrowBlock(target.code);
      const narrowBody = rulesFor(narrow, target.selector).join(" ");
      const baseBody = rulesFor(target.code, target.selector).join(" ");
      const bindable = /display:\s*(inline-flex|flex|block|inline-block|grid)/;
      expect(
        bindable.test(narrowBody) || bindable.test(baseBody),
        `${target.name} is inline by default (span/anchor) and sets no bindable display in the narrow block or its base rule, so its min-height is inert`,
      ).toBe(true);
    }
  });

  it("grows .densityButton to a fixed 44x44px square, the mechanism its icon-only form uses", () => {
    // No label to let grow, unlike the roster above — width/height is the
    // right tool here, not min-height. Its own dedicated assertion so a
    // shrink here does not need to be smuggled into the roster's shape.
    const narrow = narrowBlock(TOP_BAR_CSS);
    const bodies = rulesFor(narrow, ".densityButton");
    expect(bodies.length, ".densityButton has no rule in the narrow-width block").toBeGreaterThan(
      0,
    );
    const body = bodies[0]!;
    expect(Number(/(\d+)px/.exec(declaration(body, "width") ?? "")?.[1])).toBeGreaterThanOrEqual(
      44,
    );
    expect(Number(/(\d+)px/.exec(declaration(body, "height") ?? "")?.[1])).toBeGreaterThanOrEqual(
      44,
    );
  });

  it("declares >=44px on every base-rule roster target, regardless of which block it sits in", () => {
    // Row afd1b4b4: `.axesSummary` and `.menuButton` are real 44px phone tap
    // targets whose size is set in a BASE rule rather than inside a
    // `max-width: 640px` block — narrowBlock() cannot see either. This
    // asserts BASE_RULE_TARGETS directly, against the whole stylesheet
    // rather than any one block, which is what makes it independent of
    // narrowBlock() and its 640px assumption.
    for (const target of BASE_RULE_TARGETS) {
      const bodies = rulesFor(target.code, target.selector);
      expect(
        bodies.length,
        `${target.name} has no rule anywhere in the stylesheet`,
      ).toBeGreaterThan(0);
      const declared = bodies
        .map((b) => declaration(b, target.property))
        .find((v) => v !== undefined);
      expect(declared, `${target.name} declares no ${target.property}`).toBeDefined();
      expect(
        Number(/(\d+)px/.exec(declared!)?.[1]),
        `${target.name} is under the 44px minimum`,
      ).toBeGreaterThanOrEqual(44);
    }
  });

  it("names every roster target the four stylesheets actually declare touch-target CSS for", () => {
    // Guards the roster itself against drifting: this is the assertion that
    // stops the next `.projectStripTitle`-shaped miss, where a class exists
    // in the narrow-width block but nobody added it to the list above. Scans
    // each stylesheet's narrow-width block for every class selector present
    // and checks each one is either in the roster or is `.densityButton`
    // (covered separately) or a non-target support class this row's own
    // history explains (`.bar`, `.axes`, `.axesToggle`, `.searchLabel`,
    // `.searchChord`, `.createLabel`, `.name` — spacing, disclosure and
    // hide-on-narrow rules, not things a thumb taps).
    //
    // NOT `.axesSummary` — found in review (row afd1b4b4) to be a real 44px
    // phone tap target (the disclosure trigger a thumb taps to reach the
    // filters at all), wrongly filed here as decoration. It stays out of
    // NON_TARGET_CLASSES and is instead a real `BASE_RULE_TARGETS` entry,
    // checked by the test above, since its `min-height` lives in its base
    // rule rather than inside this narrow-width block.
    const NON_TARGET_CLASSES = new Set([
      "bar",
      "axes",
      "axesToggle",
      "searchLabel",
      "searchChord",
      "createLabel",
      "name",
    ]);
    const rosterSelectors = new Set(MIN_HEIGHT_TARGETS.map((t) => `.${t.selector.slice(1)}`));
    rosterSelectors.add(".densityButton");
    rosterSelectors.add(".axesSummary");

    for (const code of [BOARD_CSS, FILTER_BAR_CSS, LAYOUT_TOGGLE_CSS, TOP_BAR_CSS]) {
      const narrow = narrowBlock(code);
      const selectors = [...narrow.matchAll(/([^{}]+)\{/g)]
        .flatMap((m) => m[1]!.split(","))
        .map((s) => s.trim())
        .filter((s) => /^\.[A-Za-z][\w-]*$/.test(s));
      for (const selector of selectors) {
        const className = selector.slice(1);
        if (NON_TARGET_CLASSES.has(className)) continue;
        expect(
          rosterSelectors.has(selector),
          `${selector} appears in a narrow-width block but is not in the touch-target roster — ` +
            `either it needs a 44px rule and a roster entry, or it belongs in NON_TARGET_CLASSES`,
        ).toBe(true);
      }
    }
  });

  it("names every selector the four stylesheets declare a >=44px min-height/width/height for, anywhere in the file", () => {
    // The stronger half of the afd1b4b4 fix. The test above only scans
    // inside `@media (max-width: 640px)` blocks — it would not have caught
    // `.axesSummary` or `.menuButton` even after they were added to
    // BASE_RULE_TARGETS by hand, and it is exactly the kind of miss that
    // let both escape in the first place. This scans EVERY rule in each
    // stylesheet (base rules and every block alike) for a >=44px
    // `min-height`/`width`/`height` and requires each such selector to be a
    // known tap target: the min-height roster, `.densityButton` and the
    // base-rule roster above, or a class in BASE_NON_TARGET_CLASSES for a
    // real >=44px box that is verified, case by case, not to be one.
    //
    // **Known limit, left deliberately (row a7618c76, decision recorded on
    // the row rather than built): this scan is keyed on SIZE, not on
    // markup.** It only inspects rules that already declare >=44px, so a
    // brand-new UNDERSIZED control — e.g. `.tinyButton { min-height: 18px }`
    // — never enters the check and passes silently. That is the actual
    // `.projectStripTitle`-shaped miss this file exists to prevent; the
    // scan below only catches "declared big but unrostered", not "declared
    // too small". `tests/standup-touch-targets.test.ts` closes the
    // equivalent gap on the Standup home by parsing component TSX for
    // `<Link>`/`<a>` tap targets and asserting the roster matches what
    // actually renders — a real markup-drift guard. This file's roster
    // spans four components and three element families (`<button>`,
    // `<select>`/`<input>`, `<a>`/`<span>`), so the same approach here is
    // materially more scope than that precedent, not a like-for-like port.
    // Two directions were on the table and neither was taken casually: (a)
    // parse all four components for interactive elements and require each
    // to be rostered or excused, or (b) assert the SET of scanned
    // stylesheets against a glob so a fifth board-area file can't silently
    // fall outside scope either. Left undone; if you are adding a new
    // interactive control below 44px to one of these four files, this
    // suite will not catch it — verify it by hand or in a real browser.
    const knownSelectors = new Set(MIN_HEIGHT_TARGETS.map((t) => `.${t.selector.slice(1)}`));
    knownSelectors.add(".densityButton");
    for (const target of BASE_RULE_TARGETS) knownSelectors.add(target.selector);

    // Nothing is in this set — `.avatar` (28px) and `.select`'s
    // `height: 30px` never reach 44px, so neither trips the scan. This
    // exists so the next real >=44px non-target box has somewhere to go
    // other than silently widening the roster.
    const BASE_NON_TARGET_CLASSES = new Set<string>([]);

    for (const code of [BOARD_CSS, FILTER_BAR_CSS, LAYOUT_TOGGLE_CSS, TOP_BAR_CSS]) {
      const rules = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      for (const rule of rules) {
        const selectors = rule[1]!
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^\.[A-Za-z][\w-]*$/.test(s));
        if (selectors.length === 0) continue;
        const body = rule[2]!;
        const sizes = ["min-height", "width", "height"]
          .map((prop) => declaration(body, prop))
          .map((v) => Number(/(\d+)px/.exec(v ?? "")?.[1]))
          .filter((n) => !Number.isNaN(n));
        if (!sizes.some((n) => n >= 44)) continue;
        for (const selector of selectors) {
          const className = selector.slice(1);
          if (BASE_NON_TARGET_CLASSES.has(className)) continue;
          expect(
            knownSelectors.has(selector),
            `${selector} declares a >=44px min-height/width/height somewhere in the stylesheet but is ` +
              `not a known tap target — either it needs a BASE_RULE_TARGETS entry or it belongs in BASE_NON_TARGET_CLASSES`,
          ).toBe(true);
        }
      }
    }
  });
});
