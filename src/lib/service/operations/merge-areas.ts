// `merge_areas` — folds one area's membership into another, MILESTONES.md
// (split from row `6b2fb637`, see this row's own header for the schema
// citations this comment does not repeat).
//
// ── Why an `UPDATE` is not this operation ─────────────────────────────────
//
// `ItemArea` carries a composite primary key `(itemId, areaId)`. An item
// already sitting in BOTH the losing and the surviving area — precisely the
// case a merge exists to resolve — collides on that key the instant a naive
// `UPDATE "ItemArea" SET "areaId" = $to WHERE "areaId" = $from` tries to
// rewrite its losing row to the surviving id: the surviving row is already
// there. Depending on the conflict clause this either raises a unique
// violation or (with `ON CONFLICT DO NOTHING`) silently drops the losing
// row's tag while leaving the item's `Item.area` column pointed at whichever
// value a naive rewrite left it holding — corruption with no error at all,
// which is the worse of the two failure shapes. See `../../errors.ts` for
// why a guard that can be bypassed by a conflict clause is not a guard.
//
// So this is a de-duplication pass, not a rewrite: for every item that holds
// the losing area, EITHER it does not yet hold the surviving one (a plain
// retag is safe) OR it already holds both (the losing membership is dropped,
// never inserted a second time). `INSERT … ON CONFLICT DO NOTHING` on the
// insert half makes the "already holds both" case inert by construction —
// there is no path through this function that can reach the primary-key
// violation the naive version hits, because nothing here ever attempts an
// insert or update that could collide.
//
// ── The three decisions this row's body asked to make ─────────────────────
//
//   1. **New operation, not `update_area`.** `update_area` renames or
//      archives ONE row and touches nothing else; a merge rewrites every
//      item that referenced the losing area plus the area rows themselves,
//      which is a different shape of write entirely — the same reasoning
//      `delete_area` already sets as precedent for "a second, more drastic
//      area operation gets its own name rather than a flag on the first".
//   2. **An event per touched item.** Every item whose `area`/`areas`
//      changed gets one `field_change` event, through the same
//      `recordFieldChanges` every other item-area write already uses
//      (`../items/item-areas.ts`, `update-item.ts`) — so the ledger explains
//      the merge exactly the way it explains any other area edit, and a
//      reader does not need a special case to reconstruct why an item's area
//      changed on this date.
//   3. **The losing area is archived, not hard-deleted.** Matching
//      `delete_item`'s "archive, never delete" posture and the precedent
//      this row's body names directly: #274 had to add `restore_item` after
//      `delete_item` first shipped with no way to undo it, because deciding
//      "gone forever" and deciding "not offered right now" are different
//      calls and the second is the one a merge — an operation a caller can
//      get wrong about which area should have won — actually wants. Archived
//      through the same column `update_area(archived: true)` already writes,
//      so undoing a wrong merge is `update_area(losing, { archived: false })`
//      followed by re-tagging the items that should not have moved — no
//      special-cased "unmerge" path to build or to get wrong.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { recordFieldChanges } from "@/lib/events";
import { callerEventActor, liveAssignmentId } from "../items/event-attribution";
import { AREA_COLUMNS, toAreaRecord, type RawAreaRow, type AreaRecord } from "../admin/area-row";

/** The guard name when `from` and `to` name the same area. */
export const SAME_AREA_GUARD = "area_merge.same_area";

const inputSchema = z
  .object({
    /** The area being folded away. Archived by this call, never deleted. */
    from: z.string().min(1),
    /** The area every item ends up holding in `from`'s place. */
    to: z.string().min(1),
  })
  .strict();

export type MergeAreasInput = z.infer<typeof inputSchema>;

export interface MergeAreasOutput {
  /** The surviving area, unchanged except for whatever items now point at it. */
  readonly to: AreaRecord;
  /** The losing area, archived by this call. */
  readonly from: AreaRecord;
  /** How many items held `from` before the merge — the size of the fold. */
  readonly itemsMerged: number;
  /**
   * Of those, how many already held `to` as well — the exact count the naive
   * `UPDATE` would have collided on. Reported so a caller can see the
   * de-duplication actually happened rather than trusting it silently did.
   */
  readonly duplicatesResolved: number;
}

interface ItemAreaRow {
  itemId: string;
  area: string;
  areas: string[];
}

