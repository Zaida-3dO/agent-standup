// `list_areas` — SCHEMA.md §19 `GET /areas`, §23.1. MILESTONES.md #92.
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
  summary: "Lists areas, active only by default.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ListAreasInput): Promise<ListAreasOutput> {
    const where = input.includeArchived ? "" : `WHERE "archivedAt" IS NULL`;
    const rows = await ctx.db.$queryRawUnsafe<RawAreaRow[]>(
      `SELECT ${AREA_COLUMNS} FROM "Area" ${where} ORDER BY "id" ASC`,
    );
    return { areas: rows.map(toAreaRecord) };
  },
});
