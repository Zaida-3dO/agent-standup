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
 */
function narrowBlock(code: string): string {
  let out = "";
  let index = 0;
  let found = 0;
  while (true) {
    const start = code.indexOf("@media (max-width: 640px)", index);
    if (start === -1) break;
    found += 1;
    const open = code.indexOf("{", start);
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

  it("names every roster target the four stylesheets actually declare touch-target CSS for", () => {
    // Guards the roster itself against drifting: this is the assertion that
    // stops the next `.projectStripTitle`-shaped miss, where a class exists
    // in the narrow-width block but nobody added it to the list above. Scans
    // each stylesheet's narrow-width block for every class selector present
    // and checks each one is either in the roster or is `.densityButton`
    // (covered separately) or a non-target support class this row's own
    // history explains (`.bar`, `.axes`, `.axesSummary`, `.axesToggle`,
    // `.searchLabel`, `.searchChord`, `.createLabel`, `.name` — spacing,
    // disclosure and hide-on-narrow rules, not things a thumb taps).
    const NON_TARGET_CLASSES = new Set([
      "bar",
      "axes",
      "axesSummary",
      "axesToggle",
      "searchLabel",
      "searchChord",
      "createLabel",
      "name",
    ]);
    const rosterSelectors = new Set(MIN_HEIGHT_TARGETS.map((t) => `.${t.selector.slice(1)}`));
    rosterSelectors.add(".densityButton");

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
});
