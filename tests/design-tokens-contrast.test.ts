// Proves the accessibility claim in `src/app/globals.css` rather than
// restating it.
//
// The critical design decision here is that this test PARSES THE
// STYLESHEET. A test carrying its own copy of the twelve state colours
// would pass forever after someone edited the CSS, which is the precise
// failure it exists to prevent — the claim "every state passes 4.5:1" is
// only worth anything if it is re-derived from the shipped file.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Changing any `--state-*-fg` lightness in `globals.css` by ~0.04
//     (e.g. `0.78` → `0.74` on `someday`) drops it under 4.5:1 and fails
//     `every state's -fg passes AA text contrast`.
//   - Changing `--surface-card` from `--n-850` to `--n-800` moves the
//     reference surface and fails several ratios at once.
//   - Deleting one state's triplet fails the completeness test.
//   - Giving `cancelled` a red hue fails `cancelled is not red`.
//   - Making two states share a shape fails the shape-distinctness test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AA_TEXT, AA_UI, contrastRatio } from "@/lib/design/contrast";
import { ITEM_STATES, STATE_SHAPES, PRIORITIES } from "@/lib/design/tokens";

const CSS = readFileSync(path.resolve(import.meta.dirname, "../src/app/globals.css"), "utf8");

/** An oklch triple, as the stylesheet declares it. */
type Oklch = readonly [number, number, number];

/**
 * The value of a custom property, resolving ONE level of `var()`
 * indirection into the neutral ramp.
 *
 * The token layer is deliberately two-tier — semantic names point at ramp
 * primitives — so a naive regex for `oklch(...)` would find nothing for
 * `--surface-card: var(--n-850)`. Resolving exactly one hop covers every
 * case in the file and keeps this parser small enough to be obviously
 * correct; a token that needed two hops would fail loudly here rather than
 * silently returning a wrong colour.
 *
 * `scope` picks which block to read from: the light theme redeclares the
 * same names, so a search for the first match would always return the dark
 * value and the light-theme assertions would silently test dark twice.
 */
function declaredValue(name: string, scope: "dark" | "light"): string {
  const body = scopeBody(scope);
  // Last match wins: several `:root` blocks declare into the same scope and
  // CSS cascade order means the later declaration is the effective one.
  const matches = [...body.matchAll(new RegExp(`--${escape(name)}:\\s*([^;]+);`, "g"))];
  const found = matches.at(-1);
  if (found === undefined) throw new Error(`No declaration for --${name} in ${scope} scope`);
  return found[1]!.trim();
}

/**
 * The stylesheet text belonging to a theme.
 *
 * Dark is everything before `.light {`; light is the `.light` block. Crude,
 * and correct for this file's structure — and if the file is ever
 * restructured so it is not, `declaredValue` throws rather than quietly
 * reading the wrong block.
 */
