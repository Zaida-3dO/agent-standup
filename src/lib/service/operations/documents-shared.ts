// What `doc_patch`, `doc_get`, `doc_list` and the item detail's document
// summary share: the vocabulary of names and keys, the size limits, the row
// shape, and the page-fitting rule.
//
// ── What a document is ──────────────────────────────────────────────────
//
// A named set of keyed JSON entries attached to an item (`ItemDoc`,
// `ItemDocEntry` in schema.prisma). It exists for material that is too big,
// too technical or too agent-only for the fields a person reads — a plan, a
// log, a progress page — and is loaded on demand: nothing that returns an
// item returns its documents.
//
// ── The limits, and why each is where it is ─────────────────────────────
//
// A page of entries has to come back under the response-size ceiling on
// every surface, including MCP, which delivers the payload twice
// (`response-size.ts`). That is only a promise the store can keep if a single
// entry can never be larger than a page, so the bound on one value is set
// here, at write time, rather than discovered when a read is refused.
import { z } from "zod";
import { InvalidInputError } from "../errors";
import type { TransactionHandle } from "../context";
import { MAX_RESPONSE_CHARS } from "../response-size";

/**
 * The name of a document: lowercase, starting with a letter, short.
 *
 * A name is a word an agent types in a tool call and a person reads in a
 * line of the item detail, so it is held to what reads cleanly in both.
 */
export const DOC_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;

/**
 * The key of an entry inside a document.
 *
 * Wide enough for the shapes callers use (a section name, a date, a
 * session's id, a path-like `group/item`), narrow enough that a key is
 * always one token: no whitespace, no control characters, no characters a
 * cursor or a URL would have to escape. The leading character is
 * alphanumeric so a key never reads as a flag or a separator.
 */
export const DOC_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@+/-]{0,199}$/;

/** The longest prefix `doc_get` will filter on. */
export const MAX_DOC_PREFIX_CHARS = 200;

/** How many keys one patch may set and delete between them. */
export const MAX_DOC_KEYS_PER_PATCH = 100;

/** How many keys one `doc_get` may ask for by name. */
export const MAX_DOC_KEYS_PER_GET = 200;

/**
 * The most characters one entry's value may serialise to.
 *
 * **Chosen so that one entry always fits on one page.** A page is capped at
 * `MAX_DOC_PAGE_CHARS` (a quarter of the response ceiling); 40,000 plus the
 * entry's key and bookkeeping is below it with room to spare, so a read can
 * always make progress by at least one entry. A larger value would have no
 * page it could be returned on. The remedy for a caller over the limit is
 * stated in the refusal: split it across keys, which is what the keyed shape
 * is for.
 */
export const MAX_DOC_VALUE_CHARS = 40_000;

/**
 * The most characters of entries one page carries.
 *
 * **A quarter of the ceiling, for the reason `get_item_body` documents:**
 * the guard measures what is delivered and an MCP result delivers the
 * payload twice, so a page sized to half the ceiling would be refused on the
 * surface agents use. A quarter leaves room for the envelope and the
 * doubling. Measured in serialised JSON of the entries, which is the unit
 * the guard counts in — not in the raw value, whose escapes widen on the
 * way out.
 */
export const MAX_DOC_PAGE_CHARS = Math.floor(MAX_RESPONSE_CHARS / 4);

export const DEFAULT_DOC_LIMIT = 100;
export const MAX_DOC_LIMIT = 200;

/** A document name, as a schema. Shared so all three operations refuse a bad one alike. */
export const docNameSchema = z
  .string()
  .regex(
    DOC_NAME_PATTERN,
    "doc must be a lowercase name of up to 48 characters: letters, digits, `_` or `-`, starting with a letter",
  );

/** An entry key, as a schema. */
export const docKeySchema = z
  .string()
  .regex(
    DOC_KEY_PATTERN,
    "a key must be 1 to 200 characters of letters, digits and `_ . : @ + / -`, starting with a letter or digit",
  );

/** UTF-8 bytes of a string — the unit an entry's size is reported in. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Serialises a value for storage, refusing one that cannot be.
 *
 * `JSON.stringify` yields `undefined` for a bare `undefined`, a function or
 * a symbol — values that cannot arrive over a wire at all, but can through a
 * direct call. Storing "nothing" under a key would make a set
 * indistinguishable from a delete, so it is refused by name.
 */
