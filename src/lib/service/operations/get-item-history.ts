// `get_item_history` — one item's ledger, paged server-side.
//
// **The gap this closes.** `get_item_detail` returns history under a cap
// (`historyLimit`, max 500) with no offset and no cursor, so the Activity
// tab's 25-rows-a-page control was slicing an array the browser already
// held. For an item with thousands of events the ledger was truncated
// before the UI ever saw it: the truncation notice disclosed that, so
// nothing lied, but the paging control implied a depth it did not have.
// Paging past the cap was simply unreachable from that screen.
//
// ── The consistency story, which is the actual design decision ───────────
//
// `get_item_detail` reads history **inside the same transaction** as the
// item, the tree and the artifacts, deliberately: that is what makes the
// first paint a single coherent snapshot rather than four
// independently-fresh fragments (see that operation's header). A paged
// history therefore had two options, and the choice matters:
//
//   1. **Join that transaction** — thread `offset`/`cursor` through
//      `get_item_detail` and re-read the entire detail payload for every
//      page. That keeps one snapshot across all sections, at the cost of
//      re-fetching the tree, the artifacts, the summary and the assignments
//      to turn one page of a timeline — which is the same
//      fetching-and-discarding this task exists to remove, just moved.
//   2. **Its own read with its own snapshot** — what this operation is.
//
// **This takes (2), and the guarantee it offers is per-page, not
// cross-page.** Every service call runs inside exactly one transaction
// (`runtime.ts`), so a page returned here is internally consistent: it is
// one snapshot of the ledger, never a torn read. What it does *not*
// promise is that page 3 shares a snapshot with page 1.
//
// **That weaker guarantee is sound here specifically because the ledger is
// append-only and this reads it newest-first with a keyset cursor.** New
// events land at *higher* ids, and the cursor walks strictly *downward*
// from a fixed id — so writes arriving between page 1 and page 3 land above
// the cursor and cannot shift, duplicate or skip any row on the page being
// fetched. This is exactly why the cursor is keyset rather than `OFFSET`:
// an `OFFSET 50` over a table receiving inserts is precisely the shape that
// silently repeats and drops rows, and it is the reason offset paging was
// not the easy option it looks like.
//
// The one visible effect of the separate snapshot is benign and worth
// stating plainly: events written after the first page was drawn do not
// appear until the reader refreshes. A timeline that quietly grew a new row
// under the reader's cursor would be worse.
//
// **Page one still comes from `get_item_detail`.** This operation does not
// replace that read, and the Activity tab does not call it to render its
// first page — the detail payload already carries the newest entries inside
// the whole-screen snapshot, which is the paint most worth keeping
// coherent. This is what the tab calls to go *past* them.
//
// **The slim shape is the default** (MILESTONES.md #109's convention, the
// one `get_events` follows for the same table). `payload` and `body`
// measured ~95% of a realistic event, so returning them by default made a
// page of 50 large enough to be refused outright by the response-size
// guard. `full: true` asks for them back.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { resolveItemId } from "../items/resolve-id";
import type { ItemDetailHistoryEntry } from "./get-item-detail";

const inputSchema = z
  .object({
    /** The item's id — a full UUID, or a short id that is a prefix of one. */
    id: z.string().min(1),
    /**
     * Return each entry's `payload` and `body` as well. Off by default —
     * see the module header for the measurements.
     */
    full: z.boolean().default(false),
    /**
     * How many entries this page holds. Capped at the same 200 every other
     * paged read in the product uses, so a caller learns one bound rather
     * than one per operation.
     */
    limit: z.number().int().min(1).max(200).default(50),
    /**
     * The `id` of the last entry on the previous page. Keyset, not offset —
     * see the module header on why that distinction is load-bearing against
     * an append-only table.
     *
     * Constrained to digits **here**, in the schema, rather than left for
     * Postgres to reject on the `::bigint` cast. Both refuse, but only this
     * one refuses as `invalid_input` naming the field — a cast failure
     * surfaces as an internal error, which reports a caller's typo as a
     * server fault and tells them nothing about how to fix it. An event id
     * is a positive integer, so anything else is a caller error rather than
     * an empty page: silently serving page one to someone who asked for
     * page seven is a wrong answer that looks like a right one.
     */
    cursor: z
      .string()
      .regex(/^\d+$/, "cursor must be an event id — a whole number, as returned in nextCursor")
      .optional(),
  })
  .strict();

export type GetItemHistoryInput = z.infer<typeof inputSchema>;

/**
 * One entry in the slim shape — every field `ItemDetailHistoryEntry` has
 * except the two unbounded ones. Expressed as an `Omit` of that type rather
 * than a fresh interface so the two shapes cannot drift: a field added to
 * the detail's entry appears here automatically, and one renamed there
 * fails to compile here.
 */
export type ItemHistorySlimEntry = Omit<ItemDetailHistoryEntry, "payload" | "body">;

