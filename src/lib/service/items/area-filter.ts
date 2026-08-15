// The area filter, shared by `list_items` and `get_board` (SCHEMA.md §23.1).
//
// **Filtering by area matches ANY of an item's areas, not just its primary
// one.** An item that is both "web" and "infra" is genuinely both, and a
// filter that only ever read `Item.area` would return it under one and hide
// it under the other — which makes the second area decorative and the filter
// quietly wrong rather than merely narrow. "Show me everything related to
// this" is the whole job of the field.
//
// Written as one exported fragment rather than the same `EXISTS` typed into
// both operations, because those two filters silently disagreeing is exactly
// the failure this would produce: a board and a list, asked the same
// question, answering differently. There is one place to change.
//
// An `EXISTS` subquery rather than a join: both callers select whole `Item`
// rows, and a join against `ItemArea` would multiply each row by the number
// of areas it carries, so every caller would need a `DISTINCT` to undo that.
// `EXISTS` filters without touching row multiplicity, and it is served by
// `ItemArea`'s primary key, which leads with `itemId`.
//
// Deliberately reads only `ItemArea`, never `Item.area` as well: the join
// table is the complete set including the primary area (`setItemAreas` in
// ./item-areas.ts writes it that way), so an `OR "area" = $n` would be a
// second, redundant condition whose only real effect would be to keep
// returning rows if the two representations ever drifted — hiding the very
// drift worth finding.

/**
 * A SQL condition matching items carrying the area bound at `$paramIndex`.
 *
 * The caller pushes the area value onto its own parameter list and passes
 * the resulting 1-based index, so this composes with whatever other filters
 * that operation has already built.
 */
export function areaFilterCondition(paramIndex: number): string {
  return `EXISTS (SELECT 1 FROM "ItemArea" WHERE "ItemArea"."itemId" = "Item"."id" AND "ItemArea"."areaId" = $${paramIndex})`;
}
