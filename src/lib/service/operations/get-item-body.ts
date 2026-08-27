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
import { MAX_RESPONSE_CHARS, responseSize, wireCopiesFor } from "../response-size";
import { surfaceForTransport, type CallSurface } from "@/lib/surfaces";

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
 *
 * **This bounds the REQUEST; it is not the guarantee about the RESPONSE —
 * and that difference is the defect this constant alone once had.** The
 * arithmetic above counts *raw body characters*, while the guard measures
 * *serialised JSON*, and `JSON.stringify` expands: `"` and a newline each
 * widen to two characters, and a control character such as `ESC` (`0x1B`,
 * the byte every ANSI-coloured paste of terminal output is full of) widens
 * to six as `\u001b`. Those are not the same quantity, so a page dense in
 * such characters breached the cap while nominally obeying this constant —
 * measured at 50,000 raw characters of 20% `ESC`, serialising to 100,079
 * and delivering 200,158 on MCP, over the 200,000 ceiling. That is the
 * operation which exists to escape a size refusal being refused on its own
 * default call.
 *
 * **Why this stayed a quarter instead of shrinking to a worst-case-proof
 * constant.** A sixteenth (12,500) would survive even a body of pure
 * control characters, but real content is nowhere near it: measured across
 * 1,090 Markdown, TypeScript and JSON files in this repository, the worst
 * expansion ratio of any of them is 1.13, and a page this size does not
 * breach until that ratio reaches 2.0. Shrinking the constant would
 * quadruple the pages every real caller walks, to defend against content
 * none of them send. So the quarter stays as the *request* bound, and
 * `fitPageToBudget` enforces the *response* bound the quarter cannot
 * express: the common case pays one serialisation and keeps its full-size
 * page, and only genuinely expanding content pays a narrower one.
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

/**
 * The output shape, built from a row in exactly one place.
 *
 * **One builder, because the loop must measure what the handler returns.**
 * `fitPageToBudget` decides whether a page fits by serialising it, and
 * that verdict is only meaningful if the object it measured is the object
 * the caller eventually receives. A second construction site — one to
 * measure, one to return — would let the two drift, and a page measured in
 * a shape lighter than the one returned is a page that passes the check
 * and then breaches the cap, silently reintroducing this whole defect.
 *
 * `chunkLength` comes off the row rather than from `chunk.length` for the
 * unit reason the module header sets out: it is a Postgres character
 * count, the same unit as `offset`, where the JavaScript string's own
 * `.length` counts UTF-16 code units and disagrees on any character
 * outside the Basic Multilingual Plane.
 */
function pageOf(row: RawBodyRow, offset: number): GetItemBodyOutput {
  const totalLength = Number(row.totalLength);
  const chunkLength = Number(row.chunkLength);
  const nextOffset = offset + chunkLength;
  const hasMore = nextOffset < totalLength;
  return {
    chunk: row.chunk,
    offset,
    totalLength,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };
}

/**
 * How much serialised payload one page may spend for a caller on `surface`.
 *
 * The guard's own arithmetic read backwards: it refuses when `payload *
 * wireCopiesFor(surface)` exceeds `MAX_RESPONSE_CHARS`, so the payload one
 * page may occupy is that ceiling divided by those wire copies. Derived
 * from the same two exports the guard uses rather than restated as a
 * literal here — a second copy of that arithmetic is a second thing to
 * update when either changes, and a stale copy fails in the unsafe
 * direction, as a page that believes it fits and does not.
 */
export function payloadBudgetFor(surface: CallSurface | undefined): number {
  return Math.floor(MAX_RESPONSE_CHARS / wireCopiesFor(surface));
}

/**
 * How much of the projected limit to actually take — deliberately under 1.
 *
 * **The direction of this error is the whole point.** The next limit is
 * projected from the overshoot ratio, and a projection that lands slightly
 * generous returns a page that breaches the cap, which is precisely the
 * bug being fixed; one that lands slightly mean costs a marginally shorter
 * page and at worst one extra iteration. Those two failures are not
 * equally bad, so the bias is toward the harmless one. The margin also
 * absorbs the envelope fields (`offset`, `totalLength`, `hasMore`,
 * `nextOffset`), whose ~79 characters the ratio alone does not model.
 *
 * **This is a tuning knob, not a safety bound, and the distinction is
 * deliberate.** Correctness does not rest on this number: the loop
 * re-measures every candidate and only returns one that actually fits, so
 * even a value *above* 1 — which projects a larger page than the overshoot
 * justifies — cannot produce an oversized response; it can only cost
 * another iteration. That was verified by hand-mutating this constant to
 * `1.02` and sweeping the fixture space: no input produced an oversized
 * page, and the iteration count moved by at most one. A test pinning that
 * one-iteration difference would be pinning noise, so none does, and this
 * paragraph records the reasoning instead — the mutant survives because it
 * is equivalent on correctness, not because the sizing is untested. What
 * *is* tested is the property that matters: `fitPageToBudget` never
 * returns a page over budget, and it converges in a bounded number of
 * round trips.
 */
const SHRINK_SAFETY = 0.98;

