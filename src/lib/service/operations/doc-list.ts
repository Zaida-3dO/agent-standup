// `doc_list` — one document across the children of an item.
//
// The read for "the same document on every task of this project": a page
// built from many small per-item documents, a status roll-up, an export.
// Without it a caller would read the children's ids and then call `doc_get`
// once per child; here it is one paged walk.
//
// Only direct children are walked, and archived children are skipped — the
// same rule every list of an item's children follows, so an item withdrawn
// from circulation does not leak back in through its documents.
//
// ── Paging ──────────────────────────────────────────────────────────────
//
// Keyset on `(itemId, key)` in byte order, so a walk visits every entry once
// and the order does not depend on the database's locale. The cursor is
// `<itemId>|<key>`: an item id never contains `|` (ids are UUIDs or short
// forms of them), and a key's character set excludes it, so the split is
// unambiguous. A page ends at `limit` entries or at the character budget
// (`MAX_DOC_PAGE_CHARS`), and `nextCursor` — not the page's length — says
// whether to call again.
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { resolveItemId } from "../items/resolve-id";
import {
  DEFAULT_DOC_LIMIT,
  MAX_DOC_LIMIT,
  docNameSchema,
  fitPage,
  toChildEntry,
  type ChildDocEntry,
  type RawEntryRow,
} from "./documents-shared";

const inputSchema = z
  .object({
    /** The item whose children's documents to read — a full UUID, or a short id that is a prefix of one. */
    parentId: z.string().min(1),
    /** The document's name, e.g. `progress`. */
    doc: docNameSchema,
    /** The `nextCursor` of the previous page. */
    cursor: z.string().min(1).optional(),
    /** At most this many entries per page (the size budget may cut it shorter). */
    limit: z.number().int().min(1).max(MAX_DOC_LIMIT).default(DEFAULT_DOC_LIMIT),
  })
  .strict();

export type DocListInput = z.infer<typeof inputSchema>;

export interface DocListOutput {
  readonly parentId: string;
  readonly doc: string;
  /** This page's entries, ordered by child id then key. Each says which child it belongs to. */
  readonly entries: readonly ChildDocEntry[];
  /** Pass as `cursor` for the next page. `null` when this page is the last. */
  readonly nextCursor: string | null;
}

// Stryker disable all : see the note on `docPatch`.
export const docList = defineOperation({
  name: "doc_list",
  kind: "read",
  summary:
    "Reads one document across the direct, non-archived children of an item: every entry of that document on each child, ordered by child then key, each tagged with its child's itemId. Paged under the response-size limit — follow `nextCursor` until it is null; a page can be shorter than `limit` and still have more.",
  contract: {
    rules: [
      {
        fields: ["cursor"],
        rule: "`cursor` is the `nextCursor` of the previous page of the same call, and is meaningless with a different `parentId` or `doc`.",
      },
    ],
    example: { parentId: "0f8e3a52", doc: "progress" },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: DocListInput): Promise<DocListOutput> {
    const parentId = await resolveItemId(ctx.db, input.parentId, "parentId");
    const parentRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      parentId,
    );
    if (parentRows.length === 0) {
      throw new NotFoundError(`No such item: ${parentId}.`, { fields: ["parentId"] });
    }

    const values: unknown[] = [parentId, input.doc];
    let after = "";
    if (input.cursor !== undefined) {
      const split = input.cursor.indexOf("|");
      if (split <= 0 || split === input.cursor.length - 1) {
        throw new InvalidInputError(
          "That `cursor` is not one this call returned. Pass the `nextCursor` of the previous page unchanged, or omit it to start from the beginning.",
          { fields: ["cursor"] },
        );
      }
      values.push(input.cursor.slice(0, split), input.cursor.slice(split + 1));
      after = `AND (e."itemId" COLLATE "C", e."key" COLLATE "C") > ($3::text, $4::text)`;
    }
    values.push(input.limit + 1);
    const rows = await ctx.db.$queryRawUnsafe<RawEntryRow[]>(
      `SELECT e."itemId", e."key", e."value", e."rev", e."updatedAt", e."updatedBy"
       FROM "ItemDocEntry" e JOIN "Item" c ON c."id" = e."itemId"
       WHERE c."parentId" = $1 AND c."archivedAt" IS NULL AND e."doc" = $2 ${after}
       ORDER BY e."itemId" COLLATE "C" ASC, e."key" COLLATE "C" ASC
       LIMIT $${values.length}`,
      ...values,
    );

    const page = fitPage(rows, input.limit, toChildEntry);
    const last = page.kept[page.kept.length - 1];

    return {
      parentId,
      doc: input.doc,
      entries: page.entries,
      nextCursor: page.hasMore && last ? `${last.itemId}|${last.key}` : null,
    };
  },
});
