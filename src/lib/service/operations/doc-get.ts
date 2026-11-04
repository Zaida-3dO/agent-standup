// `doc_get` — reads entries of one of an item's documents.
//
// A document is loaded on demand, and this is the load: the keys named, or
// the keys under a prefix, or all of them — in pages that always fit under
// the response-size ceiling. Nothing that returns an item returns its
// documents, so this and `doc_list` are the only reads of them.
//
// ── Paging ──────────────────────────────────────────────────────────────
//
// Keyset, on the key, in byte order (`COLLATE "C"`) so the order is the same
// whatever the database's locale and a cursor means the same thing on every
// page. A page ends at `limit` entries or at the character budget, whichever
// comes first — **a page cut by size is shorter than `limit` and still has
// more**, so `nextCursor` is the only thing that says whether to call again.
// The budget can always be met by at least one entry, because `doc_patch`
// refuses a value too large to share a page with its key.
//
// ── The revision ────────────────────────────────────────────────────────
//
// `rev` is the document's revision now: what to pass back as `ifRev` to
// `doc_patch`. It is read in the same transaction as the entries, so the two
// agree. For a document nobody has written it is 0, and `entries` is empty —
// that is not an error, because "nothing there yet" is the state a writer
// starts from.
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { resolveItemId } from "../items/resolve-id";
import {
  DEFAULT_DOC_LIMIT,
  MAX_DOC_KEYS_PER_GET,
  MAX_DOC_LIMIT,
  MAX_DOC_PREFIX_CHARS,
  docKeySchema,
  docNameSchema,
  fitPage,
  toEntry,
  type DocEntry,
  type RawEntryRow,
} from "./documents-shared";

const inputSchema = z
  .object({
    /** The item the document belongs to — a full UUID, or a short id that is a prefix of one. */
    itemId: z.string().min(1),
    /** The document's name, e.g. `progress`. */
    doc: docNameSchema,
    /** Read just these keys. Not together with `prefix`. */
    keys: z.array(docKeySchema).min(1).max(MAX_DOC_KEYS_PER_GET).optional(),
    /** Read every key that starts with this. Not together with `keys`. */
    prefix: z.string().min(1).max(MAX_DOC_PREFIX_CHARS).optional(),
    /** The `nextCursor` of the previous page. */
    cursor: z.string().min(1).optional(),
    /** At most this many entries per page (the size budget may cut it shorter). */
    limit: z.number().int().min(1).max(MAX_DOC_LIMIT).default(DEFAULT_DOC_LIMIT),
  })
  .strict();

export type DocGetInput = z.infer<typeof inputSchema>;

export interface DocGetOutput {
  readonly itemId: string;
  readonly doc: string;
  /** The document's revision now — pass it as `ifRev` to `doc_patch`. 0 when nothing has been written. */
  readonly rev: number;
  /** This page's entries, in key order. */
  readonly entries: readonly DocEntry[];
  /** Pass as `cursor` for the next page. `null` when this page is the last. */
  readonly nextCursor: string | null;
  /** With `keys`: the requested keys that hold no entry. Always empty otherwise. */
  readonly missing: readonly string[];
}

// Stryker disable all : see the note on `docPatch`.
export const docGet = defineOperation({
  name: "doc_get",
  kind: "read",
  summary:
    "Reads entries of one of an item's documents: the `keys` named, the keys under a `prefix`, or all of them, in key order. Returns the document's `rev` (pass it as ifRev to doc_patch), `missing` for requested keys that are absent, and a `nextCursor` while more remain — a page can be shorter than `limit` and still have more. Documents are not part of get_item.",
  contract: {
    rules: [
      {
        fields: ["keys", "prefix"],
        rule: "Give `keys` or `prefix`, not both. With neither, every key is read.",
      },
      {
        fields: ["cursor"],
        rule: "`cursor` is the `nextCursor` of the previous page of the same call; it is meaningless with different `keys`, `prefix` or `doc`.",
      },
    ],
    example: { itemId: "0f8e3a52", doc: "progress", prefix: "session-" },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: DocGetInput): Promise<DocGetOutput> {
    if (input.keys !== undefined && input.prefix !== undefined) {
      throw new InvalidInputError(
        "Give `keys` or `prefix`, not both: one names entries exactly, the other selects a range of them.",
        { fields: ["keys", "prefix"] },
      );
    }

    const itemId = await resolveItemId(ctx.db, input.itemId, "itemId");
    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      itemId,
    );
    if (itemRows.length === 0) {
      throw new NotFoundError(`No such item: ${itemId}.`, { fields: ["itemId"] });
    }

    const docRows = await ctx.db.$queryRawUnsafe<{ rev: number }[]>(
      `SELECT "rev" FROM "ItemDoc" WHERE "itemId" = $1 AND "doc" = $2`,
      itemId,
      input.doc,
    );
    const rev = Number(docRows[0]?.rev ?? 0);

    const values: unknown[] = [itemId, input.doc];
    const conditions = [`"itemId" = $1`, `"doc" = $2`];
    if (input.keys !== undefined) {
      values.push(input.keys);
      conditions.push(`"key" = ANY($${values.length}::text[])`);
    }
    if (input.prefix !== undefined) {
      values.push(input.prefix);
      conditions.push(`starts_with("key", $${values.length}::text)`);
    }
    if (input.cursor !== undefined) {
      values.push(input.cursor);
      conditions.push(`"key" COLLATE "C" > $${values.length}::text`);
    }
    values.push(input.limit + 1);
    const rows = await ctx.db.$queryRawUnsafe<RawEntryRow[]>(
      `SELECT "itemId", "key", "value", "rev", "updatedAt", "updatedBy"
       FROM "ItemDocEntry" WHERE ${conditions.join(" AND ")}
       ORDER BY "key" COLLATE "C" ASC LIMIT $${values.length}`,
      ...values,
    );

    const page = fitPage(rows, input.limit, toEntry);
    const last = page.kept[page.kept.length - 1];

    // Which requested keys hold nothing — answered over the whole request,
    // not the page, so it is the same on every page and a caller does not
    // have to accumulate it. Asked only when keys were named (at most 200).
    let missing: string[] = [];
    if (input.keys !== undefined) {
      const found = await ctx.db.$queryRawUnsafe<{ key: string }[]>(
        `SELECT "key" FROM "ItemDocEntry"
         WHERE "itemId" = $1 AND "doc" = $2 AND "key" = ANY($3::text[])`,
        itemId,
        input.doc,
        input.keys,
      );
      const present = new Set(found.map((row) => row.key));
      missing = [...new Set(input.keys)].filter((key) => !present.has(key));
    }

    return {
      itemId,
      doc: input.doc,
      rev,
      entries: page.entries,
      nextCursor: page.hasMore && last ? last.key : null,
      missing,
    };
  },
});
