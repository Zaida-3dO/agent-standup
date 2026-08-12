// Areas (SCHEMA.md §23.1, DECISIONS.md §13g) — auto-created on first use,
// with normalisation, because `area` is required on every item and blocking
// the most common write in the system is friction nobody should pay.
//
// Contrast with repos.ts: there is deliberately NO "createArea" that fails
// if one already exists, and no code path that ever rejects a write for
// lacking an area. `ensureArea` is find-or-create, always.
import type { PrismaClient } from "@prisma/client";

/**
 * Normalises a raw area string into the canonical id an `Area` row is keyed
 * on: lowercase, trimmed, with runs of whitespace/hyphen/underscore/slash
 * collapsed to a single hyphen (SCHEMA.md §23.1: "lowercase, trim, collapse
 * separators"). This is deliberately a **narrow** normalisation — it kills
 * case and separator variants ("Web", "web", "  web ", "web_site" only
 * collapses internally) but not synonyms ("web" vs "website" stay distinct
 * ids). That gap is the documented, accepted limit (SCHEMA.md §23.1,
 * "honest limit") the near-duplicate surfacing in near-duplicates.ts exists
 * to catch instead of hide.
 */
export function normalizeAreaKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class InvalidAreaNameError extends Error {
  constructor(raw: string) {
    super(`area name normalises to empty: ${JSON.stringify(raw)}`);
    this.name = "InvalidAreaNameError";
  }
}

/**
 * Find-or-create by normalised id. The **display name** on first creation
 * is the trimmed raw input (case preserved) so the UI can show "Web" even
 * though the id is "web" — but the id, and only the id, is what every
 * subsequent write and filter compares against, which is the whole point.
 *
 * Idempotent under concurrent callers: two requests racing to create "web"
 * for the first time both resolve to the same row via upsert rather than
 * one throwing a unique-violation the caller has to handle.
 */
export async function ensureArea(
  client: Pick<PrismaClient, "area">,
  rawName: string,
): Promise<{ id: string; displayName: string }> {
  const id = normalizeAreaKey(rawName);
  if (id === "") {
    throw new InvalidAreaNameError(rawName);
  }

  const displayName = rawName.trim();

  const area = await client.area.upsert({
    where: { id },
    // Only the id is used to find an existing row — an area already on
    // record keeps its own display name (which may have been edited since
    // creation) rather than being silently overwritten by whatever raw
    // string this particular write happened to spell it with.
    update: {},
    create: { id, displayName },
  });

  return { id: area.id, displayName: area.displayName };
}

/** All non-archived areas, for admin listing and near-duplicate surfacing. */
export async function listActiveAreas(
  client: Pick<PrismaClient, "area">,
): Promise<Array<{ id: string; displayName: string }>> {
  return client.area.findMany({
    where: { archivedAt: null },
    select: { id: true, displayName: true },
    orderBy: { id: "asc" },
  });
}
