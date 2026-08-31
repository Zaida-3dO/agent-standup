// The filter sheet at phone widths — MILESTONES.md #76, "filters in a
// sheet".
//
// ── Why this test PARSES THE STYLESHEET ────────────────────────────────
//
// The same precedent, and the same reason, as
// `tests/board-header-touch-targets.test.ts` and
// `tests/board-list-view-density.test.ts`: the claim is a property of the
// shipped CSS, and this repo's harness runs `environment: "node"`
// (`vitest.config.ts`) with no DOM and no layout engine. There is nothing
// to measure a rendered sheet with, so this asserts that the declarations
// a browser would act on are present, in a block a phone actually reads.
//
// **This does not measure a rendered layout and does not claim to.** The
// visual evidence for this row is screenshots at phone widths, recorded on
// the pull request.
//
// **The markup was deliberately not changed** — the disclosure's
// checkbox/label/panel wiring and all of its ARIA is row 74ef86fb's, and it
// carries a documented latent trap about focusability. This row restyles
// where the already-shown panel is painted, so the tests below are about
// the stylesheet only. `tests/board-filter-bar-component.test.ts` continues
// to guard the markup and is untouched.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Dropping `position: fixed` from the opened panel fails "lifts the
//     opened panel out of the flow" — the regression that would put the
//     filters back inline, pushing the board down the page, which is the
//     defect this row exists to fix.
//   - Dropping or lowering `max-height` fails "is bounded and scrolls
//     inside itself" — without it a reader who has turned on every axis
//     cannot reach the last one.
//   - Dropping `overflow-y: auto` fails the same test.
//   - Raising the sheet's `z-index` to 60 or above fails "sits below the
//     create dialog" — the "you can still mint work" half of this row:
//     minting has to open OVER the sheet.
//   - Moving any of it out of the `max-width: 640px` block fails "only at
//     phone widths", which is what keeps the desktop filter bar unchanged.
//   - Deleting the `.axesToggle:checked ~ .axes` selector entirely fails
//     every test here, because there would be no opened-panel rule to read.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { matchingBrace } from "./helpers/css-blocks";

/** The filter bar's stylesheet, comment-stripped. */
const FILTER_BAR_CSS = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/board/BoardFilterBar.module.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The concatenated bodies of every `@media (max-width: 640px)` block.
 *
 * Lifted from `board-header-touch-targets.test.ts`, including its two
 * hard-won properties: this file splits the breakpoint across MULTIPLE
 * blocks (the disclosure and the touch-target sweep landed separately), so
 * stopping at the first would read as "no rule" for everything in the
 * second; and the prelude must match EXACTLY rather than by prefix, or a
 * narrowed `... and (min-width: 500px)` would be read as though it applied
 * at the whole breakpoint (row 9a43b772).
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
      index = start + header.length;
      continue;
    }
    found += 1;
    const open = start + header.length + afterHeader[0].length - 1;
    const close = matchingBrace(code, open);
    out += code.slice(open + 1, close) + "\n";
    index = close + 1;
  }
  expect(found, "no @media (max-width: 640px) block").toBeGreaterThan(0);
  return out;
}

/** Every rule whose selector list includes this exact selector. */
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

/** The selector that styles the panel once the disclosure is open. */
const OPENED = ".axesToggle:checked ~ .axes";

const NARROW = narrowBlock(FILTER_BAR_CSS);

/**
 * The opened panel's rule, read from INSIDE the phone-width block.
 *
 * Read from `NARROW` rather than from the whole stylesheet on purpose: a
 * declaration that is correct but sits in a base rule would apply on the
 * desktop too, which is the thing this row must not do. Row afd1b4b4 is
 * the inverse of this mistake and is why the status picker's own 44px sits
 * in a base rule instead — the two are different claims about different
 * controls.
 */
function openedPanelRule(): string {
  const rules = rulesFor(NARROW, OPENED);
  expect(rules, `no ${OPENED} rule inside the phone-width block`).toHaveLength(1);
  return rules[0]!;
}

describe("the filter sheet at phone widths", () => {
  it("lifts the opened panel out of the flow, so the board does not move under it", () => {
    // Inline expansion was the defect: opening the filters pushed the
    // cards down the page, so a reader lost sight of what they were
    // filtering and had to scroll back up past ~400px of controls.
    expect(declaration(openedPanelRule(), "position")).toBe("fixed");
  });

  it("anchors to the bottom edge, within a thumb's reach", () => {
    const rule = openedPanelRule();
    expect(declaration(rule, "bottom")).toBe("0");
    // Full-bleed: a sheet inset from the sides wastes the width a phone
    // has least of.
    expect(declaration(rule, "left")).toBe("0");
    expect(declaration(rule, "right")).toBe("0");
  });

  it("is bounded and scrolls inside itself", () => {
    // A reader with every axis turned on must still reach the last one,
    // and must still see some of the board behind the sheet — which is
    // what keeps it legible as a temporary layer rather than a new page.
    const rule = openedPanelRule();
    const maxHeight = declaration(rule, "max-height");
    expect(maxHeight).toBeDefined();
    const vh = Number(maxHeight!.replace("vh", ""));
    expect(
      maxHeight!.endsWith("vh"),
      `max-height should be viewport-relative, got ${maxHeight}`,
    ).toBe(true);
    expect(vh).toBeLessThan(100);
    expect(declaration(rule, "overflow-y")).toBe("auto");
  });

  it("sits above the app chrome but BELOW the create dialog, so work can still be minted", () => {
    // The "you can still mint work" half of #76. `QuickCreateDialog` is at
    // z-index 60 (`QuickCreateDialog.module.css`); a sheet at or above
    // that would cover the dialog that opens over it, making minting from
    // a phone impossible while the filters are open.
    const z = Number(declaration(openedPanelRule(), "z-index"));
    expect(z).toBeGreaterThan(1);
    expect(z).toBeLessThan(60);
  });

  it("is opaque, because the board scrolls behind it", () => {
    // A translucent sheet over moving cards is unreadable.
    expect(declaration(openedPanelRule(), "background")).toBe("var(--surface-panel)");
  });

  it("applies only at phone widths, leaving the desktop filter bar untouched", () => {
    // Every declaration asserted above must live inside the breakpoint.
    // The whole-stylesheet rule set for this selector is exactly the one
    // narrow rule — a second, unconditional one would restyle the desktop.
    expect(rulesFor(FILTER_BAR_CSS, OPENED)).toHaveLength(1);
  });

  it("still shows the panel when the disclosure is open", () => {
    // The property row 74ef86fb established, and one this row keeps: the
    // sheet is worth nothing unless opening it reveals the axes.
    expect(declaration(openedPanelRule(), "display")).toBe("flex");
  });
});
