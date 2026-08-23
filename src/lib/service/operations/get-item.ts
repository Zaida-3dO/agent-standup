// `get_item` — SCHEMA.md §19 `GET /items/{id}`.
//
// **The slim shape is the default** (MILESTONES.md #107): `{id, title,
// state, headline}` plus the latest checkpoint's own headline. `full: true`
// asks for the whole record back. The reasoning — and why neither a filter
// nor a page size could have fixed what this fixes — is in
// `../items/row.ts`'s `ItemSummaryRecord` header.
//
// **`get_item` is the sharpest case of the three reads this changes.** It is
// `WHERE id = $1`: there is no state filter to default and no page size to
// bound, so before this row there was no parameter anywhere in the operation
// that could make its response smaller. The only lever is which columns come
// back.
import { z } from "zod";
import { NotFoundError } from "../errors";
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
import { latestCheckpointHeadline } from "../items/checkpoint-headline";
import { resolveItemId } from "../items/resolve-id";

const inputSchema = z
  .object({
    /**
     * The item's id — a full UUID, or a short id that is a prefix of one
     * (see `../items/resolve-id.ts`). Still `min(1)` rather than a UUID
     * check: this operation never validated the shape, and tightening it
     * here would be a behaviour change riding along with an additive one.
     */
    id: z.string().min(1),
    /**
     * Return the whole `items` row rather than the slim default. Off by
     * default — see `ItemSummaryRecord`. Wanted by the caller that is about
     * to *edit* the item, or that genuinely needs `body`/`customFields`;
     * not by the far more common caller asking "what is this".
     */
    full: z.boolean().default(false),
  })
  .strict();

export type GetItemInput = z.infer<typeof inputSchema>;

/**
 * The slim read's result: the item's own summary, and the latest
 * checkpoint's headline if it has one.
 *
 * The checkpoint headline rides along rather than needing a second call
 * because latest-checkpoint is already an indexed single-row read
 * (SCHEMA.md §4) and "what is this / where is it up to" is one question a
 * session asks once, not two.
 */
export interface GetItemSummaryOutput extends ItemSummaryRecord {
  /** The newest checkpoint's one-line BLUF on this item, or null if there is no checkpoint or it has no headline. */
  readonly checkpointHeadline: string | null;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getItem = defineOperation({
  name: "get_item",
  kind: "read",
  summary:
    "Reads one item by id. Returns the slim shape — id, title, state, headline and the latest checkpoint's headline — unless full is passed.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: GetItemInput,
  ): Promise<ItemRecord | GetItemSummaryOutput> {
    // A full UUID passes straight through untouched; a short id becomes the
    // one item it identifies, or refuses. Everything below still queries by
    // exact id, so the lookups are unchanged.
    const id = await resolveItemId(ctx.db, input.id);

    if (input.full) {
      const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
        `SELECT ${itemColumnsFor(true)} FROM "Item" WHERE "id" = $1`,
        id,
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
      }
      return toItemRecord(row);
    }

    const rows = await ctx.db.$queryRawUnsafe<RawItemSummaryRow[]>(
      `SELECT ${itemColumnsFor(false)} FROM "Item" WHERE "id" = $1`,
      id,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }
    return {
      ...toItemSummaryRecord(row),
      checkpointHeadline: await latestCheckpointHeadline(ctx.db, id),
    };
  },
});
