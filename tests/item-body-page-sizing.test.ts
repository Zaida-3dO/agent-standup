// How `get_item_body` sizes a page — the arithmetic, without a database.
//
// **Why this file exists next to `item-body-operation.test.ts`.** That file
// proves the operation's behaviour against real Postgres and is skipped
// without `TEST_DATABASE_URL`. What is proven here is the *sizing rule*
// itself: that a page is measured by what it serialises to rather than by
// how many characters were asked for, and that finding a fitting page costs
// a bounded number of database round trips. Both are properties of
// `fitPageToBudget` alone, which takes its fetcher as a parameter — so a
// counting stub can supply the rows, letting these assertions run on every
// checkout rather than only where a database is configured, and letting them
// count the round trips exactly.
//
// **The cost assertion is not decoration.** The choice of a serialise-and-
// check loop over a smaller constant rests entirely on the loop being cheap
// for ordinary content and bounded for pathological content. An
// implementation that quietly started making 26 round trips per page would
// still return correct pages and would still pass every correctness test in
// the sibling file — it would only be slow, which is exactly the kind of
// regression that survives review. So the round-trip count is pinned here.
import { describe, expect, it } from "vitest";
import {
  MAX_BODY_CHUNK_CHARS,
  fitPageToBudget,
  payloadBudgetFor,
} from "@/lib/service/operations/get-item-body";
import { MAX_RESPONSE_CHARS, responseSize, wireCopiesFor } from "@/lib/service/response-size";

/**
 * A stand-in for the database's `SUBSTRING`, counting how often it is asked.
 *
 * Slices by **code point**, not by UTF-16 code unit, because that is what
 * Postgres's `SUBSTRING`/`LENGTH` do — a stub that used the JavaScript
 * string's own indexing would model a different database and would make the
 * non-BMP assertions below vacuous.
 */
function countingFetcher(body: string) {
  const codePoints = [...body];
  const calls: number[] = [];
  return {
    calls,
    fetch: async (limit: number) => {
      calls.push(limit);
      const chunk = codePoints.slice(0, limit).join("");
      return {
        chunk,
        chunkLength: [...chunk].length,
        totalLength: codePoints.length,
      };
    },
  };
}

/** The delivered size of a page, exactly as `enforceResponseSize` computes it. */
function deliveredSize(chunk: string, offset: number, totalLength: number): number {
  const chunkLength = [...chunk].length;
  const nextOffset = offset + chunkLength;
  const hasMore = nextOffset < totalLength;
  const payload = responseSize({
    chunk,
    offset,
    totalLength,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  });
  return payload! * wireCopiesFor("mcp");
}

const MCP_BUDGET = payloadBudgetFor("mcp");

describe("payloadBudgetFor", () => {
  // The budget is the guard's own arithmetic read backwards, so it has to
  // track the guard rather than restate a number. Derived here from the same
  // two exports the guard uses, so a change to either moves both together.
  it("is the ceiling divided by the surface's wire copies", () => {
    expect(payloadBudgetFor("mcp")).toBe(Math.floor(MAX_RESPONSE_CHARS / wireCopiesFor("mcp")));
    // MCP duplicates, so its budget must be strictly the smaller one — this
    // is the whole reason the sizing is surface-aware.
    expect(payloadBudgetFor("mcp")).toBeLessThan(payloadBudgetFor("cli"));
  });

  it("gives a non-duplicating surface the whole ceiling", () => {
    expect(payloadBudgetFor("cli")).toBe(MAX_RESPONSE_CHARS);
    expect(payloadBudgetFor(undefined)).toBe(MAX_RESPONSE_CHARS);
  });
});

