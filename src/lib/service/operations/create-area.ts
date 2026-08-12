// `create_area` — SCHEMA.md §19 `POST /areas`, §23.1: "Auto-create on first
// use, with normalisation… blocking that is friction on the most common
// operation in the system." MILESTONES.md #92.
//
// Admin-facing find-or-create: normalises and creates-or-returns exactly
// like an item write does, via the same `ensureAreaRaw` (`../items/
// ensure-area-raw.ts`) that `create_item`/`update_item` call — this is the
// same mechanism, not a second copy of it, exposed so an operator can
// pre-create an area (or discover its normalised id) without writing an
// item first. Renaming and archiving an existing area are `update_area`'s
// job, not this one's — `ensureAreaRaw`'s `ON CONFLICT DO NOTHING` never
// overwrites a name already on record (see that module's own header).
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ensureAreaRaw } from "../items/ensure-area-raw";
import { AREA_COLUMNS, toAreaRecord, type RawAreaRow, type AreaRecord } from "../admin/area-row";

const inputSchema = z.object({ name: z.string().trim().min(1) }).strict();

export type CreateAreaInput = z.infer<typeof inputSchema>;

export const createArea = defineOperation({
  name: "create_area",
  kind: "write",
  summary: "Finds or creates an area by its normalised name.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: CreateAreaInput): Promise<AreaRecord> {
    const id = await ensureAreaRaw(ctx, input.name);
    const rows = await ctx.db.$queryRawUnsafe<RawAreaRow[]>(
      `SELECT ${AREA_COLUMNS} FROM "Area" WHERE "id" = $1`,
      id,
    );
    const row = rows[0];
    if (!row) {
      // Unreachable in practice: `ensureAreaRaw` just inserted-or-confirmed
      // this row in the same transaction. Guarded rather than asserted,
      // matching `ensureArea` (`../../areas.ts`)'s own posture on the same
      // "the insert that always returns a row didn't" case.
      throw new NotFoundError(`Area insert returned no row for id ${id}.`, { fields: [] });
    }
    return toAreaRecord(row);
  },
});