export interface GetItemHistoryOutput {
  /** Newest first. Slim unless `full` was asked for. */
  readonly entries: readonly (ItemHistorySlimEntry | ItemDetailHistoryEntry)[];
  /**
   * How many entries this item's ledger holds in total — what lets a client
   * show "page 3 of 40" rather than only "there is more". Counted in the
   * same transaction as the page, so the two describe one snapshot.
   */
  readonly total: number;
  /**
   * The `id` of the last entry on this page, to pass back as `cursor`.
   * Null when this page is the last — a fact rather than an inference from
   * a page that happens to be exactly `limit` long, which is genuinely
   * ambiguous otherwise.
   */
  readonly nextCursor: string | null;
}

interface RawHistoryRow {
  id: bigint;
  ts: Date;
  type: string;
  actorType: string;
  actorId: string | null;
  sessionId: string | null;
  headline: string | null;
  payload?: unknown;
  body?: string | null;
}

/**
 * The columns the slim shape selects — everything but `payload` and `body`.
 *
 * Exported so a test can assert what is actually asked of Postgres. The
 * mapping in the handler builds the slim object field by field, so a query
 * that selected the two unbounded columns anyway would still return the
 * right *shape* while paying the full transfer cost — a mistake no
 * assertion on the response can see.
 */
export const SLIM_HISTORY_COLUMNS = `"id", "ts", "type"::text AS "type", "actorType"::text AS "actorType",
              "actorId", "sessionId", "headline"`;

/** The slim columns plus the two unbounded ones. */
export const FULL_HISTORY_COLUMNS = `${SLIM_HISTORY_COLUMNS}, "body", "payload"`;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const getItemHistory = defineOperation({
  name: "get_item_history",
  kind: "read",
  summary:
    "One item's history, newest first and paged — the ledger past what get_item_detail's cap returns. Returns each entry without its payload and body; pass full for those.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetItemHistoryInput): Promise<GetItemHistoryOutput> {
    // Resolved once, up front, for the same reason `get_item_detail`
    // resolves once: a short id must not match one item for the count and a
    // different one for the page.
    const id = await resolveItemId(ctx.db, input.id);

    // The item's existence is checked explicitly, because nothing else here
    // would notice its absence: `resolveItemId` returns an unknown-but-
    // well-formed reference untouched (see its header — that is deliberate,
    // so a caller's own `WHERE id = $1` reports the miss), and this
    // operation's own reads are over `Event`, where an unknown item simply
    // has no rows. Without this, asking for a nonexistent item would return
    // an empty ledger and a total of zero — which reads exactly like a real
    // item that nothing has happened to yet. `get_item_detail` refuses the
    // same reference, and two reads of the same item disagreeing about
    // whether it exists is the kind of inconsistency a paging client would
    // surface as a blank timeline rather than an error.
    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      id,
    );
    if (!itemRows[0]) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }

    const countRows = await ctx.db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM "Event" WHERE "itemId" = $1`,
      id,
    );
    const total = Number(countRows[0]?.count ?? 0);

    const values: unknown[] = [id];
    let paramIndex = 2;
    let cursorCondition = "";
    if (input.cursor !== undefined) {
      // `id < cursor` on a single monotonic bigint — no tie-break column is
      // needed, unlike `list_items`' `("createdAt", "id")`, because `id` is
      // itself the primary key and therefore already unique. Ordering by
      // `id` rather than `ts` is deliberate: two events can share a
      // millisecond timestamp, so `ts` alone is not a total order and a
      // cursor over it could repeat or skip.
      //
      // The schema has already guaranteed this is all digits, so the cast
      // cannot fail here — see the `cursor` field's own note on why that
      // rejection belongs in the schema rather than in Postgres.
      cursorCondition = `AND "id" < $${paramIndex}::bigint`;
      values.push(input.cursor);
      paramIndex++;
    }

    // One row beyond the page, so "there is more" is a fact rather than an
    // inference — the same trick `get_item_detail` and `list_items` use.
    values.push(input.limit + 1);
    const rows = await ctx.db.$queryRawUnsafe<RawHistoryRow[]>(
      `SELECT ${input.full ? FULL_HISTORY_COLUMNS : SLIM_HISTORY_COLUMNS}
       FROM "Event" WHERE "itemId" = $1 ${cursorCondition}
       ORDER BY "id" DESC LIMIT $${paramIndex}`,
      ...values,
    );

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const entries = page.map((row) => {
      const slim: ItemHistorySlimEntry = {
        // `id` is a bigint and cannot cross a JSON boundary —
        // `JSON.stringify` throws on one outright rather than truncating,
        // so every bigint is stringified here, the same rule `orientation`
        // and `get_item_detail` follow.
        id: row.id.toString(),
        ts: row.ts.toISOString(),
        type: row.type,
        actorType: row.actorType,
        actorId: row.actorId,
        sessionId: row.sessionId,
        headline: row.headline,
      };
      if (!input.full) return slim;
      return { ...slim, body: row.body ?? null, payload: row.payload ?? null };
    });

    return {
      entries,
      total,
      nextCursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null,
    };
  },
});
