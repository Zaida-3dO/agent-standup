// `list_items` — SCHEMA.md §19 (the board reads items grouped by column;
// this is the underlying filtered list every such view, and every adapter's
// "list" verb, reads from).
//
// **Finished work is excluded by default** (MILESTONES.md #103). The
// terminal states — `merged`, `research_done`, `wont_do`, `cancelled` — are
// the majority of any store that has been used for a while, and the share
// only grows, because nothing prunes them. A default that returns them
// makes the most common read in the product both the most expensive and,
// past a certain size, a *failed* read rather than a slow one: a response
// that does not fit the caller's context is not a list, and this is the
// first call a new session makes. `includeTerminal: true` asks for them
// back, for the callers — an audit, a "what shipped this week" — that
// genuinely want them.
//
// **An explicit `state` filter always wins over the default.** Asking for
// `state: "merged"` and receiving nothing would be a worse bug than the one
// this fixes, and a silently-empty result is the hardest kind to notice.
// The exclusion therefore applies only when the caller has not named a
// state itself — the default is answering "which state?" for a caller who
// did not, never overriding one who did.
//
// **The slim shape is the default** (MILESTONES.md #107). `limit` bounds row
// *count*; nothing bounded row *size*, so a page of five `executing` items
// could still overflow a caller's context on `body` and `customFields`
// alone. `full: true` asks for the whole record back. See
// `../items/row.ts`'s `ItemSummaryRecord` header for the measurements.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  itemColumnsFor,
  toItemRecord,
  toItemSummaryRecord,
  type ItemRecord,
  type ItemSummaryRecord,
  type RawItemRow,
  type RawItemSummaryRow,
} from "../items/row";
import { TERMINAL_STATES } from "../board/columns";
import { areaFilterCondition } from "../items/area-filter";

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
    /**
     * An area id. Matches an item carrying this area **anywhere in its area
     * set**, not only as its primary one (SCHEMA.md §23.1).
     */
    area: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    parentId: z.string().min(1).nullable().optional(),
    /**
     * Include finished work — `merged`, `research_done`, `wont_do`,
     * `cancelled`. Off by default; see the module header. Has no effect
     * when `state` names a terminal state explicitly, because that filter
     * is already the caller asking for exactly one of them.
     */
    includeTerminal: z.boolean().default(false),
    /**
     * Return whole `items` rows rather than the slim default. Off by
     * default — see `ItemSummaryRecord`. This is the parameter that bounds
     * response *size*; `limit` only ever bounded row count.
     */
    full: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type ListItemsInput = z.infer<typeof inputSchema>;

export interface ListItemsOutput {
  readonly items: readonly (ItemRecord | ItemSummaryRecord)[];
  /** The `id` of the last row in this page, to pass back as `cursor`. Absent when this page is the last. */
  readonly nextCursor: string | null;
}

export const listItems = defineOperation({
  name: "list_items",
  kind: "read",
  summary:
    "Lists items, filtered by state, priority, area, repo or parent, newest first. Returns id, title, state and headline only — pass full for the whole record. Finished work (merged, research_done, wont_do, cancelled) is excluded by default — pass includeTerminal to get it, or filter on that state directly.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ListItemsInput): Promise<ListItemsOutput> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.state !== undefined) {
      conditions.push(`"state" = $${paramIndex}::"ItemState"`);
      values.push(input.state);
      paramIndex++;
    } else if (!input.includeTerminal) {
      // Only when the caller named no state of their own — see the module
      // header. `!= ALL(...)` rather than `NOT IN (...)` so the four values
      // travel as one bound array parameter instead of four placeholders
      // whose count has to be kept in step with the list's length.
      conditions.push(`"state" != ALL($${paramIndex}::"ItemState"[])`);
      values.push(TERMINAL_STATES);
      paramIndex++;
    }
    if (input.priority !== undefined) {
      conditions.push(`"priority" = $${paramIndex}::"Priority"`);
      values.push(input.priority);
      paramIndex++;
    }
    if (input.area !== undefined) {
      // Matches ANY of the item's areas, not only its primary one — see
      // `areaFilterCondition` (../items/area-filter.ts) for why.
      conditions.push(areaFilterCondition(paramIndex));
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
    // The ordering key stays `("createdAt", "id")` in both shapes — the
    // cursor's meaning must not depend on which projection the caller asked
    // for, or two pages fetched with different `full` values would not
    // compose. `createdAt` is ordered on without being selected, which
    // Postgres permits and which is the point: the slim shape does not
    // return a column it only needs to sort by.
    const rows = await ctx.db.$queryRawUnsafe<(RawItemRow | RawItemSummaryRow)[]>(
      `SELECT ${itemColumnsFor(input.full)} FROM "Item" ${where}
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT $${paramIndex}`,
      ...values,
    );

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const items = input.full
      ? (page as RawItemRow[]).map(toItemRecord)
      : (page as RawItemSummaryRow[]).map(toItemSummaryRecord);

    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },
});
