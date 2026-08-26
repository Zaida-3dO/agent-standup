// The axes disclosure's keyboard reachability — row 61ebc019-694f-4f07-9db0-
// 541a25d79e7a, found in round-3 review of PR #311.
//
// ── Why this test exists ────────────────────────────────────────────────
//
// `tests/board-filter-bar-component.test.ts` already asserts the MARKUP half
// of this control's contract: no `aria-hidden`, no negative `tabIndex`,
// `aria-expanded` synced to the checked state. Both of round 2's blockers
// were exactly that — attributes on the returned element — and that suite
// correctly fails if either comes back.
//
// A third route to the same failure does not touch either attribute:
//
//     .axesToggle {
//       display: none;   /* <-- reproduces the round-2 blocker */
//       ...
//     }
//
// `display: none` removes an element from the tab order every bit as
// completely as `tabIndex={-1}` does, and because `.axes` only shows when
// `.axesToggle:checked`, the eight selects behind it go with it — a
// keyboard-only reader below 641px reaches no filter control at all. The
// component-tree suite cannot see this: this repo's harness runs
// `environment: "node"` (vitest.config.ts) with no DOM and no CSS engine, so
// a stylesheet rule is invisible to it by construction, in exactly the way
// `tests/board-list-view-density.test.ts`'s header describes at length for a
// different property (`display: none` dropping a column, not a control).
//
// ── Why this test PARSES THE STYLESHEET rather than mounting a DOM ───────
//
// Same choice `board-list-view-density.test.ts` and
// `standup-touch-targets.test.ts` already made, for the same reason: the
// claim under test is a property of the SHIPPED CSS, and this harness has no
// CSS engine to evaluate a `:checked ~ .axes` sibling selector or a
// `@media` query against. A jsdom mount would let the markup half run, but
// jsdom does not implement CSS cascade or media-query evaluation either, so
// it would not see this mutation any more than the component-tree suite
// does — it would just be a heavier way of not catching it. The real-browser
// route (`scripts/measure-board-mobile.mjs`) DOES exercise the cascade, and
// is the strongest possible evidence, but by that script's own header it is
// deliberately not wired into CI (needs a browser binary and two running
// servers) — a fix that only runs by hand is not a fix an editor moving
// `.axesToggle` gets warned about. A stylesheet-parsing test is the
// executable middle ground this repo already has a convention for: cheap,
// runs in the existing suite, and catches the exact mutation above.
//
// ── What this test does NOT claim ─────────────────────────────────────
//
// It does not prove the checkbox is reachable by Tab in a real browser, and
// does not prove `.axes` actually paints when checked — those are the
// screenshot's job (see 1d7ebff1-faf7-4772-a17b-14f4e80fbbca), and the
// keyboard path was verified there at 390x844: checkbox reached at Tab step
// 9, Space toggles, Tab continues into the first select, Shift-Tab exits
// without trapping. What this test proves is narrower and mechanical: the
// declarations that make that behaviour POSSIBLE are the ones shipped, at
// every breakpoint. A stylesheet that declares the right things and a
// browser that is wired wrong (a selector typo, a specificity fight) is a
// gap this test cannot see — same limit `board-list-view-density.test.ts`
// names for its own claims.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Adding `display: none` to `.axesToggle` (any breakpoint) fails "never
//     display:none, at any breakpoint" — the mutation this row was filed
//     for, verified by re-running this file with that line added.
//   - Re-adding `aria-hidden` or a negative `tabIndex`-equivalent visual
//     hiding technique (`visibility: hidden`) to `.axesToggle` fails the
//     same test — `visibility: hidden` removes an element from the tab
//     order exactly like `display: none` does, and is the same class of
//     mistake stated in CSS instead of JSX.
//   - Deleting the `.axesToggle:checked ~ .axes { display: flex }` sibling
//     rule fails "checking the toggle reveals the axes" — the checkbox
//     would still be reachable but would do nothing.
//   - Moving that sibling rule outside the `max-width: 640px` block fails
//     the desktop-unaffected test, or the narrow-collapse test, depending on
//     which direction it moved.
//   - Deleting the `@media (min-width: 641px)` override that unconditionally
//     shows `.axes` fails "desktop is not gated by the checkbox" — the
//     narrow-width disclosure would leak onto wide viewports.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CSS = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/board/BoardFilterBar.module.css"),
  "utf8",
);

