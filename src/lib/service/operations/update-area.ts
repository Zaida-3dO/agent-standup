// `update_area` — SCHEMA.md §19 `PATCH /areas/{id}`, §23.1: "Archive, never
// delete." MILESTONES.md #92. Renames the display name and/or archives —
// never renames the *id*, because `items.area` is a foreign key into it.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { AREA_COLUMNS, toAreaRecord, type RawAreaRow, type AreaRecord } from "../admin/area-row";

const inputSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().trim().min(1).optional(),
    /** `true` archives (sets `archivedAt` to now), `false` un-archives (clears it). Omitted = no change. */
    archived: z.boolean().optional(),
  })
  .strict();

export type UpdateAreaInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const updateArea = defineOperation({
  name: "update_area",
  kind: "write",
  summary: "Renames an area's display name, and archives or un-archives it.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: UpdateAreaInput): Promise<AreaRecord> {
    const { id, archived, displayName } = input;

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (displayName !== undefined) {
      setClauses.push(`"displayName" = $${paramIndex}`);
      values.push(displayName);
      paramIndex++;
    }
    if (archived !== undefined) {
      setClauses.push(archived ? `"archivedAt" = CURRENT_TIMESTAMP` : `"archivedAt" = NULL`);
    }

    if (setClauses.length === 0) {
      const currentRows = await ctx.db.$queryRawUnsafe<RawAreaRow[]>(
        `SELECT ${AREA_COLUMNS} FROM "Area" WHERE "id" = $1`,
        id,
      );
      const current = currentRows[0];
      if (!current) {
        throw new NotFoundError(`No such area: ${id}.`, { fields: ["id"] });
      }
      return toAreaRecord(current);
    }

    values.push(id);
    const rows = await ctx.db.$queryRawUnsafe<RawAreaRow[]>(
      `UPDATE "Area" SET ${setClauses.join(", ")} WHERE "id" = $${paramIndex} RETURNING ${AREA_COLUMNS}`,
      ...values,
    );
    const updated = rows[0];
    if (!updated) {
      throw new NotFoundError(`No such area: ${id}.`, { fields: ["id"] });
    }
    return toAreaRecord(updated);
  },
});
