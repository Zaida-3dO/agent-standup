// `get_item_body` — one item's `body`, paged server-side.
//
// **The gap this closes.** `get_item` and `get_item_detail` are the only
// ways to reach an item's `body`, and both return the whole record —
// `body` included — with no parameter that makes that one field smaller.
// A body over the response-size ceiling (`response-size.ts`) is therefore
// refused with nowhere to go: the remedy those refusals offer, `full: false`
// / the slim record, is the shape the caller already had, and it drops
// `body` entirely rather than returning less of it. This operation is the
// missing destination — a caller who cannot read the whole body reads it in
// windows instead.
//
// **Why a dedicated operation rather than a parameter on `get_item`.**
// `get_item`'s `full` flag returns the *record*: title, state, every
// scalar column, `body` included. Threading an offset/limit through it
// would mean the operation sometimes returns a record and sometimes a
// fragment of one field, which is two different shapes behind one flag.
// `get_item_history`'s own split from `get_item_detail` set this precedent
// for the same reason: a second concern gets a second read, not a second
// mode bolted onto the first.
//
// **Why offset/limit rather than a keyset cursor.** `get_item_history`
// pages an *append-only* table — new rows land at higher ids that can never
// land inside a cursor already walked past, which is what makes offset
// paging wrong there (its own header: `OFFSET` over a table receiving
// inserts silently repeats or drops rows). `body` is a single scalar on a
// single row, not a growing set of rows: nothing can be inserted "before"
// offset 400 the way an event can be inserted before an id. A caller who
// edits the item between two pages of this read gets a page computed
// against the body as it stands at that moment — a per-page snapshot, the
// same guarantee `get_item_history` documents and no weaker — but there is
// no keyset here for the same reason there is no `ORDER BY` here: `body` is
// not a sequence of rows to order.
//
// **Why this must not become a way around the response-size cap.** The
// row this operation answers is explicit that a paged read "has to make
// its own partialness explicit, or it reintroduces the exact hazard" the
// cap exists to prevent. So every field a caller needs to tell a partial
// page from the whole thing is returned on every call: `totalLength` (how
// long the body actually is), `offset` and the returned slice's own length
// (where this page sits), and `hasMore` (whether calling again would
// return anything new) — never inferred from whether a page happened to
// come back shorter than asked.
//
// **`nextOffset`, not a caller-computed one — this is a second instance of
// the same principle, one boundary further out.** `SUBSTRING`/`LENGTH`
// count Postgres characters; a JavaScript string's own `.length` counts
// UTF-16 code units, and the two disagree on any character outside the
// Basic Multilingual Plane (an emoji is 1 Postgres character, 2 JS units).
// A caller walking pages by advancing `offset += chunk.length` — the
// obvious reading of "an offset and a chunk" — overshoots by one per such
// character consumed: content is silently skipped, and because the same
// arithmetic decided `hasMore`, the walk can terminate one page early
// having served a body that reassembles short. That is a torn read with
// no signal attached — exactly "a partial result you cannot identify as
// partial" for a caller who did nothing wrong, discovered against real
// board content this operation exists to read (search for "emoji" turns
// up rows carrying one). So the offset arithmetic is not exposed for a
// caller to redo: `nextOffset` is computed here, in the same
// Postgres-character units as `offset` and `SUBSTRING` themselves, from
// `LENGTH(chunk)` rather than from the JS string's own `.length` — a
// caller that just passes `nextOffset` back can get this wrong by
// ignoring the field, never by doing the arithmetic in the wrong unit.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { resolveItemId } from "../items/resolve-id";
import { MAX_RESPONSE_CHARS } from "../response-size";

/**
 * The most characters one page may hold.
 *
 * **A quarter of the ceiling, not half, and the arithmetic is worth
 * spelling out because a half-ceiling chunk looks safe and is not.** `mcp`
 * (`WIRE_COPIES_PER_SURFACE`) delivers every response *twice*, and the
 * response-size guard measures what is delivered, not what the handler
 * returns. A chunk sized to half the ceiling still serialises to just over
 * half of it once `offset`, `totalLength` and `hasMore` ride along, and
 * doubled on MCP that clears the full ceiling — refusing the default call
 * of the operation that exists specifically to work around that refusal,
 * on the one surface most callers reach it from. A quarter leaves genuine
 * headroom after both the envelope fields and the MCP doubling, checked
 * directly in `item-body-operation.test.ts`'s "every page this operation
 * returns stays under the response-size ceiling" rather than trusted from
 * this comment.
 */
export const MAX_BODY_CHUNK_CHARS = Math.floor(MAX_RESPONSE_CHARS / 4);