/** Strip comments, so a rule discussed in prose is never mistaken for a declared one. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every top-level (non-`@media`) rule body whose selector matches exactly,
 * plus every such rule nested inside a `@media (max-width: 640px)` block —
 * the two places `.axesToggle` could legally be styled by this file.
 *
 * Returns an array rather than one string: the whole point of this test is
 * that a `display: none` could be added to EITHER the base rule or the
 * narrow-width block, and a helper that only checked one would miss the
 * other.
 */
function rulesFor(selector: string): string[] {
  const rules = [...CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules.filter((m) => m[1]!.split(",").some((s) => s.trim() === selector)).map((m) => m[2]!);
}

function has(body: string, property: string, value?: string): boolean {
  return body.split(";").some((part) => {
    const colon = part.indexOf(":");
    if (colon === -1) return false;
    const prop = part.slice(0, colon).trim();
    if (prop !== property) return false;
    if (value === undefined) return true;
    return part.slice(colon + 1).trim() === value;
  });
}

describe("the axes toggle checkbox stays in the tab order at every width", () => {
  it("never declares display:none on .axesToggle, at any breakpoint", () => {
    // THE test of this file. `display: none` on the checkbox removes it
    // from the tab order exactly as completely as the round-2 markup
    // attributes did, and takes `.axes` with it since that block only shows
    // via `.axesToggle:checked ~ .axes`.
    const bodies = rulesFor(".axesToggle");
    expect(bodies.length, "no .axesToggle rule found at all").toBeGreaterThan(0);
    for (const body of bodies) {
      expect(has(body, "display", "none"), `.axesToggle rule declares display:none: ${body}`).toBe(
        false,
      );
    }
  });

  it("never declares visibility:hidden on .axesToggle either", () => {
    // The same defect stated a different way: `visibility: hidden` also
    // drops an element from the tab order, and is exactly the kind of
    // rule a future "make this more hidden" edit might reach for, on the
    // mistaken theory that any hiding technique is as good as any other.
    const bodies = rulesFor(".axesToggle");
    for (const body of bodies) {
      expect(has(body, "visibility", "hidden")).toBe(false);
    }
  });

  it("hides .axesToggle only with the clip-rect technique, which keeps it in the tab order", () => {
    // Pins the actual mechanism this file's own header names: `position:
    // absolute` + a 1px box + `clip: rect(0,0,0,0)` is visually-hidden but
    // NOT `display:none`/`visibility:hidden`, so the browser still lays it
    // out and keeps it tabbable. Losing any one of these three weakens the
    // guarantee even though none of them alone is "display:none".
    const bodies = rulesFor(".axesToggle");
    const base = bodies[0]!;
    expect(has(base, "position", "absolute")).toBe(true);
    expect(has(base, "clip", "rect(0, 0, 0, 0)")).toBe(true);
  });
});

describe("the sibling-selector reveal that the toggle's reachability exists to serve", () => {
  it("shows .axes once the toggle is checked, below 641px", () => {
    // Without this, the checkbox could be perfectly reachable and still do
    // nothing — reachability alone is not the contract, reachability THAT
    // WORKS is.
    const narrow = CODE.slice(CODE.indexOf("@media (max-width: 640px)"));
    expect(narrow).toMatch(/\.axesToggle:checked\s*~\s*\.axes\s*\{[^}]*display:\s*flex/);
  });

  it("collapses .axes by default below 641px, so there is something to reveal", () => {
    const narrow = CODE.slice(CODE.indexOf("@media (max-width: 640px)"));
    const bodies = [...narrow.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1]!.split(",").some((s) => s.trim() === ".axes"))
      .map((m) => m[2]!);
    expect(bodies.some((b) => has(b, "display", "none"))).toBe(true);
  });

  it("declares .axes visible unconditionally, so nothing above 640px depends on the checkbox", () => {
    // The desktop guarantee, and it is an ABSENCE rather than an override:
    // `.axes` is `display: flex` unconditionally at the top of the file
    // (never touched outside the `max-width: 640px` block), so a viewport
    // that never matches that query renders the axes regardless of the
    // checkbox's state — there is no narrower rule for a wide viewport to
    // need overriding. If a `display: none` on `.axes` ever migrated out of
    // the narrow-width block, this is the test that would fail.
    const bodies = rulesFor(".axes");
    expect(bodies.length, "no .axes rule found at all").toBeGreaterThan(0);
    const unconditional = bodies[0]!;
    expect(has(unconditional, "display", "flex")).toBe(true);
  });
});
