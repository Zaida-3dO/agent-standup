// An area's colour, derived from its name.
//
// Areas are minted by agents at will — there is no fixed vocabulary and no
// admin screen that bounds one — so a hand-maintained `area → colour` map
// would be correct on the day it was written and wrong by the next mint,
// silently: the new area would fall through to a default and share a colour
// with everything else nobody had got round to adding.
//
// Hashing removes the maintenance entirely. The same name always yields the
// same hue, on every machine and every render, with no storage and no
// coordination — which is exactly the property a colour used for *visual
// recall across sessions* needs. A colour that changed between page loads
// would be worse than no colour at all.
//
// ── Why twelve hues, and why collisions are fine ──────────────────────
//
// Twelve is roughly where adjacent hues stop being reliably tellable apart
// at chip size. Going to twenty-four would halve the collision rate and
// destroy the thing the colour is for, because two areas 15° apart read as
// the same colour and the reader now believes a distinction that is not
// visible. So collisions are ACCEPTED and designed for: the chip always
// carries the area's name as text, and the colour is a recognition aid
// beside that label, never a substitute for it. Two areas sharing a hue is
// a mild loss; two areas being indistinguishable-but-different is a lie.
//
// ── Why FNV-1a ────────────────────────────────────────────────────────
//
// It needs to be stable, cheap, and well-distributed over short ASCII
// strings — not cryptographic. FNV-1a is all three and is about six lines,
// so there is no dependency and nothing to go stale. `Math.imul` keeps the
// multiply in 32-bit integer space; without it the intermediate exceeds
// 2^53 and the low bits — the ones the modulo reads — are silently lost to
// float rounding, which would make the hash's distribution depend on
// arithmetic error rather than on the input.

/** How many distinct hues an area name can map to. See the header. */
export const AREA_HUE_COUNT = 12;

/**
 * FNV-1a, 32-bit, unsigned.
 *
 * Exported because the contrast and distribution tests assert on it
 * directly — a bucket function whose only observable behaviour is "some
 * colour appeared" is one nothing can prove is stable.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // The FNV-32 prime, 16777619.
    hash = Math.imul(hash, 0x01000193);
  }
  // `>>> 0` reinterprets the sign bit as magnitude, so the result is in
  // [0, 2^32) rather than [-2^31, 2^31) — the modulo below needs a
  // non-negative input or it yields a negative bucket.
  return hash >>> 0;
}

/**
 * The hue bucket (0–11) for an area name.
 *
 * Normalised to lower case first, so `Web` and `web` are one area's colour
 * rather than two: area names arrive from several writers (the MCP surface,
 * the CLI, the import) and casing is exactly the kind of thing that differs
 * between them without meaning anything.
 */
export function areaHueIndex(area: string): number {
  return fnv1a(area.trim().toLowerCase()) % AREA_HUE_COUNT;
}

/** The three CSS custom properties an area chip is painted from. */
export interface AreaColour {
  /** Text and icon — reads against `--surface-card`. */
  readonly fg: string;
  /** A filled chip's background. */
  readonly bg: string;
  /** A chip outline. */
  readonly border: string;
}

/**
 * The `oklch()` triplet for an area, as CSS values ready to assign.
 *
 * Lightness and chroma come from the token layer (`--area-fg-l` and
 * friends) rather than being written here, so the light theme can shift the
 * whole set by re-declaring four custom properties — which is the only way
 * this stays one source of truth rather than two that must agree. Only the
 * hue is computed, because the hue is the only thing the name encodes.
 */
export function areaColour(area: string): AreaColour {
  const hue = `var(--area-hue-${areaHueIndex(area)})`;
  return {
    fg: `oklch(var(--area-fg-l) var(--area-fg-c) ${hue})`,
    bg: `oklch(var(--area-bg-l) var(--area-bg-c) ${hue})`,
    border: `oklch(var(--area-border-l) var(--area-border-c) ${hue})`,
  };
}