const inputSchema = z
  .object({
    /** The item's id — a full UUID, or a short id that is a prefix of one. */
    id: z.string().min(1),
    /**
     * How far into `body` this page starts, in characters. Zero-based —
     * `offset: 0` is the start of the body. Defaults to the start, so the
     * common case ("give me the beginning") needs no parameter at all.
     */
    offset: z.number().int().min(0).default(0),
    /**
     * How many characters this page holds. Capped at `MAX_BODY_CHUNK_CHARS`
     * rather than the generic 200 every row-paged read shares — a page here
     * is measured in characters of one field, not in rows, so the row-based
     * bound other paged reads use does not apply.
     */
    limit: z.number().int().min(1).max(MAX_BODY_CHUNK_CHARS).default(MAX_BODY_CHUNK_CHARS),
  })
  .strict();

export type GetItemBodyInput = z.infer<typeof inputSchema>;

export interface GetItemBodyOutput {
  /** This page's slice of `body`. May be shorter than `limit` — see `hasMore`, never inferred from this length alone. */
  readonly chunk: string;
  /** Where this page starts in the full body, in characters (Postgres characters — see the module header on why that unit matters). */
  readonly offset: number;
  /** How long the WHOLE body is, in characters — what lets a caller compute how many pages remain. */
  readonly totalLength: number;
  /**
   * Whether calling again with `nextOffset` would return more content. A
   * fact computed server-side from `offset + LENGTH(chunk)` against
   * `totalLength` — the same sum `nextOffset` itself is, before the
   * `hasMore`-false case collapses it to `null` — never an inference from
   * `chunk` coming back shorter than `limit`: the last page of a body
   * whose length is an exact multiple of `limit` is legitimately full
   * length and still has no more after it.
   */
  readonly hasMore: boolean;
  /**
   * The `offset` to pass on the next call to continue reading — `null` once
   * `hasMore` is false, so there is nothing to pass back into.
   *
   * Computed here from `LENGTH(chunk)`, the chunk's own Postgres-character
   * count, rather than left for the caller to derive from the returned
   * string's JavaScript `.length`. Those two counts disagree on any
   * character outside the Basic Multilingual Plane — the module header
   * has the full reasoning — so a caller that used the string's own length
   * to advance would silently skip content on exactly the input this
   * operation exists to serve. Passing `nextOffset` straight back removes
   * that arithmetic from the caller entirely.
   */
  readonly nextOffset: number | null;
}

interface RawBodyRow {
  chunk: string;
  chunkLength: number;
  totalLength: number;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getItemBody = defineOperation({
  name: "get_item_body",
  kind: "read",
  summary:
    "One item's body, paged by character offset — the window past what get_item and get_item_detail's response-size cap allows a whole body to return.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetItemBodyInput): Promise<GetItemBodyOutput> {
    // Resolved once, for the same reason every other single-item read
    // resolves once: a short id must not match one item for the length and
    // a different one for the slice.
    const id = await resolveItemId(ctx.db, input.id);

    // The slice and the total length come from one statement so they
    // describe the same read of the row — computing `totalLength` from a
    // second query could disagree with the row the slice was actually cut
    // from if a write landed in between. `SUBSTRING` is 1-indexed in
    // Postgres, so the zero-based `offset` this operation's own input
    // documents is shifted by one at the query boundary, not at the
    // schema boundary — the caller-facing contract stays zero-based, which
    // is the ordinary meaning of "offset".
    // `$2`/`$3` are cast to `::int` explicitly — the driver sends a
    // JavaScript number as `bigint` by default, and Postgres's `SUBSTRING`
    // has no `(text, bigint, bigint)` overload, only `(text, int, int)`. Left
    // uncast this fails outright with `42883`, caught only by the DB-backed
    // suite (`item-body-operation.test.ts`) — the mock-driver test in
    // `get-item-history`'s style would not see it, because a stub that
    // returns canned rows never asks Postgres to resolve the overload.
    // `LENGTH(chunk)` is selected alongside the chunk itself — the same
    // statement that cut the slice also measures it, in the same
    // Postgres-character unit `SUBSTRING` and `LENGTH("body")` already use.
    // Measuring the chunk with a JavaScript string's own `.length` counts
    // UTF-16 code units instead, which overcounts any character outside the
    // Basic Multilingual Plane relative to the Postgres-character offset
    // the next `SUBSTRING` call needs — see the module header.
    const rows = await ctx.db.$queryRawUnsafe<RawBodyRow[]>(
      `SELECT chunk, LENGTH(chunk) AS "chunkLength", "totalLength" FROM (
         SELECT SUBSTRING("body" FROM $2::int FOR $3::int) AS chunk, LENGTH("body") AS "totalLength"
         FROM "Item" WHERE "id" = $1
       ) AS page`,
      id,
      input.offset + 1,
      input.limit,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }

    const totalLength = Number(row.totalLength);
    const chunkLength = Number(row.chunkLength);
    const nextOffset = input.offset + chunkLength;
    const hasMore = nextOffset < totalLength;
    return {
      chunk: row.chunk,
      offset: input.offset,
      totalLength,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    };
  },
});
