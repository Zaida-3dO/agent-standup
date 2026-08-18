// Display density — how much air the app leaves around a row.
//
// **Spacing and line-height only. Never font size.** The type scale
// (`globals.css` §8) is seven steps chosen against each other; shrinking
// the text to fit more rows in would not compact the layout so much as
// replace the scale with a second, unstated one, and every contrast and
// legibility judgement made against the first would quietly stop holding.
// Compacting the space *between* things changes density without touching
// what anything says.
//
// The mode is a class on `<html>` — the same mechanism `dark`/`light`
// already uses — so a component never asks which density is active and no
// component needs to re-render when it changes. `globals.css` re-points the
// spacing tokens under `.density-compact` and everything downstream
// follows.

/** The two densities. Closed, because the class name is derived from this and a typo would silently apply neither. */
export const DENSITIES = ["comfortable", "compact"] as const;

export type Density = (typeof DENSITIES)[number];

/**
 * The default when nothing is stored.
 *
 * Comfortable, deliberately: a first-run reader has not asked for anything,
 * and the denser layout is the one that assumes you already know what you
 * are looking at. Compact is an earned preference, not an opening offer.
 */
export const DEFAULT_DENSITY: Density = "comfortable";

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

/** The `<html>` class for a density. Comfortable is the token set's own baseline, so it carries no class. */
export function densityClass(density: Density): string {
  return density === "compact" ? "density-compact" : "";
}

export const DENSITY_STORAGE_KEY = "agent-standup.density";

/**
 * Reads the stored density.
 *
 * Every failure — no storage (server render), nothing stored, or a stored
 * value that is not one of the two — resolves to the default rather than
 * throwing. A preference is not worth a blank page, and `localStorage`
 * genuinely throws rather than returning null in a browser with site data
 * blocked, so the `try` is load-bearing and not defensive decoration.
 */
export function readStoredDensity(storage?: Storage): Density {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    if (store === null) return DEFAULT_DENSITY;
    const raw = store.getItem(DENSITY_STORAGE_KEY);
    return isDensity(raw) ? raw : DEFAULT_DENSITY;
  } catch {
    return DEFAULT_DENSITY;
  }
}

/** Persists the density. Silently does nothing when storage is unavailable — see `readStoredDensity`. */
export function writeStoredDensity(density: Density, storage?: Storage): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    if (store === null) return;
    store.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // Storage unavailable. The preference does not survive the reload; the
    // app does, which is the trade worth making.
  }
}

/**
 * The script run before first paint to apply the stored density.
 *
 * Inlined into the document head rather than applied from an effect,
 * because an effect runs after the first paint: the page would render
 * comfortable and then visibly reflow to compact on every single load for
 * anyone who chose compact. This is the same reason a theme script is
 * inlined, and it is why this returns a string of source rather than being
 * a function someone calls.
 *
 * Written to fail silently and completely: if anything in it throws, the
 * document keeps the default density and nothing else is affected.
 */
export function densityBootScript(): string {
  return `try{var d=localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});if(d===${JSON.stringify("compact")})document.documentElement.classList.add(${JSON.stringify("density-compact")})}catch(e){}`;
}