export function serialiseValue(key: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new InvalidInputError(
      `The value for "${key}" is not JSON. A document entry holds any JSON value (null included); to remove an entry, list its key in \`delete\`.`,
      { fields: [`set.${key}`] },
    );
  }
  // Postgres `jsonb` cannot hold a NUL inside a string; left alone, the write
  // would fail as a server fault rather than as the caller's input.
  if (json.includes("\\u0000")) {
    throw new InvalidInputError(
      `The value for "${key}" contains a NUL character (\\u0000), which a document cannot store. Remove it or encode it differently.`,
      { fields: [`set.${key}`] },
    );
  }
  if (json.length > MAX_DOC_VALUE_CHARS) {
    throw new InvalidInputError(
      `The value for "${key}" is ${json.length.toLocaleString("en-GB")} characters, over the ${MAX_DOC_VALUE_CHARS.toLocaleString("en-GB")}-character limit for one entry. Split it across several keys: a document is a set of small entries, and a reader loads only the ones it needs.`,
      { fields: [`set.${key}`] },
    );
  }
  return json;
}

/** One entry as `doc_get` reports it. */
export interface DocEntry {
  readonly key: string;
  readonly value: unknown;
  /** The document's revision when this entry was last written. */
  readonly rev: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/** One entry as `doc_list` reports it: the same, plus whose document it is. */
export interface ChildDocEntry extends DocEntry {
  readonly itemId: string;
}

/** The columns every entry read selects, so the row shape is declared once. */
export interface RawEntryRow {
  itemId: string;
  key: string;
  value: unknown;
  rev: number;
  updatedAt: Date;
  updatedBy: string | null;
}

export function toEntry(row: RawEntryRow): DocEntry {
  return {
    key: row.key,
    value: row.value,
    rev: Number(row.rev),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export function toChildEntry(row: RawEntryRow): ChildDocEntry {
  return { itemId: row.itemId, ...toEntry(row) };
}

/**
 * Cuts a fetched run of rows to one page.
 *
 * The caller fetches `limit + 1` rows in order. This keeps rows while their
 * serialised size fits `MAX_DOC_PAGE_CHARS` — always at least one, which
 * `MAX_DOC_VALUE_CHARS` makes safe — and reports whether anything was left
 * behind, either by the size budget or by the row limit. `hasMore` is a fact
 * about the fetched rows, never an inference from a page being short: a page
 * cut by size is shorter than `limit` and still has more.
 */
export function fitPage<Row, Out>(
  rows: readonly Row[],
  limit: number,
  render: (row: Row) => Out,
): { entries: Out[]; kept: Row[]; hasMore: boolean } {
  const entries: Out[] = [];
  const kept: Row[] = [];
  let used = 0;
  for (const row of rows) {
    if (kept.length >= limit) break;
    const entry = render(row);
    const size = JSON.stringify(entry).length;
    if (kept.length > 0 && used + size > MAX_DOC_PAGE_CHARS) break;
    entries.push(entry);
    kept.push(row);
    used += size;
  }
  return { entries, kept, hasMore: kept.length < rows.length };
}

/** One document of an item, summarised for the item detail. */
export interface ItemDocumentSummary {
  readonly doc: string;
  readonly entries: number;
  /** UTF-8 bytes of the stored values, summed. */
  readonly bytes: number;
}

/**
 * The documents an item carries, one summary each, by name.
 *
 * Counts and sizes only — never a value — because this rides along with a
 * read that must stay small however large a document grows. Grouped from the
 * entries rather than listed from the `ItemDoc` rows so a document whose
 * every entry has been deleted is not reported as a line of "0 entries".
 */
export async function summariseDocuments(
  db: TransactionHandle,
  itemId: string,
): Promise<ItemDocumentSummary[]> {
  const rows = await db.$queryRawUnsafe<{ doc: string; entries: bigint; bytes: bigint }[]>(
    `SELECT "doc", COUNT(*) AS "entries", COALESCE(SUM(octet_length("value"::text)), 0) AS "bytes"
     FROM "ItemDocEntry" WHERE "itemId" = $1
     GROUP BY "doc" ORDER BY "doc" COLLATE "C"`,
    itemId,
  );
  return rows.map((row) => ({
    doc: row.doc,
    entries: Number(row.entries),
    bytes: Number(row.bytes),
  }));
}
