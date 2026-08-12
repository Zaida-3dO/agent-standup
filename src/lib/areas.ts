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
 * Atomic under concurrent callers: `INSERT ... ON CONFLICT (id) DO NOTHING`
 * is a single statement Postgres itself serialises against the unique index
 * on `id`, so two requests racing to create "web" for the first time can
 * never both succeed at creating a row — one insert wins, the other becomes
 * a no-op, and both callers then read back the same, single row. This is
 * deliberately NOT `prisma.area.upsert`: Prisma's upsert is a find followed
 * by a create, two separate round-trips with no atomicity between them, so
 * two concurrent first-use calls can both miss the find and both attempt
 * the create — one then throws a unique-constraint violation instead of
 * resolving to the winner's row.
 */
export async function ensureArea(
  client: Pick<PrismaClient, "area" | "$executeRaw" | "$queryRaw">,
  rawName: string,
): Promise<{ id: string; displayName: string }> {
  const id = normalizeAreaKey(rawName);
  if (id === "") {
    throw new InvalidAreaNameError(rawName);
  }

  const displayName = rawName.trim();

  // ON CONFLICT DO NOTHING means this statement never touches an existing
  // row's displayName, enforced by Postgres itself: on conflict there is no
  // UPDATE clause at all, so a losing writer's spelling can never overwrite
  // the row that's already on record.
  await client.$executeRaw`
    INSERT INTO "Area" ("id", "displayName")
    VALUES (${id}, ${displayName})
    ON CONFLICT ("id") DO NOTHING
  `;

  // Whichever caller's insert actually landed, every caller reads back the
  // same committed row here — the id is unique, so this always finds
  // exactly the row the race resolved to, never a "half-created" state.
  const rows = await client.$queryRaw<
    Array<{ id: string; displayName: string }>
  >`SELECT "id", "displayName" FROM "Area" WHERE "id" = ${id}`;
  const area = rows[0];
  if (!area) {
    // Should be unreachable: we just inserted-or-confirmed this row inside
    // the same client/transaction. Fail loudly rather than return undefined.
    throw new Error(`ensureArea: no Area row found for id ${JSON.stringify(id)} after insert`);
  }

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
