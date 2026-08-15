// An item's areas — resolving a list of them, and writing both
// representations (SCHEMA.md §23.1).
//
// **An item may sit in several areas.** A change that is both "web" and
// "infra" is genuinely both, and forcing a choice files it where half the
// people looking for it will not look. Most items carry one, which is why
// the singular spelling stays the easy one at every call site.
//
// **Areas are still auto-created on first use.** §23.1 makes that the
// deliberate posture for areas specifically — unlike repos — because an area
// is required on every item, "including research and non-code work; blocking
// that is friction on the most common operation in the system". So this
// module resolves through `ensureAreaRaw` (./ensure-area-raw.ts) rather than
// carrying a lookup of its own: one normalise-and-create rule, one
// implementation, and a second area named in the same call behaves exactly
// like the first.
import type { ServiceContext } from "../context";
import { GuardRejectedError } from "../errors";
import { ensureAreaRaw } from "./ensure-area-raw";

/**
 * Resolves a list of raw area labels to normalised ids, in order, with
 * duplicates removed.
 *
 * **Order is meaningful and preserved: the first entry becomes the item's
 * primary area** (`Item.area`). De-duplication is by normalised id, so
 * `["Web", "web"]` is one area rather than a spurious second link — the same
 * normalisation that makes the vocabulary usable by hand has to apply within
 * a single call too, or a caller can create a row pair the unique index
 * would have refused.
 *
 * An empty list is refused rather than defaulted. Every item must have an
 * area (§1), and there is no sensible area to invent for a caller that named
 * none — a default here would file items somewhere nobody chose.
 */
export async function resolveAreasRaw(
  ctx: ServiceContext,
  rawNames: readonly string[],
): Promise<string[]> {
  if (rawNames.length === 0) {
    throw new GuardRejectedError("items.area.required", "at least one area is required", {
      fields: ["areas"],
    });
  }
  const resolved: string[] = [];
  for (const raw of rawNames) {
    const id = await ensureAreaRaw(ctx, raw);
    if (!resolved.includes(id)) {
      resolved.push(id);
    }
  }
  return resolved;
}

/**
 * Writes an item's area set as exactly `areaIds` (already resolved).
 *
 * The **one function** both representations are written through: the primary
 * area is `areaIds[0]` by definition, and it is set in the same statement
 * sequence, inside the caller's single transaction. Every caller reaches
 * `Item.area` and `ItemArea` through this one place, so the two
 * representations have no way to drift apart *from each other* — but this
 * function is not the only place `Item.area` itself gets written. Two
 * callers set that column directly, in a raw `INSERT`, before a row (and
 * therefore an id `setItemAreas` could target) exists yet:
 * `resolveInboxProject` (`./inbox-project.ts`) calls `setItemAreas` itself,
 * immediately afterward, in the same transaction; the item importer
 * (`@/lib/import-items.ts`) cannot import this module (it is a narrow
 * Prisma-client-shaped importer that also runs as a standalone script, with
 * no `ServiceContext` to hand this function) and instead runs the equivalent
 * single-row `INSERT INTO "ItemArea"` inline, same transaction, same effect.
 * So the invariant that holds is narrower than "nothing else writes
 * `Item.area`": it is "every write to `Item.area` is followed, same
 * transaction, by a write that makes `ItemArea` agree with it."
 *
 * Delete-then-insert rather than a diff: an area set is a handful of rows
 * that arrives whole, and computing the difference would be more code for
 * the same result plus a second way for the two representations to disagree.
 */
export async function setItemAreas(
  ctx: ServiceContext,
  itemId: string,
  areaIds: readonly string[],
): Promise<void> {
  const primary = areaIds[0];
  if (primary === undefined) {
    throw new GuardRejectedError("items.area.required", "at least one area is required", {
      fields: ["areas"],
    });
  }
  await ctx.db.$executeRawUnsafe(`DELETE FROM "ItemArea" WHERE "itemId" = $1`, itemId);
  for (const areaId of areaIds) {
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      itemId,
      areaId,
    );
  }
  await ctx.db.$executeRawUnsafe(`UPDATE "Item" SET "area" = $2 WHERE "id" = $1`, itemId, primary);
}
