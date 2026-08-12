// `list_items` — SCHEMA.md §19 (the board reads items grouped by column;
// this is the underlying filtered list every such view, and every adapter's
// "list" verb, reads from).
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";

const inputSchema = z
  .object({
    state: z
      .enum([
        "someday",
        "on_deck",
        "planning",
        "plan_review",
        "executing",
        "in_review",
        "paused",
        "blocked",
        "merged",
        "research_done",
        "wont_do",
        "cancelled",
      ])
      .optional(),
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    area: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    parentId: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type ListItemsInput = z.infer<typeof inputSchema>;

export interface ListItemsOutput {
  readonly items: readonly ItemRecord[];
  /** The `id` of the last row in this page, to pass back as `cursor`. Absent when this page is the last. */
  readonly nextCursor: string | null;
}

export const listItems = defineOperation({
  name: "list_items",
  kind: "read",
  summary: "Lists items, filtered by state, priority, area, repo or parent, newest first.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ListItemsInput): Promise<ListItemsOutput> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.state !== undefined) {
      conditions.push(`"state" = $${paramIndex}::"ItemState"`);
      values.push(input.state);
      paramIndex++;
    }
    if (input.priority !== undefined) {
      conditions.push(`"priority" = $${paramIndex}::"Priority"`);
      values.push(input.priority);
      paramIndex++;
    }
    if (input.area !== undefined) {
      conditions.push(`"area" = $${paramIndex}`);
      values.push(input.area);
      paramIndex++;
    }
    if (input.repo !== undefined) {
      conditions.push(`"repo" = $${paramIndex}`);
      values.push(input.repo);
      paramIndex++;
    }
    if (input.parentId !== undefined) {
      if (input.parentId === null) {
        conditions.push(`"parentId" IS NULL`);
      } else {
        conditions.push(`"parentId" = $${paramIndex}`);
        values.push(input.parentId);
        paramIndex++;
      }
    }
    if (input.cursor !== undefined) {
      // Keyset pagination on `("createdAt", "id")`, both descending — `id`
      // breaks ties between rows created in the same millisecond, which
      // `createdAt` alone cannot: without it, two items created together
      // could interleave across pages or repeat depending on scan order.
      const cursorRows = await ctx.db.$queryRawUnsafe<{ createdAt: Date | string }[]>(
        `SELECT "createdAt" FROM "Item" WHERE "id" = $1`,
        input.cursor,
      );
      const cursorRow = cursorRows[0];
      if (cursorRow) {
        conditions.push(`("createdAt", "id") < ($${paramIndex}::timestamptz, $${paramIndex + 1})`);
        values.push(cursorRow.createdAt, input.cursor);
        paramIndex += 2;
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Fetch one extra row to know whether a further page exists without a
    // separate COUNT query.
    values.push(input.limit + 1);
    const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" ${where}
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT $${paramIndex}`,
      ...values,
    );

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const items = page.map(toItemRecord);

    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },
});
