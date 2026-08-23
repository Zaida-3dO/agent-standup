// The two things every loop operation does before it does anything else:
// check the item exists, and read its loop events.
//
// Extracted because the query had been written out three times already — in
// `open-loops.ts`'s write path, inline in `orientation`, and again in
// `progress-report` — and the read operations would have made it five. The
// duplication matters more than it looks: the fold's correctness depends on
// being handed the item's *complete* loop-event slice in `id` order, so a
// copy that quietly omitted an event type or changed the ordering would not
// fail loudly, it would silently report a closed loop as open. One
// definition means a new loop event type is added to the fold and to this
// query, and every caller picks it up.
import { NotFoundError } from "../errors";
import type { ServiceContext } from "../context";
import { LOOP_EVENT_TYPES, type LoopEventLike } from "@/lib/open-loops";

/**
 * The SQL fragment listing every loop event type, as `EventType` literals.
 *
 * Built from `LOOP_EVENT_TYPES` rather than written out, so the fold and the
 * query cannot disagree about what a loop event is — the failure mode being
 * avoided is a new type understood by the fold but never fetched, which
 * reads as the feature silently not working.
 *
 * Interpolated rather than bound because these are enum labels in an `IN`
 * list, not values; they come from a module-level `as const` tuple in this
 * repo's own source and never from a caller, so no input reaches this
 * string.
 */
const LOOP_EVENT_TYPE_SQL = LOOP_EVENT_TYPES.map((type) => `'${type}'::"EventType"`).join(", ");

/** Every loop event for an item, oldest first — the slice the fold needs to be correct. */
export async function loopEventsFor(ctx: ServiceContext, itemId: string): Promise<LoopEventLike[]> {
  return ctx.db.$queryRawUnsafe<LoopEventLike[]>(
    `SELECT "id", "ts", "type", "payload" FROM "Event"
      WHERE "itemId" = $1 AND "type" IN (${LOOP_EVENT_TYPE_SQL})
      ORDER BY "id" ASC`,
    itemId,
  );
}

/**
 * Refuses when no such item exists.
 *
 * The field name is a parameter because the operations spell it differently
 * — the loop operations take `itemId`, and a rejection has to name the field
 * the caller actually sent or the error points at nothing.
 */
export async function requireItemExists(
  ctx: ServiceContext,
  itemId: string,
  field: string,
): Promise<void> {
  const rows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "Item" WHERE "id" = $1`,
    itemId,
  );
  if (rows.length === 0) {
    throw new NotFoundError(`No such item: ${itemId}.`, { fields: [field] });
  }
}
