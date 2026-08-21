// The browser-storage half of the "More filters" picker — the only module
// here that touches `localStorage`.
//
// Split from `visible-filters.ts` for the reason every `@/lib/board` module
// is split: the decisions are pure and provable in a DOM-free harness, and
// the one impure edge is small enough to read in full.
//
// **Every read is guarded, and not only against the server.** `localStorage`
// is absent during SSR, but it also *throws on access* in a browser with
// site data blocked, and its contents are attacker-editable in the sense
// that matters here — a reader can type anything into it. So a read has
// three failure modes and all three resolve to the same thing: the default
// set. A picker preference that cannot be loaded is not an error state, it
// is a reader who has not chosen.

import type { BoardFilters } from "./filters";
import {
  DEFAULT_VISIBLE_FILTERS,
  normaliseVisibleFilters,
  type VisibleFilters,
} from "./visible-filters";

// `BoardFilters` is imported for the key type the stored list is made of —
// the storage layer never reads a filter VALUE, which is the whole point of
// the split this module sits on one side of.

/**
 * The key the preference is stored under.
 *
 * Namespaced, because `localStorage` is one flat map shared by everything
 * served from this origin.
 */
export const VISIBLE_FILTERS_STORAGE_KEY = "agent-standup.board.visible-filters";

/**
 * A minimal `localStorage` — what this module actually needs, so a test can
 * pass a plain object and the real thing satisfies it structurally.
 */
export interface VisibleFiltersStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The browser's storage, or `null` where there is none.
 *
 * `try`/`catch` rather than a `typeof window` test alone: a browser with
 * cookies-and-site-data blocked has a `window` and throws on the property
 * access itself, which a presence check does not catch.
 */
export function browserStorage(): VisibleFiltersStorage | null {
  try {
    if (typeof globalThis.localStorage === "undefined") return null;
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the stored preference, resolving anything unusable to the default.
 *
 * Unusable covers: no storage, key never set, invalid JSON, JSON that is not
 * an array of strings, and an array whose entries name no axis this build
 * has. The last one is why `normaliseVisibleFilters` runs over the parsed
 * value rather than it being trusted — a preference written by an older
 * build naming a since-removed axis keeps the axes that still exist.
 *
 * An empty stored array is honoured as an empty set, NOT replaced by the
 * default. A reader who unticked everything meant it, and quietly restoring
 * eight controls would be the interface disagreeing with them.
 */
export function readVisibleFilters(
  storage: VisibleFiltersStorage | null = browserStorage(),
): VisibleFilters {
  if (storage === null) return DEFAULT_VISIBLE_FILTERS;
  let raw: string | null;
  try {
    raw = storage.getItem(VISIBLE_FILTERS_STORAGE_KEY);
  } catch {
    return DEFAULT_VISIBLE_FILTERS;
  }
  if (raw === null) return DEFAULT_VISIBLE_FILTERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_VISIBLE_FILTERS;
    if (!parsed.every((entry): entry is string => typeof entry === "string")) {
      return DEFAULT_VISIBLE_FILTERS;
    }
    return normaliseVisibleFilters(parsed as readonly (keyof BoardFilters)[]);
  } catch {
    return DEFAULT_VISIBLE_FILTERS;
  }
}

/**
 * Writes the preference, doing nothing where there is no storage.
 *
 * A failed write is swallowed on purpose. The alternative is an error
 * surfaced on the board because a display preference could not be
 * remembered, which is louder than the thing it is reporting — the picker
 * still works for this session either way, because the state it renders from
 * is React's, not storage's.
 */
export function writeVisibleFilters(
  visible: VisibleFilters,
  storage: VisibleFiltersStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(VISIBLE_FILTERS_STORAGE_KEY, JSON.stringify(normaliseVisibleFilters(visible)));
  } catch {
    // See above — a preference that could not be saved is not board news.
  }
}

// ── The store, as React consumes it ────────────────────────────────────
//
// `useSyncExternalStore` rather than `useState` + an effect, because that is
// exactly the shape this is: an external store, read on the client, with a
// separate server snapshot. The hook takes the SSR value from
// `serverSnapshot` and the client value from `snapshot`, so the first
// server render and the first client render agree by construction rather
// than by a correction applied after mount.
//
// It also removes the cascading render an effect-then-setState would cause,
// and the window between them where the header shows the default set before
// flicking to the reader's own.

/** Listeners, so a write in one component reaches every reader of the store. */
const listeners = new Set<() => void>();

/**
 * The cached snapshot.
 *
 * `useSyncExternalStore` compares snapshots by reference and re-renders
 * whenever one differs, so `getSnapshot` MUST return the same array until
 * something actually changes — parsing storage afresh on every call would
 * return a new array each time and loop forever.
 */
let cached: VisibleFilters | null = null;

/** The value React reads on the client. */
export function visibleFiltersSnapshot(): VisibleFilters {
  cached ??= readVisibleFilters();
  return cached;
}

/**
 * The value React reads on the SERVER, and on the first client render.
 *
 * A constant, because the server has no storage to read and a first client
 * render that disagreed with it is the hydration mismatch this whole
 * arrangement exists to avoid.
 */
export function visibleFiltersServerSnapshot(): VisibleFilters {
  return DEFAULT_VISIBLE_FILTERS;
}

/** Subscribes to changes — the first argument `useSyncExternalStore` takes. */
export function subscribeToVisibleFilters(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Sets the preference: persists it, updates the snapshot, and tells every
 * subscriber.
 *
 * The cache is replaced BEFORE the listeners run, so a component re-rendered
 * by this notification reads the new value rather than the one it just
 * replaced.
 */
export function setVisibleFilters(visible: VisibleFilters): void {
  cached = normaliseVisibleFilters(visible);
  writeVisibleFilters(cached);
  for (const listener of listeners) listener();
}

/** Drops the cached snapshot — for tests, which need each case to read storage afresh. */
export function resetVisibleFiltersCache(): void {
  cached = null;
}