describe("fitPageToBudget", () => {
  // **The case the quarter-ceiling constant got wrong.** 50,000 raw
  // characters at 20% ESC serialise to 100,079 and deliver 200,158 on MCP,
  // over the 200,000 ceiling — a page obeying the character bound and
  // breaching the size bound. The fix is that the bound which actually
  // governs is the serialised one.
  it("shrinks a control-character-dense page until it really fits", async () => {
    const body = "\u001bxxxx".repeat(MAX_BODY_CHUNK_CHARS);
    const { fetch } = countingFetcher(body);

    const row = await fitPageToBudget(MCP_BUDGET, 0, MAX_BODY_CHUNK_CHARS, fetch);

    expect(row).toBeDefined();
    // Actually smaller than asked for — if this equalled the request, the
    // sizing would not be doing anything.
    expect(row!.chunkLength).toBeLessThan(MAX_BODY_CHUNK_CHARS);
    expect(row!.chunkLength).toBeGreaterThan(0);
    expect(deliveredSize(row!.chunk, 0, row!.totalLength)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  // The theoretical worst case: every character expanding sixfold. This is
  // the content a fixed constant would have had to be sized for.
  it("shrinks a page of pure control characters until it really fits", async () => {
    const body = "\u0001".repeat(MAX_BODY_CHUNK_CHARS * 2);
    const { fetch } = countingFetcher(body);

    const row = await fitPageToBudget(MCP_BUDGET, 0, MAX_BODY_CHUNK_CHARS, fetch);

    expect(deliveredSize(row!.chunk, 0, row!.totalLength)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(row!.chunkLength).toBeGreaterThan(0);
  });

  // **The common case must stay free.** Real content measured across this
  // repository expands by at most 1.13x against the 2.0x needed to breach,
  // so ordinary bodies must keep their full-size page AND must not pay for a
  // second query to find that out.
  it("leaves an ordinary ASCII page at full size, in a single round trip", async () => {
    const body = "x".repeat(MAX_BODY_CHUNK_CHARS * 3);
    const { calls, fetch } = countingFetcher(body);

    const row = await fitPageToBudget(MCP_BUDGET, 0, MAX_BODY_CHUNK_CHARS, fetch);

    expect(row!.chunkLength).toBe(MAX_BODY_CHUNK_CHARS);
    expect(calls).toEqual([MAX_BODY_CHUNK_CHARS]);
  });

  // **The cost argument, pinned.** Before the shrink was floored at a
  // halving, a front-loaded control-character body took 26 round trips to
  // converge, because the projection assumes uniform expansion and creeps
  // when the density is uneven. Each of those is a database query. The bound
  // is what makes a loop defensible over a smaller constant, so it is
  // asserted rather than described.
  it("converges in a few round trips even on unevenly dense content", async () => {
    // **The shape that defeats a purely proportional projection.** The
    // projection scales the limit by how far over budget the page came in,
    // which assumes the expansion is spread evenly. Here it is not: a dense
    // head of control characters followed by a long ASCII tail. Each shrink
    // removes mostly cheap tail characters, so the page stays over budget
    // and the projection creeps down in small steps.
    //
    // Measured on this exact fixture: **3 round trips with the halving
    // floor, 12 without it.** Each one is a database query in production,
    // and the loop is only defensible over a smaller constant because it is
    // cheap — so the bound is asserted, not described. The threshold sits
    // between the two measurements so that removing the floor fails here.
    const body = "\u001b".repeat(16_400) + "x".repeat(183_600);
    const { calls, fetch } = countingFetcher(body);

    const row = await fitPageToBudget(MCP_BUDGET, 0, MAX_BODY_CHUNK_CHARS, fetch);

    expect(deliveredSize(row!.chunk, 0, row!.totalLength)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  // Every shrink must make progress. A projection that rounded back to the
  // current limit would spin forever against a live database; the halving
  // floor is what forbids it.
  it("strictly shrinks the limit on every attempt", async () => {
    const body = "\u0001".repeat(MAX_BODY_CHUNK_CHARS * 2);
    const { calls, fetch } = countingFetcher(body);

    await fitPageToBudget(MCP_BUDGET, 0, MAX_BODY_CHUNK_CHARS, fetch);

    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]).toBeLessThan(calls[i - 1]!);
    }
  });

  // **Sized at the offset it will be returned at.** `offset` and
  // `nextOffset` are numbers, and a larger one serialises to more digits, so
  // a page measured at offset 0 is slightly smaller than the same page
  // returned at a large offset. Measuring at zero passed the check here and
  // breached the cap downstream by exactly two characters — caught by the
  // sibling suite's surrogate walk, and pinned here at the unit.
  it("accounts for the offset's own serialised width", async () => {
    // **Deliberately a page that lands within a few characters of the
    // budget.** An oversized page shrinks until it has slack to spare, and
    // a page with slack cannot tell the two measurements apart — the extra
    // digits vanish into tens of thousands of characters of headroom, which
    // is exactly why a roomier fixture let this defect through in the first
    // place. So this one is tuned: ASCII, so no escape expansion muddies
    // the arithmetic, and sized so the page measures 99,993 when the offset
    // is treated as zero (inside the 100,000 budget) and 100,001 at the
    // real offset (outside it).
    //
    // The offset sits INSIDE the body, so `hasMore` stays true and
    // `nextOffset` carries its full width — a page that ran to the end of
    // the body would collapse `nextOffset` to `null` and cost fewer
    // characters than the case under test.
    const tightLimit = 99_914;
    const bigOffset = 9_000_000;
    const bodyLength = bigOffset + tightLimit + 10_000;
    const calls: number[] = [];
    // Models the real query: `SUBSTRING(body FROM offset+1 FOR limit)` over
    // a body long enough that `bigOffset` is a position within it. Only the
    // page's own characters are materialised — building the whole body
    // would allocate 9MB to assert on 100KB of it.
    const fetch = async (limit: number) => {
      calls.push(limit);
      const chunkLength = Math.min(limit, bodyLength - bigOffset);
      return { chunk: "x".repeat(chunkLength), chunkLength, totalLength: bodyLength };
    };

    const row = await fitPageToBudget(MCP_BUDGET, bigOffset, tightLimit, fetch);

    // Measured with the same `offset` and `totalLength` the function itself
    // saw. Inventing different ones would measure a page the sizing never
    // claimed to produce.
    expect(deliveredSize(row!.chunk, bigOffset, row!.totalLength)).toBeLessThanOrEqual(
      MAX_RESPONSE_CHARS,
    );
    // It had to shrink to get there — proof the offset's own width was
    // counted, rather than the page happening to fit anyway.
    expect(row!.chunkLength).toBeLessThan(tightLimit);
  });

  // A page that already fits is returned untouched and costs one round trip
  // — the guarantee that this sizing is free for the content that does not
  // need it.
  it("does not re-query a page that already fits", async () => {
    const { calls, fetch } = countingFetcher("hello world");

    const row = await fitPageToBudget(MCP_BUDGET, 0, MAX_BODY_CHUNK_CHARS, fetch);

    expect(row!.chunk).toBe("hello world");
    expect(calls).toHaveLength(1);
  });

  // An empty slice — a caller reading past the end — has nothing to shrink,
  // and must not loop looking for something smaller than nothing.
  it("returns an empty slice without looping", async () => {
    const { calls, fetch } = countingFetcher("");

    const row = await fitPageToBudget(MCP_BUDGET, 0, MAX_BODY_CHUNK_CHARS, fetch);

    expect(row!.chunk).toBe("");
    expect(calls).toHaveLength(1);
  });

  // A missing row is the handler's `NotFoundError` to raise. Sizing must
  // pass it straight through rather than treating "no row" as "too big".
  it("passes a missing row straight through", async () => {
    const row = await fitPageToBudget(MCP_BUDGET, 0, MAX_BODY_CHUNK_CHARS, async () => undefined);

    expect(row).toBeUndefined();
  });
});