/**
 * The largest page that actually serialises inside `budget`.
 *
 * **Why a loop rather than a smaller constant.** See
 * `MAX_BODY_CHUNK_CHARS`'s header: that constant bounds raw characters
 * while the guard measures serialised JSON, and no single constant
 * expresses both unless sized for the pathological case, which taxes every
 * ordinary caller forever. Measuring what was actually produced is the
 * only sizing correct for both, so this asks the real question — "does
 * this exact page fit?" — of `responseSize`, the very function the guard
 * measures with, rather than of an estimate of it.
 *
 * **Why it re-queries instead of trimming the string it already holds.**
 * Trimming in JavaScript cuts by UTF-16 code unit, and the module header
 * explains why that unit is wrong here: a cut landing mid-surrogate yields
 * a lone surrogate (serialising to `\ud83d`, and not valid text a caller
 * can reassemble), and a `chunkLength` taken from the trimmed string's own
 * `.length` would put `nextOffset` in a different unit from the `offset`
 * that produced it — the silent torn read this operation exists to
 * prevent. Re-cutting the slice in Postgres keeps every count in Postgres
 * characters by construction, so the unit cannot drift however many times
 * this shrinks.
 *
 * Measured cost: 0.02ms for ASCII, which fits first time and never
 * re-queries, and 0.46ms for a body of pure control characters — against a
 * database round trip.
 */
// Exported for the suite, which counts the round trips this makes. That
// count is the whole cost argument for choosing a loop over a smaller
// constant, so it is asserted against the real function rather than
// re-derived from a copy of the arithmetic in a test.
export async function fitPageToBudget(
  budget: number,
  offset: number,
  limit: number,
  fetchPage: (limit: number) => Promise<RawBodyRow | undefined>,
): Promise<RawBodyRow | undefined> {
  let attemptedLimit = limit;
  for (;;) {
    const row = await fetchPage(attemptedLimit);
    // Nothing to size: a missing row is the caller's `NotFoundError` to
    // raise, and an empty slice cannot shrink further.
    if (!row || row.chunk.length === 0) return row;

    // Measured at the REAL offset, not at zero. `offset` and `nextOffset`
    // are numbers, and a larger one serialises to more digits — a page at
    // offset 1,000,000 is a longer payload than the same chunk at offset 0.
    // Measuring at zero would size a page slightly smaller than the one
    // actually returned, which is the "measure one shape, return another"
    // drift `pageOf`'s own header warns about: it passed the check here and
    // breached the cap downstream by exactly those few characters.
    const size = responseSize(pageOf(row, offset));
    // Unmeasurable is not oversized — `responseSize`'s own header draws
    // this distinction, and shrinking here would convert an unrelated
    // defect into a mysteriously short page.
    if (size === null || size <= budget) return row;
    // One character is the floor: below it there is no page left, and a
    // body whose single character will not fit is a condition no further
    // shrinking resolves. Returning it lets the guard refuse honestly
    // rather than looping forever.
    if (attemptedLimit <= 1) return row;

    // **Two bounds, and the second is what keeps this cheap.**
    //
    // The projection assumes the page expands *uniformly*, so it scales the
    // limit by how far over budget the page came in. That is a good guess
    // for uniform content and a poor one when the density is uneven — a
    // page whose tail is far denser than its average overshoots slightly
    // every time, and the projection then creeps down in small steps.
    // Measured on a front-loaded control-character body, that creep cost
    // **26 iterations**, and each iteration here is a database round trip
    // rather than a cheap serialisation.
    //
    // So the shrink is also floored at half the current limit. That makes
    // every iteration at least halve the remaining search space regardless
    // of what the projection guesses,
    // which bounds the loop logarithmically: the same worst case measured
    // at **3 iterations**, and the uniform cases still converge in the 1–2
    // the projection alone achieved. The projection is kept because when it
    // is right it beats bisection outright — ASCII fits on the first
    // attempt and never re-queries at all.
    const projected = Math.floor(attemptedLimit * (budget / size) * SHRINK_SAFETY);
    // Halving, which is the bisection: the loop returns the moment a page
    // fits, so the largest limit known to fit is always zero here and the
    // interval to halve is the whole of `attemptedLimit`.
    const bisected = Math.floor(attemptedLimit / 2);
    // `attemptedLimit - 1` keeps strict progress even if both bounds round
    // back to the current limit; halving covers a projection that collapses
    // to zero or below.
    const next = Math.min(projected, bisected, attemptedLimit - 1);
    attemptedLimit = Math.max(1, next > 0 ? next : Math.floor(attemptedLimit / 2));
  }
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
    // **The page is sized against what it serialises to, not against the
    // character count that was asked for.** `MAX_BODY_CHUNK_CHARS` bounds
    // the request in raw characters; the guard downstream measures
    // serialised JSON times the surface's wire copies, and JSON escaping
    // makes those two numbers diverge without limit — see that constant's
    // header for the measurement. So the requested limit is a starting
    // point, and `fitPageToBudget` narrows it until the page it produces
    // genuinely fits, re-cutting in Postgres so every count stays in
    // Postgres characters.
    //
    // Sized against THIS caller's surface, from `ctx.caller.transport` —
    // the same field `enforceResponseSize` reads to decide the refusal. A
    // page is sized for the wire it is about to travel, so a caller on a
    // non-duplicating surface is not charged for MCP's doubling.
    const budget = payloadBudgetFor(surfaceForTransport(ctx.caller.transport));
    const row = await fitPageToBudget(budget, input.offset, input.limit, async (limit) => {
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
        limit,
      );
      return rows[0];
    });
    if (!row) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }

    return pageOf(row, input.offset);
  },
});
