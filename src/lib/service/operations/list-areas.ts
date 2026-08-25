// `list_areas` — SCHEMA.md §19 `GET /areas`, §23.1. MILESTONES.md #92.
//
// **Each area comes back with how many items carry it** (row 6b2fb637).
// Areas are free text with find-or-create, so `website` typed where `web`
// exists silently becomes a second row — normalisation collapses case and
// separators, never synonyms. A bare list of names cannot tell a real area
// from a one-off typo; the count can, and it is the read that lets anyone
// answer "do we have near-duplicate areas?" without opening a psql session.
//
// Counted with a `LEFT JOIN` over `ItemArea` rather than a correlated
// subquery per row, because this list is short and one grouped scan beats N
// round trips. `LEFT`, not an inner join: an area with no items must still
// appear — a freshly-created or newly-emptied area vanishing from the admin
// page would be a worse bug than the one this fixes, and `count("ItemArea")`
// (a column, not `*`) is what makes the empty case count 0 instead of 1.
//
// `ItemArea` rather than `Item.area` is deliberate and load-bearing: an item
// may carry several areas, the join table is the complete set including the
// primary one, and it is the table `areaFilterCondition` filters on. Counting
// `Item.area` would under-report every area that is some item's second one,
// and disagree with the number of rows the board shows when filtered by it.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { AREA_COLUMNS, toAreaRecord, type RawAreaRow, type AreaRecord } from "../admin/area-row";

const inputSchema = z
  .object({
    includeArchived: z.boolean().default(false),
  })
  .strict();

export type ListAreasInput = z.infer<typeof inputSchema>;

export interface ListAreasOutput {
  readonly areas: readonly AreaRecord[];
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const listAreas = defineOperation({
  name: "list_areas",
  kind: "read",
  summary:
    "Lists areas with how many items carry each, active only by default. The counts are what make a near-duplicate area (web beside website) visible.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ListAreasInput): Promise<ListAreasOutput> {
    // Qualified with the table name because the join below brings a second
    // `"id"` into scope, and an unqualified one would be ambiguous.
    const columns = AREA_COLUMNS.split(", ")
      .map((column) => `"Area".${column.startsWith('"') ? column : `"${column}"`}`)
      .join(", ");
    const where = input.includeArchived ? "" : `WHERE "Area"."archivedAt" IS NULL`;
    const rows = await ctx.db.$queryRawUnsafe<RawAreaRow[]>(
      `SELECT ${columns}, count("ItemArea"."itemId") AS "itemCount"
       FROM "Area"
       LEFT JOIN "ItemArea" ON "ItemArea"."areaId" = "Area"."id"
       ${where}
       GROUP BY ${columns}
       ORDER BY "Area"."id" ASC`,
    );
    return { areas: rows.map(toAreaRecord) };
  },
});
