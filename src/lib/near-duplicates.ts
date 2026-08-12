// Near-duplicate area surfacing (SCHEMA.md §23.1, DECISIONS.md §13g/§14.6).
//
// `normalizeAreaKey` (areas.ts) already collapses case and separator
// variants onto one id, so "Web", "web", "  web " and "web_site"-style
// separator noise around the SAME word can never produce two rows in the
// first place — there is nothing left for this module to catch there.
// What normalisation explicitly does NOT catch — and what DECISIONS.md
// §13g states as the honest, accepted limit — is a genuine SYNONYM or
// near-miss spelling: "web" and "website" are different words and stay
// different ids.
//
// This module only SURFACES candidates for a person to merge. It never
// merges automatically — DECISIONS.md §14 item 6 leaves "merged
// automatically above a threshold, or only ever surfaced" as an open
// question, and building the auto-merge half would be answering a question
// this row was not asked to close. Surfacing is the unambiguous half of
// the spec regardless of how that question resolves later.
import type { PrismaClient } from "@prisma/client";
import { listActiveAreas } from "./areas";

/** Classic Levenshtein edit distance — insert/delete/substitute, unit cost. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let previousRow = Array.from({ length: n + 1 }, (_, j) => j);

  for (let i = 1; i <= m; i++) {
    const currentRow = [i];
    for (let j = 1; j <= n; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          (previousRow[j] ?? Infinity) + 1, // deletion
          (currentRow[j - 1] ?? Infinity) + 1, // insertion
          (previousRow[j - 1] ?? Infinity) + substitutionCost, // substitution
        ),
      );
    }
    previousRow = currentRow;
  }

  // previousRow now holds the final row (length n + 1).
  return previousRow[n] ?? Math.max(m, n);
}

export interface NearDuplicatePair {
  a: { id: string; displayName: string };
  b: { id: string; displayName: string };
  distance: number;
}

/**
 * Two ids are a near-duplicate candidate when their edit distance is small
 * **relative to their length** — a fixed absolute distance would flag
 * short, legitimately-different areas ("db" vs "cd", distance 2 on strings
 * of length 2) while missing real near-misses on long ones. The threshold
 * is edit distance <= 20% of the longer id's length, floored at 1 character
 * so two single-edit-apart short ids ("api" / "apis") still get caught, and
 * an identical pair (distance 0) is excluded — that is not a near-duplicate,
 * it is the same id and cannot occur here since ids are a primary key.
 */
const MAX_DISTANCE_RATIO = 0.2;

export function isNearDuplicate(idA: string, idB: string): boolean {
  if (idA === idB) return false;
  const distance = levenshtein(idA, idB);
  if (distance === 0) return false;
  const longer = Math.max(idA.length, idB.length);
  const threshold = Math.max(1, Math.floor(longer * MAX_DISTANCE_RATIO));
  return distance <= threshold;
}

/**
 * Scans all active areas and returns pairs whose ids are near-duplicates.
 * O(n^2) over active areas — deliberately: this is an admin-surfaced report
 * run on demand (or on a low-frequency schedule), not a per-write check, and
 * the area count in a single installation is expected to stay in the tens
 * to low hundreds, not a scale where quadratic comparison matters.
 */
export async function findNearDuplicateAreas(
  client: Pick<PrismaClient, "area">,
): Promise<NearDuplicatePair[]> {
  const areas = await listActiveAreas(client);
  const pairs: NearDuplicatePair[] = [];

  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const a = areas[i];
      const b = areas[j];
      if (!a || !b) continue;
      if (isNearDuplicate(a.id, b.id)) {
        pairs.push({ a, b, distance: levenshtein(a.id, b.id) });
      }
    }
  }

  return pairs;
}