async function loadAreaOrThrow(ctx: ServiceContext, id: string): Promise<AreaRecord> {
  const rows = await ctx.db.$queryRawUnsafe<RawAreaRow[]>(
    `SELECT ${AREA_COLUMNS} FROM "Area" WHERE "id" = $1`,
    id,
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`No such area: ${id}.`, { fields: ["id"] });
  }
  return toAreaRecord(row);
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const mergeAreas = defineOperation({
  name: "merge_areas",
  kind: "write",
  summary:
    "Folds one area's membership into another, de-duplicating items that already hold both, and archives the losing area.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: MergeAreasInput): Promise<MergeAreasOutput> {
    const { from, to } = input;

    if (from === to) {
      throw new GuardRejectedError(
        SAME_AREA_GUARD,
        `"from" and "to" both name "${from}" — there is nothing to merge.`,
        { fields: ["from", "to"] },
      );
    }

    // Both rows must exist before anything else is attempted — a merge
    // naming a typo'd id should fail before touching a single item, not
    // after de-duplicating half of them. Read now and re-read after the
    // merge below, rather than reused, because both `displayName` (via
    // `update_area`, unaffected here) and `itemCount` (very much affected)
    // could otherwise read stale.
    await loadAreaOrThrow(ctx, from);
    await loadAreaOrThrow(ctx, to);

    // Every item currently holding the losing area, with its full area set —
    // both representations, `Item.area` (the primary) and `ItemArea` (the
    // complete set including the primary) — so the de-duplication decision
    // below has everything it needs without a second round trip per item.
    const affected = await ctx.db.$queryRawUnsafe<ItemAreaRow[]>(
      `SELECT i."id" AS "itemId", i."area",
              COALESCE(
                (SELECT array_agg(ia."areaId" ORDER BY ia."areaId")
                   FROM "ItemArea" ia WHERE ia."itemId" = i."id"),
                ARRAY[]::text[]
              ) AS "areas"
         FROM "Item" i
        WHERE i."area" = $1 OR EXISTS (
          SELECT 1 FROM "ItemArea" ia WHERE ia."itemId" = i."id" AND ia."areaId" = $1
        )`,
      from,
    );

    let duplicatesResolved = 0;

    for (const item of affected) {
      const heldBoth = item.areas.includes(to);
      if (heldBoth) duplicatesResolved++;

      // The de-duplication pass, per item:
      //
      //   - Drop the losing membership unconditionally. If the item did not
      //     already hold `to`, this is followed by an insert of `to` below;
      //     if it did, dropping `from` is the entire fix — no insert is
      //     attempted, so there is nothing to collide on the primary key.
      //   - `ON CONFLICT DO NOTHING` on the insert is a second, redundant
      //     line of defence for the same case (a concurrent write that
      //     tagged this item with `to` between the SELECT above and this
      //     statement), not the primary mechanism — the `heldBoth` check
      //     already prevents the ordinary case from ever attempting an
      //     insert that could conflict.
      await ctx.db.$executeRawUnsafe(
        `DELETE FROM "ItemArea" WHERE "itemId" = $1 AND "areaId" = $2`,
        item.itemId,
        from,
      );
      if (!heldBoth) {
        await ctx.db.$executeRawUnsafe(
          `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          item.itemId,
          to,
        );
      }

      // The new area set, for the event and for `Item.area` below: `to` in
      // place of `from`, every other area untouched, order preserved except
      // that `from` is gone and `to` is guaranteed present.
      const newAreas = heldBoth
        ? item.areas.filter((areaId) => areaId !== from)
        : item.areas.map((areaId) => (areaId === from ? to : areaId)).sort();
      const wasPrimary = item.area === from;
      const newPrimary = wasPrimary ? to : item.area;

      if (wasPrimary) {
        await ctx.db.$executeRawUnsafe(`UPDATE "Item" SET "area" = $2 WHERE "id" = $1`, item.itemId, to);
      }

      const before: Record<string, unknown> = { areas: item.areas };
      const after: Record<string, unknown> = { areas: newAreas };
      const fields = ["areas"];
      if (wasPrimary) {
        before.area = item.area;
        after.area = newPrimary;
        fields.push("area");
      }

      await recordFieldChanges(ctx.db, {
        itemId: item.itemId,
        actor: callerEventActor(ctx.caller),
        assignmentId: await liveAssignmentId(ctx.db, item.itemId, ctx.caller),
        before,
        after,
        fields,
      });
    }

    // The losing area is archived, never deleted — see this file's header.
    // Same column `update_area(archived: true)` writes; a merge is not a
    // second archival mechanism, just a caller that also has items to move
    // first.
    await ctx.db.$executeRawUnsafe(
      `UPDATE "Area" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      from,
    );

    const toAfter = await loadAreaOrThrow(ctx, to);
    const fromAfter = await loadAreaOrThrow(ctx, from);

    return {
      to: toAfter,
      from: fromAfter,
      itemsMerged: affected.length,
      duplicatesResolved,
    };
  },
});
