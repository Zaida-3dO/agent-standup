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
//   - Adding `display: none` to `.axes`'s own base rule (outside the
//     `max-width: 640px` block) fails "declares .axes visible
//     unconditionally, so nothing above 640px depends on the checkbox" —
//     row 51099bdd corrected this bullet: there is no
//     `@media (min-width: 641px)` override anywhere in the source
//     (`grep -rn "641" src/` matches only prose), and desktop is unaffected
//     by ABSENCE rather than by an explicit override — `.axes` is
//     `display: flex` in its base rule and only ever collapsed inside the
//     narrow-width block, so a viewport that never matches that query has
//     no narrower rule to override. The mutation above (adding a
//     `display: none` to the base rule instead) is the one that actually
//     exercises this test.
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

/**
 * The concatenated bodies of every block whose prelude is EXACTLY
 * `@media (max-width: 640px)` — not merely starts with that string.
 *
 * A plain `CODE.slice(CODE.indexOf("@media (max-width: 640px)"))` finds a
 * block by substring PREFIX. Mutation-verified: narrowing the prelude to
 * `@media (max-width: 640px) and (min-width: 500px)` — inert below 500px,
 * excluding 320/360/390, the exact widths this row's fix was measured at
 * — still matches `indexOf`, so the block is found and everything inside
 * it asserts as if it were unconditional. This walks brace depth to each
 * block's own closing brace (same shape as `board-list-view-density.test.ts`'s
 * `atRuleBlock`) and requires the header immediately followed by `{`
 * (allowing only whitespace between), which an `and (...)` prelude cannot
 * satisfy. Two blocks share this exact prelude in this file (see the
 * touch-target sweep further down), so this concatenates rather than
 * asserting exactly one, unlike `standup-touch-targets.test.ts`'s
 * single-block version.
 */
function narrowBlock(): string {
  const header = "@media (max-width: 640px)";
  let out = "";
  let index = 0;
  let found = 0;
  while (true) {
    const start = CODE.indexOf(header, index);
    if (start === -1) break;
    const afterHeader = CODE.slice(start + header.length).match(/^\s*\{/);
    if (!afterHeader) {
      // Prefix match only (e.g. `and (min-width: ...)` before the brace) —
      // not a real occurrence of this exact block. Skip past it and keep
      // looking, rather than silently reading it as the block.
      index = start + header.length;
      continue;
    }
    found += 1;
    const open = start + header.length + afterHeader[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < CODE.length; i += 1) {
      if (CODE[i] === "{") depth += 1;
      if (CODE[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out += CODE.slice(open + 1, i) + "\n";
    index = i + 1;
  }
  expect(found, `no exact \`${header}\` block`).toBeGreaterThan(0);
  return out;
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

  it("hides .axesToggle only with a visually-hidden technique that keeps it in the tab order", () => {
    // Pins the property that matters — hidden by a technique that does NOT
    // remove the element from the tab order — rather than one specific
    // spelling of it. `position: absolute` + a 1px box + either
    // `clip: rect(0,0,0,0)` (the legacy spelling) or a `clip-path` that
    // clips the box to nothing (the modern, widely-recommended
    // replacement — `clip` itself is deprecated) both achieve this: the
    // element is still laid out and still tabbable. Losing `position`
    // or having neither clip mechanism weakens the guarantee even though
    // neither alone is "display:none".
    //
    // Row 51099bdd: pinning the exact `clip: rect(0, 0, 0, 0)` spelling
    // made this test a false positive against `clip-path: inset(50%)` —
    // mutation-verified, that substitution used to fail this test despite
    // being a strict improvement (same visual-hiding guarantee, modern
    // property). display:none/visibility:hidden stay hard prohibitions
    // above; this test only widens which HIDING TECHNIQUE is accepted.
    const bodies = rulesFor(".axesToggle");
    const base = bodies[0]!;
    expect(has(base, "position", "absolute")).toBe(true);
    const clip = has(base, "clip", "rect(0, 0, 0, 0)");
    const clipPath = base
      .split(";")
      .some((part) => part.trim().startsWith("clip-path:") && part.includes("inset("));
    expect(
      clip || clipPath,
      ".axesToggle declares neither `clip: rect(0, 0, 0, 0)` nor a `clip-path: inset(...)`",
    ).toBe(true);
  });
});

describe("the sibling-selector reveal that the toggle's reachability exists to serve", () => {
  it("shows .axes once the toggle is checked, below 641px", () => {
    // Without this, the checkbox could be perfectly reachable and still do
    // nothing — reachability alone is not the contract, reachability THAT
    // WORKS is.
    const narrow = narrowBlock();
    expect(narrow).toMatch(/\.axesToggle:checked\s*~\s*\.axes\s*\{[^}]*display:\s*flex/);
  });

  it("collapses .axes by default below 641px, so there is something to reveal", () => {
    const narrow = narrowBlock();
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
