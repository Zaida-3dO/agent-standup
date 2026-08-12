// `get_area` — SCHEMA.md §19 `GET /areas/{id}`. MILESTONES.md #92.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { AREA_COLUMNS, toAreaRecord, type RawAreaRow, type AreaRecord } from "../admin/area-row";

const inputSchema = z.object({ id: z.string().min(1) }).strict();

export type GetAreaInput = z.infer<typeof inputSchema>;

export const getArea = defineOperation({
  name: "get_area",
  kind: "read",
  summary: "Reads one area by id.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetAreaInput): Promise<AreaRecord> {
    const rows = await ctx.db.$queryRawUnsafe<RawAreaRow[]>(
      `SELECT ${AREA_COLUMNS} FROM "Area" WHERE "id" = $1`,
      input.id,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such area: ${input.id}.`, { fields: ["id"] });
    }
    return toAreaRecord(row);
  },
});