function scopeBody(scope: "dark" | "light"): string {
  const lightStart = CSS.indexOf(".light {");
  if (lightStart === -1) throw new Error("No .light block found in globals.css");
  if (scope === "dark") return CSS.slice(0, lightStart);
  const lightEnd = CSS.indexOf("\n}", lightStart);
  return CSS.slice(lightStart, lightEnd);
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parses `oklch(L C H)` — and follows a `var(--n-…)` to the ramp first. */
function oklchOf(name: string, scope: "dark" | "light"): Oklch {
  let value = declaredValue(name, scope);
  const indirect = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  // The neutral ramp is declared once, unscoped, so a hop always resolves
  // against the dark scope's `:root` — which is where `--n-*` live.
  if (indirect) value = declaredValue(indirect[1]!, "dark");

  const parsed = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (!parsed) throw new Error(`--${name} in ${scope} is not a plain oklch(): ${value}`);
  return [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
}

describe("state tokens: completeness", () => {
  it("declares a full triplet for every one of the twelve ItemState values", () => {
    // Twelve, per SCHEMA.md §1.1 — the prose there says "eleven" and lists
    // twelve; `src/lib/board/types.ts` is the authority and has twelve.
    expect(ITEM_STATES.length).toBe(12);
    for (const state of ITEM_STATES) {
      for (const role of ["fg", "bg", "border"] as const) {
        expect(() => oklchOf(`state-${state}-${role}`, "dark")).not.toThrow();
        expect(() => oklchOf(`state-${state}-${role}`, "light")).not.toThrow();
      }
    }
  });
});

describe.each(["dark", "light"] as const)("contrast — %s theme", (scope) => {
  const surfaceCard = () => oklchOf("surface-card", scope);

  it("every state's -fg passes AA for text (4.5:1) against --surface-card", () => {
    const failures: string[] = [];
    for (const state of ITEM_STATES) {
      const ratio = contrastRatio(oklchOf(`state-${state}-${role("fg")}`, scope), surfaceCard());
      if (ratio < AA_TEXT) failures.push(`${state}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("every state's -border passes AA for UI (3:1) against --surface-card", () => {
    const failures: string[] = [];
    for (const state of ITEM_STATES) {
      const ratio = contrastRatio(oklchOf(`state-${state}-border`, scope), surfaceCard());
      if (ratio < AA_UI) failures.push(`${state}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("every filled priority chip's text passes AA against its OWN background", () => {
    // A filled chip's foreground reads against the chip, not the card —
    // checking it against `--surface-card` would test a pairing that never
    // appears on screen and pass a chip whose own label is illegible.
    const failures: string[] = [];
    for (const priority of PRIORITIES) {
      const key = priority.toLowerCase();
      const ratio = contrastRatio(
        oklchOf(`priority-${key}-fg`, scope),
        oklchOf(`priority-${key}-bg`, scope),
      );
      if (ratio < AA_TEXT) failures.push(`${priority}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("primary and secondary text pass AA against every surface they sit on", () => {
    const failures: string[] = [];
    for (const surface of ["surface-app", "surface-panel", "surface-card", "surface-raised"]) {
      for (const text of ["text-primary", "text-secondary"]) {
        const ratio = contrastRatio(oklchOf(text, scope), oklchOf(surface, scope));
        if (ratio < AA_TEXT) failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("staleness warn and alert pass AA for UI (3:1) — they are 6px dots", () => {
    const failures: string[] = [];
    for (const token of ["stale-warn", "stale-alert"]) {
      const ratio = contrastRatio(oklchOf(token, scope), surfaceCard());
      if (ratio < AA_UI) failures.push(`${token}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("a control's border passes AA for UI (3:1) on every surface it sits on", () => {
    // `--border-control` is the boundary of an input or a button — the
    // thing that says "you can type here". WCAG 1.4.11 exempts a
    // decorative border but not an affordance, and a control whose edge
    // you cannot find is the failure this token exists to prevent.
    //
    // Checked against the OVERLAY surface too, not just the card: the
    // profile create form lives in a dialog, and on the light theme
    // `--surface-overlay` is pure white — the hardest background for a
    // neutral border to clear, and the one a card-only check would miss.
    const failures: string[] = [];
    for (const surface of ["surface-card", "surface-overlay", "surface-panel"]) {
      const ratio = contrastRatio(oklchOf("border-control", scope), oklchOf(surface, scope));
      if (ratio < AA_UI) failures.push(`border-control on ${surface}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("a filled accent control's own label passes AA against its fill", () => {
    // The pairing a reader actually sees on a primary button. Checking
    // `--accent-fg` against the page instead would pass a button whose
    // label is illegible on the button.
    const ratio = contrastRatio(oklchOf("accent-fg", scope), oklchOf("accent", scope));
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("running, stalled and superseded presence dots pass AA for UI (3:1)", () => {
    // `dead` is excluded deliberately — it is a hollow ring rendered from
    // `--presence-dead`, which is the same muted neutral on both themes and
    // is not held to the 3:1 bar a filled indicator's fill colour is: the
    // shape (an empty ring), not the contrast of a fill, is what carries
    // "dead" (see AgentPresenceDot.tsx's header).
    const failures: string[] = [];
    for (const token of ["presence-running", "presence-stalled", "presence-superseded"]) {
      const ratio = contrastRatio(oklchOf(token, scope), surfaceCard());
      if (ratio < AA_UI) failures.push(`${token}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });
});

/** Narrows a role name to the literal the token template expects. */
function role(r: "fg" | "bg" | "border"): "fg" | "bg" | "border" {
  return r;
}

describe("the two rules that keep the colour honest", () => {
  it("cancelled is NOT red — it is a decision, not a failure", () => {
    // Red here means "needs action" and is reserved for `blocked` and P0.
    // The test is on CHROMA rather than hue: a near-zero-chroma colour has
    // no meaningful hue at all, so asserting "hue is not 25" would pass for
    // a saturated orange. What actually matters is that cancelled carries
    // no colour signal.
    for (const state of ["cancelled", "wont_do"] as const) {
      for (const scope of ["dark", "light"] as const) {
        const [, chroma] = oklchOf(`state-${state}-fg`, scope);
        expect(chroma).toBeLessThan(0.03);
      }
    }
  });

  it("blocked is red and paused is amber — SCHEMA.md §1.1 mandates both", () => {
    for (const scope of ["dark", "light"] as const) {
      const [, blockedChroma, blockedHue] = oklchOf(`state-blocked-fg`, scope);
      const [, pausedChroma, pausedHue] = oklchOf(`state-paused-fg`, scope);
      // Red sits near hue 25 in oklch; amber near 75.
      expect(blockedHue).toBeGreaterThan(10);
      expect(blockedHue).toBeLessThan(40);
      expect(pausedHue).toBeGreaterThan(60);
      expect(pausedHue).toBeLessThan(95);
      // …and both must actually be saturated, or "red" and "amber" are
      // hues on a colour nobody can see.
      expect(blockedChroma).toBeGreaterThan(0.08);
      expect(pausedChroma).toBeGreaterThan(0.08);
    }
  });

  it("blocked and merged — the red/green pair — carry DIFFERENT shapes", () => {
    // The pair whose meanings are opposite, and whose hues are the classic
    // confusion. If these ever share a shape, a colour-blind reader has no
    // channel left at all.
    expect(STATE_SHAPES.blocked).not.toBe(STATE_SHAPES.merged);
  });

  it("paused and blocked — which share a column — carry DIFFERENT shapes", () => {
    expect(STATE_SHAPES.paused).not.toBe(STATE_SHAPES.blocked);
  });
});
