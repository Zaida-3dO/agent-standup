import type { Profile } from "./types";

/**
 * The profile a remembered id resolves to, or `null` when nothing should be
 * treated as chosen yet. Covers both cases MILESTONES.md #35 names
 * explicitly:
 *
 *   - **no profile chosen yet** — `storedId` is `null` (nothing remembered).
 *   - **unknown/stale profile** — `storedId` names a profile that no longer
 *     appears in `people` (deleted, archived, or simply never existed —
 *     e.g. a value edited by hand in devtools).
 *
 * Both read identically to a caller: show the picker rather than crash or
 * silently attribute work to a profile that isn't real.
 */
export function resolveActiveProfile(
  storedId: string | null,
  people: readonly Profile[],
): Profile | null {
  if (storedId === null) return null;
  return people.find((person) => person.id === storedId) ?? null;
}
