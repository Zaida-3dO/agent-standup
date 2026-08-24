// A person's colour when nobody has chosen one — T22's second half.
//
// **The same problem `area-colour.ts` already solved, so it reuses that
// solution rather than inventing a second one.** A profile created from the
// picker sends only a `displayName` (`@/lib/profile/create`), so its
// `colour` is `null` forever unless someone later visits `/admin/people`.
// That leaves the profile created through the PRIMARY flow the one that
// renders unstyled, and — without a separate selection channel — the one
// that reads as "unselected" in the picker.
//
// Hashing rather than a stored default, for exactly the reasons the area
// module gives: the same name always yields the same hue on every machine
// and every render, with no storage, no coordination and nothing to
// maintain. A fallback colour that changed between page loads would be worse
// than no colour at all, because the colour is for visual recall.
//
// ── Why this is a FALLBACK and not a write ─────────────────────────────
//
// Nothing here writes to the store. A person's stored `colour` still wins
// whenever it is set, so the admin grid remains the way to choose one and
// this never overwrites a deliberate choice. What it removes is the state
// where a person has NO colour at all — which is a rendering decision, not a
// data one, and so is made at render time.
//
// That also means it is retroactive: the two profiles that already exist
// with `colour: null` get a stable colour without a migration or a backfill.
//
// ── Why it reuses the area hues ────────────────────────────────────────
//
// The twelve `--area-hue-*` custom properties are already defined, already
// contrast-checked against the app's surfaces in both themes, and already
// chosen to be tellable apart at small sizes. A second parallel palette for
// people would be twelve more tokens to keep in step with the first set
// through every theme change, to no visible benefit — a person and an area
// are never adjacent in the same list, so a shared hue between them cannot
// be misread as a relationship.
//
// Collisions between two PEOPLE are accepted on the same terms the area
// module accepts them: every tile carries the person's name as text, so the
// colour is a recognition aid beside that label and never a substitute for
// it. And critically, the colour carries identity alone and never
// *selection*, so two people sharing a hue cannot make either look active.
//
// Pure and DOM-free, like every other module under `@/lib/design`.
import { areaHueIndex, AREA_HUE_COUNT } from "./area-colour";

export { AREA_HUE_COUNT as PERSON_HUE_COUNT };

/**
 * The hue bucket (0–11) for a person.
 *
 * Keyed on the **id**, not the display name. A person can be renamed — the
 * admin grid offers exactly that — and a colour that moved when someone
 * fixed a typo in their own name would break the recall the colour exists
 * for. The id never changes, so the colour never does.
 *
 * Delegates to `areaHueIndex` rather than re-deriving FNV-1a, so there is
 * one hash in the tree and one place its stability is proven.
 */
export function personHueIndex(personId: string): number {
  return areaHueIndex(personId);
}

/**
 * The colour to paint a person with: their stored one when they have one,
 * otherwise a stable hue derived from their id.
 *
 * Returns a CSS colour value ready to assign. The derived form is an
 * `oklch()` built from the same `--area-*` custom properties an area chip
 * uses, so it shifts with the theme instead of being a hard-coded hex that
 * is only legible in one of them — which is what a stored `#d94f8a` is, and
 * is a separate (smaller) problem this does not try to fix.
 *
 * **An empty or whitespace-only stored colour counts as unset.** A blank
 * string in a `colour` column is what an admin form submits when the field
 * is cleared, and assigning it to `borderColor` yields no colour at all —
 * so treating it as "set" would reintroduce the invisible-profile case
 * through the back door.
 */
export function personColour(person: {
  readonly id: string;
  readonly colour?: string | null;
}): string {
  const stored = person.colour;
  if (typeof stored === "string" && stored.trim() !== "") return stored;
  return `oklch(var(--area-border-l) var(--area-border-c) var(--area-hue-${personHueIndex(person.id)}))`;
}

/**
 * Twelve hex swatches, one per hue bucket, for the value **stored** on a
 * newly created person.
 *
 * ── Why a hex literal and not the `oklch(var(…))` string above ─────────
 *
 * They answer different questions and must not be conflated. `personColour`
 * decides what to PAINT right now, and a theme-reactive `var()` is exactly
 * right for that — it follows the light/dark switch. A stored `colour` is
 * DATA: it is served by `GET /api/people` to anything that asks, it is shown
 * and edited in the admin grid, and it may be read by surfaces that have no
 * access to this app's custom properties at all. Writing `oklch(var(--…))`
 * into a database column would produce a value that renders as nothing
 * outside a page that happens to define those properties, and that a colour
 * input cannot display — a string that only works in one context, stored in
 * the one place whose whole job is to be context-free.
 *
 * So the stored form is a plain hex, matching what the admin grid already
 * writes (`#d94f8a`). These are the twelve `--area-hue-*` bases resolved to
 * sRGB at the border lightness/chroma, so a created profile's stored colour
 * and its derived fallback are the same colour rather than two that differ
 * on first paint and then again after a theme change.
 */
const PERSON_SWATCHES = [
  "#9b5f5a",
  "#966543",
  "#876e37",
  "#70773e",
  "#537e54",
  "#36816f",
  "#2a7f88",
  "#3e799a",
  "#5b71a1",
  "#75689c",
  "#89618b",
  "#975d74",
] as const;

/**
 * The hex colour to STORE for a newly created person.
 *
 * Called by the picker's create path so a profile minted through the primary
 * flow arrives with a colour, rather than being `null` permanently unless
 * someone later thinks to visit the admin grid. Deterministic in the id, so
 * it agrees with `personColour`'s fallback for that same person.
 */
export function personSwatch(personId: string): string {
  return PERSON_SWATCHES[personHueIndex(personId)]!;
}
