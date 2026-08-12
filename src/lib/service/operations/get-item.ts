// `get_item` — SCHEMA.md §19 `GET /items/{id}`.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";

const inputSchema = z.object({ id: z.string().min(1) }).strict();

export type GetItemInput = z.infer<typeof inputSchema>;

export const getItem = defineOperation({
  name: "get_item",
  kind: "read",
  summary: "Reads one item by id.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetItemInput): Promise<ItemRecord> {
    const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      input.id,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such item: ${input.id}.`, { fields: ["id"] });
    }
    return toItemRecord(row);
  },
});
