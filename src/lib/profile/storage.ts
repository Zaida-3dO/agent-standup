// Where the chosen profile lives in the browser. SCHEMA.md §8a: "Netflix-
// style profile picker on first load; the choice lives in the browser and
// is changed from an icon in the top bar." A plain localStorage key, not a
// cookie: nothing here is ever read server-side (SCHEMA.md §8a again —
// "this is a claim, not a credential", enforced nowhere on the server) and
// localStorage, unlike sessionStorage, survives a full browser restart —
// which is what MILESTONES.md #35's "remembered in the browser" means.
export const PROFILE_STORAGE_KEY = "agent-standup:active-profile-id";

/**
 * The slice of the Web Storage API this module needs. Shaped to match
 * `window.localStorage` so the real thing satisfies it with no adapter,
 * declared locally rather than borrowed from `lib.dom` so a test can pass a
 * plain in-memory object without a DOM — this repo's test harness runs
 * `environment: "node"` (`vitest.config.ts`), not jsdom.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `window.localStorage` when it exists, `undefined` during server rendering. */
function browserStorage(): KeyValueStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

/**
 * The remembered profile id, or `null` when nothing is stored, storage
 * isn't available (server rendering), or the stored value is blank.
 *
 * `storage` defaults to the real browser storage — tests inject a fake one
 * instead of reaching for a DOM.
 */
export function readStoredProfileId(
  storage: KeyValueStorage | undefined = browserStorage(),
): string | null {
  if (!storage) return null;
  const value = storage.getItem(PROFILE_STORAGE_KEY);
  // An empty string is never a real person id (every seeded or created one
  // is non-empty) — treat it the same as "nothing stored" rather than
  // handing a caller a blank id to match against real profiles.
  return value === null || value === "" ? null : value;
}

/** Remembers `id` as the active profile. */
export function writeStoredProfileId(
  id: string,
  storage: KeyValueStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  storage.setItem(PROFILE_STORAGE_KEY, id);
}

/** Forgets the remembered profile, if any. */
export function clearStoredProfileId(
  storage: KeyValueStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  storage.removeItem(PROFILE_STORAGE_KEY);
}
