// oklch → sRGB → WCAG contrast ratio.
//
// This exists so the accessibility claim in `globals.css` is a COMPUTED
// fact rather than an assertion. "Every state passes 4.5:1" is the kind of
// sentence that is true when written, false three commits later, and never
// checked again — unless something recomputes it. `tests/design-tokens-contrast.test.ts`
// does, from the declarations in the stylesheet itself.
//
// Written by hand rather than pulled in as a dependency: it is ~60 lines of
// published, fixed matrices, and a colour-maths package would be a supply
// chain risk and a version to track for something that cannot change. The
// transforms are the standard ones — Oklab's inverse (Björn Ottosson),
// then the linear-sRGB matrix, then WCAG 2.1's relative luminance.
//
// ── One honest limitation, stated up front ────────────────────────────
//
// WCAG 2.1 contrast ratio is a poor model of perceived contrast on dark
// backgrounds — it systematically overstates it, which is why APCA exists.
// The numbers here are computed correctly against the normative standard;
// they are not a claim that the standard models perception well. Where a
// value sits close to a threshold it has been pushed up rather than left
// at the line, so the margin absorbs the model's error.

/** A colour in linear-light sRGB, each channel unclamped in [0,1]-ish. */
interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Oklch → linear sRGB.
 *
 * `l` is perceptual lightness in [0,1], `c` chroma (0 is grey), `h` hue in
 * degrees. Chroma and hue are polar coordinates over Oklab's a/b axes, so
 * the first step is simply back to Cartesian.
 */
export function oklchToLinearRgb(l: number, c: number, hDeg: number): LinearRgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  // Oklab → LMS (cube-rooted cone responses).
  const lRoot = l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = l - 0.0894841775 * a - 1.291485548 * b;

  const lms = lRoot * lRoot * lRoot;
  const mms = mRoot * mRoot * mRoot;
  const sms = sRoot * sRoot * sRoot;

  // LMS → linear sRGB.
  return {
    r: 4.0767416621 * lms - 3.3077115913 * mms + 0.2309699292 * sms,
    g: -1.2684380046 * lms + 2.6097574011 * mms - 0.3413193965 * sms,
    b: -0.0041960863 * lms - 0.7034186147 * mms + 1.707614701 * sms,
  };
}

/**
 * WCAG 2.1 relative luminance.
 *
 * Channels are CLAMPED to [0,1] first. That matters and is not a rounding
 * nicety: a wide-gamut oklch value can sit outside the sRGB cube and yield
 * a negative channel, which would make the luminance — and therefore the
 * contrast ratio — a number no display can produce. Clamping models what a
 * browser actually paints when it gamut-maps, so the ratio computed here is
 * the ratio a reader experiences. (It is a simplification: browsers do a
 * smarter chroma-reducing map than a per-channel clip. It errs toward
 * reporting LESS contrast for out-of-gamut colours, which is the safe
 * direction for a check.)
 *
 * The linear-light values need no further transfer function — WCAG's
 * formula is defined on linearised channels, which is what we already have.
 */
export function relativeLuminance({ r, g, b }: LinearRgb): number {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

/**
 * The WCAG contrast ratio between two colours, each given as oklch.
 *
 * Returns a number in [1, 21]. Symmetric by construction — the brighter of
 * the two always goes on top — so a caller never has to remember which
 * argument is the foreground.
 */
export function contrastRatio(
  fg: readonly [number, number, number],
  bg: readonly [number, number, number],
): number {
  const lumFg = relativeLuminance(oklchToLinearRgb(fg[0], fg[1], fg[2]));
  const lumBg = relativeLuminance(oklchToLinearRgb(bg[0], bg[1], bg[2]));
  const lighter = Math.max(lumFg, lumBg);
  const darker = Math.min(lumFg, lumBg);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for normal-size text. */
export const AA_TEXT = 4.5;

/** WCAG AA for a UI component boundary or graphical object (1.4.11). */
export const AA_UI = 3;
