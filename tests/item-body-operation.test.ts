// `get_item_body` against a real Postgres — row 977dc07e.
//
// **Why a real database.** `SUBSTRING`'s 1-indexing and `LENGTH`'s
// character counting are Postgres behaviour, not this module's own code —
// a stub returning canned strings would prove nothing about the offset
// arithmetic the handler leans on. The oversized-body reproduction below
// also needs a row Postgres actually stores and actually measures the
// `LENGTH` of, which is the property under test.
//
// **Every walking loop below advances by `nextOffset`, never by
// `offset + page.chunk.length`.** `LENGTH` counts Postgres characters; a
// JavaScript string's own `.length` counts UTF-16 code units, and the two
// disagree on any character outside the Basic Multilingual Plane. A walk
// that advanced by the JS length would silently skip content on a body
// containing one — "the non-BMP body walk reassembles exactly" below is
// the test that would have caught it, and does.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner, isServiceError } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import {
  MAX_BODY_CHUNK_CHARS,
  type GetItemBodyOutput,
} from "@/lib/service/operations/get-item-body";
import {
  MAX_RESPONSE_CHARS,
  RESPONSE_TOO_LARGE_GUARD,
  responseSize,
  wireCopiesFor,
} from "@/lib/service/response-size";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_item_body against Postgres", () => {
  const dbName = scratchDatabaseName("item_body");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(
    body: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    return runtime.call("create_item", {
      title: "x",
      body,
      area: "item-body-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string }>;
  }

  async function bodyOf(
    input: Record<string, unknown>,
    caller?: { transport: string },
  ): Promise<GetItemBodyOutput> {
    // `caller` is threaded through because the response-size guard is
    // surface-aware: only a caller on MCP gets the 2x wire multiplier, and
    // the ceiling tests below are only meaningful with it applied.
    return (await runtime.call(
      "get_item_body",
      input,
      caller ? { caller } : {},
    )) as GetItemBodyOutput;
  }

  describe("reading a normal body", () => {
    it("refuses an id that does not exist", async () => {
      await expect(bodyOf({ id: "no-such-item" })).rejects.toThrow(/No such item/);
    });

    it("returns the whole body in one page when it fits", async () => {
      const item = await createItem("hello world");
      const page = await bodyOf({ id: item.id });
      expect(page.chunk).toBe("hello world");
      expect(page.offset).toBe(0);
      expect(page.totalLength).toBe("hello world".length);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeNull();
    });

    it("starts at the given offset, not the beginning", async () => {
      const item = await createItem("0123456789");
      const page = await bodyOf({ id: item.id, offset: 3, limit: 4 });
      expect(page.chunk).toBe("3456");
      expect(page.offset).toBe(3);
    });

    it("bounds a page at limit, however long the body is", async () => {
      const item = await createItem("x".repeat(1000));
      const page = await bodyOf({ id: item.id, limit: 100 });
      expect(page.chunk).toHaveLength(100);
    });
  });

  describe("hasMore, computed rather than inferred from a short page", () => {
    it("is true while a later offset would return more", async () => {
      const item = await createItem("0123456789");
      const page = await bodyOf({ id: item.id, limit: 4 });
      expect(page.chunk).toHaveLength(4);
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(4);
    });

    it("is false once offset + chunk reaches the end, even on the last page's full-length chunk", async () => {
      // The case the header calls out by name: a body whose length is an
      // exact multiple of `limit` still has a legitimately full-length last
      // page with nothing after it. If `hasMore` were inferred from "chunk
      // shorter than limit" rather than computed, this page would wrongly
      // read as having more.
      const item = await createItem("01234567"); // 8 chars
      const page = await bodyOf({ id: item.id, offset: 4, limit: 4 }); // exactly the tail
      expect(page.chunk).toHaveLength(4);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeNull();
    });

    it("is false for an offset already past the end — returns an empty chunk, not an error", async () => {
      const item = await createItem("short");
      const page = await bodyOf({ id: item.id, offset: 100 });
      expect(page.chunk).toBe("");
      expect(page.hasMore).toBe(false);
      expect(page.totalLength).toBe(5);
      expect(page.nextOffset).toBeNull();
    });
  });

  describe("totalLength", () => {
    it("reports the WHOLE body's length, not the page's", async () => {
      const item = await createItem("x".repeat(500));
      const page = await bodyOf({ id: item.id, limit: 50 });
      expect(page.chunk).toHaveLength(50);
      expect(page.totalLength).toBe(500);
    });
  });

  describe("walking a whole body across pages", () => {
    it("reassembles the exact original body with no gap, no repeat, no reorder", async () => {
      const original = Array.from({ length: 973 }, (_, i) => String(i % 10)).join("");
      const item = await createItem(original);

      let assembled = "";
      let offset: number | undefined = 0;
      for (let guard = 0; guard < 50 && offset !== undefined; guard++) {
        const page = await bodyOf({ id: item.id, offset, limit: 100 });
        assembled += page.chunk;
        offset = page.nextOffset ?? undefined;
      }
      expect(assembled).toBe(original);
    });

    // **The regression this row was reopened for.** `SUBSTRING`/`LENGTH`
    // count Postgres characters; a JS string's `.length` counts UTF-16 code
    // units, and the two disagree on any character outside the Basic
    // Multilingual Plane. A walk that advanced `offset` by
    // `page.chunk.length` instead of by `page.nextOffset` overshot by one
    // per such character consumed — reproduced against real board content
    // (rows this repository's own search turns up for "emoji") as: 107
    // pages walked, 5461 of 5580 characters delivered, 119 lost, `hasMore`
    // false while content remained. The assertion that would have caught
    // it is byte-for-byte reassembly against a body built from exactly
    // this class of character, which is what follows.
    it("the non-BMP body walk reassembles exactly — the case a UTF-16-length walk would silently lose", async () => {
      // A body deliberately weighted toward characters where UTF-16 code
      // units and Postgres characters diverge: astral emoji (2 JS units,
      // 1 Postgres character each) interleaved with ordinary ASCII, so a
      // wrong-unit walk both overshoots AND does so unevenly across pages
      // rather than by one constant fixable offset.
      const original = Array.from({ length: 400 }, (_, i) => {
        const emojis = ["🚫", "✅", "🛒", "🎉", "🔥"];
        return `${i}-${emojis[i % emojis.length]}-`;
      }).join("");
      // Confirm the fixture actually exercises the divergence before
      // trusting the rest of the test: Postgres characters must be fewer
      // than JS UTF-16 units, or this proves nothing.
      const item = await createItem(original);
      const wholeBodyProbe = await bodyOf({ id: item.id, limit: MAX_BODY_CHUNK_CHARS });
      expect(wholeBodyProbe.totalLength).toBeLessThan(original.length);

      let assembled = "";
      let offset: number | undefined = 0;
      let pages = 0;
      for (let guard = 0; guard < 200 && offset !== undefined; guard++) {
        // A small limit forces many page boundaries to fall inside runs of
        // multi-unit characters, which is where a wrong-unit walk tears.
        const page = await bodyOf({ id: item.id, offset, limit: 37 });
        pages++;
        assembled += page.chunk;
        offset = page.nextOffset ?? undefined;
      }
      expect(pages).toBeGreaterThan(1);
      expect(assembled).toBe(original);
    });
  });

  describe("reproducing the row this operation exists to fix", () => {
    // The actual failure row 977dc07e names: a body over the response-size
    // ceiling is refused by both `get_item` and `get_item_detail`, with no
    // other read in the registry that reaches the body instead.
    it("get_item and get_item_detail both refuse a body over the ceiling, exactly as filed", async () => {
      const bigBody = "x".repeat(MAX_RESPONSE_CHARS + 50_000);
      const item = await createItem(bigBody, { area: "item-body-reproduction" });

      const fromGetItem = await runtime
        .call("get_item", { id: item.id, full: true })
        .catch((caught: unknown) => caught);
      expect(isServiceError(fromGetItem)).toBe(true);
      expect((fromGetItem as { guard?: string }).guard).toBe(RESPONSE_TOO_LARGE_GUARD);

      const fromDetail = await runtime
        .call("get_item_detail", { id: item.id })
        .catch((caught: unknown) => caught);
      expect(isServiceError(fromDetail)).toBe(true);
      expect((fromDetail as { guard?: string }).guard).toBe(RESPONSE_TOO_LARGE_GUARD);
    });

    it("get_item_body reaches the same oversized body that both other reads refuse", async () => {
      const bigBody = "x".repeat(MAX_RESPONSE_CHARS + 50_000);
      const item = await createItem(bigBody, { area: "item-body-reproduction" });

      // Confirm both other reads still refuse this exact item (guards against
      // this test silently passing because the fixture stopped overflowing).
      await expect(runtime.call("get_item", { id: item.id, full: true })).rejects.toMatchObject({
        guard: RESPONSE_TOO_LARGE_GUARD,
      });

      // Walk the whole thing through get_item_body and reassemble it.
      let assembled = "";
      let offset: number | undefined = 0;
      let pages = 0;
      for (let guard = 0; guard < 100 && offset !== undefined; guard++) {
        const page = await bodyOf({ id: item.id, offset });
        pages++;
        assembled += page.chunk;
        expect(page.totalLength).toBe(bigBody.length);
        offset = page.nextOffset ?? undefined;
      }
      expect(assembled).toBe(bigBody);
      // More than one page — proof this is actually windowing, not one call
      // that happened to fit.
      expect(pages).toBeGreaterThan(1);
    });
  });

  describe("every page this operation returns stays under the response-size ceiling", () => {
    // The property that would make this operation a way around the cap
    // rather than a real remedy: every default-shaped page it returns must
    // itself pass the guard, on every surface, including the doubling one.
    //
    // **The direct runtime call above this file uses does not itself apply
    // the MCP wire-copy multiplier** — `enforceResponseSize` is surface-aware
    // and `runtime.call` carries no transport, so a page that would be
    // refused on MCP specifically could still return here without throwing.
    // This test does not rely on that call throwing; it measures the actual
    // serialised-and-doubled size directly, the same arithmetic
    // `enforceResponseSize` itself performs, and asserts the number rather
    // than inferring safety from an absence of errors.
    it("the default page's serialised, MCP-doubled size stays under the ceiling", async () => {
      const bigBody = "x".repeat(MAX_RESPONSE_CHARS * 5);
      const item = await createItem(bigBody, { area: "item-body-ceiling" });
      const page = await bodyOf({ id: item.id });
      expect(page.chunk).toHaveLength(MAX_BODY_CHUNK_CHARS);

      const payloadSize = responseSize(page);
      expect(payloadSize).not.toBeNull();
      const delivered = payloadSize! * wireCopiesFor("mcp");
      expect(delivered).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    });

    // **The ASCII test above probes the claim only where it cannot fail,
    // and this is the case that actually broke it.** `JSON.stringify`
    // expands as it serialises — a control character becomes six
    // characters (`\u001b`), a quote or newline becomes two — while
    // `MAX_BODY_CHUNK_CHARS` counts raw characters. A body dense in those
    // characters therefore produced a page that obeyed the character
    // ceiling and still breached the response cap once MCP doubled it:
    // the operation that exists to escape a size refusal, refused on its
    // own default call.
    //
    // Called through the real runtime **on the MCP surface**, so the
    // response-size guard applies the 2x wire multiplier exactly as it
    // would for an agent reading through MCP. Before the fix this call
    // rejected with `response.too_large`; the assertion is that it returns
    // a page at all, and that the page it returns measures inside the cap.
    it("a control-character-dense body still returns a page that fits, on MCP", async () => {
      // 20% ESC — the density measured at 200,158 delivered characters
      // against the 200,000 ceiling. ESC is not exotic: it is the lead
      // byte of every ANSI escape sequence in pasted terminal output,
      // which board bodies routinely carry.
      const dense = "\u001bxxxx";
      const bigBody = dense.repeat((MAX_RESPONSE_CHARS * 2) / dense.length);
      const item = await createItem(bigBody, { area: "item-body-ceiling" });

      const page = await bodyOf({ id: item.id }, { transport: "mcp-stdio" });

      const payloadSize = responseSize(page);
      expect(payloadSize).not.toBeNull();
      expect(payloadSize! * wireCopiesFor("mcp")).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
      // It shrank rather than returning nothing — a zero-length page would
      // "fit" while being useless, so the remedy must still make forward
      // progress.
      expect(page.chunk.length).toBeGreaterThan(0);
      expect(page.hasMore).toBe(true);
    });

    // The worst case the escape table allows: every character expanding
    // sixfold. This is the fixture a fixed smaller constant would have had
    // to be sized for, and the loop handles it without one.
    it("a body of pure control characters still returns a page that fits, on MCP", async () => {
      const bigBody = "\u0001".repeat(MAX_RESPONSE_CHARS);
      const item = await createItem(bigBody, { area: "item-body-ceiling" });

      const page = await bodyOf({ id: item.id }, { transport: "mcp-stdio" });

      const payloadSize = responseSize(page);
      expect(payloadSize).not.toBeNull();
      expect(payloadSize! * wireCopiesFor("mcp")).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
      expect(page.chunk.length).toBeGreaterThan(0);
    });

    // **The shrink must not cost correctness.** A narrowed page is still a
    // page: walking it by `nextOffset` has to reassemble the body exactly,
    // with no character dropped or repeated at the seam where the shrink
    // happened.
    it("a shrunk page still walks and reassembles the body exactly", async () => {
      const body = '\u001bab"c\n'.repeat(20_000);
      const item = await createItem(body, { area: "item-body-ceiling" });

      let assembled = "";
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const page: GetItemBodyOutput = await bodyOf(
          { id: item.id, offset },
          { transport: "mcp-stdio" },
        );
        assembled += page.chunk;
        offset = page.nextOffset;
        pages++;
        expect(pages).toBeLessThan(500);
      }
      expect(assembled).toBe(body);
      expect(pages).toBeGreaterThan(1);
    });

    // **A non-BMP body proves the shrink kept its unit.** Trimming the
    // chunk in JavaScript would cut by UTF-16 code unit and could land
    // mid-surrogate, yielding a lone surrogate and a `nextOffset` counted
    // in the wrong unit — the silent torn read the module header exists to
    // prevent. Re-cutting the slice in Postgres cannot do that, and this
    // is the test that would notice if it ever did.
    it("a shrunk page never splits a surrogate pair", async () => {
      // Emoji (2 UTF-16 units, 1 Postgres character) mixed with control
      // characters, so the page both expands under escaping AND straddles
      // the unit boundary.
      const body = "\u001b\u001b\u001b\u{1F600}".repeat(15_000);
      const item = await createItem(body, { area: "item-body-ceiling" });

      let assembled = "";
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const page: GetItemBodyOutput = await bodyOf(
          { id: item.id, offset },
          { transport: "mcp-stdio" },
        );
        // A high surrogate at the end, or a low surrogate at the start,
        // means the cut landed inside a pair.
        expect(/[\uD800-\uDBFF]$/.test(page.chunk)).toBe(false);
        expect(/^[\uDC00-\uDFFF]/.test(page.chunk)).toBe(false);
        assembled += page.chunk;
        offset = page.nextOffset;
        pages++;
        expect(pages).toBeLessThan(500);
      }
      expect(assembled).toBe(body);
    });

    // **An ordinary body must not pay for the pathological one.** The whole
    // reason this is a loop rather than a smaller constant is that real
    // content — measured across this repository at a worst expansion ratio
    // of 1.13, against the 2.0 needed to breach — keeps its full-size page.
    // If this fails, the fix has quietly become the shrink-everything
    // option it was deliberately chosen over.
    it("an ordinary ASCII body still gets a full-size page", async () => {
      const bigBody = "x".repeat(MAX_RESPONSE_CHARS * 5);
      const item = await createItem(bigBody, { area: "item-body-ceiling" });
      const page = await bodyOf({ id: item.id }, { transport: "mcp-stdio" });
      expect(page.chunk).toHaveLength(MAX_BODY_CHUNK_CHARS);
    });

    // The other side of the same claim, proven rather than assumed: a chunk
    // sized to HALF the ceiling — the first draft of `MAX_BODY_CHUNK_CHARS`
    // — genuinely does clear the cap once doubled, which is what makes the
    // quarter-ceiling choice a real decision and not an arbitrary margin.
    it("a half-ceiling chunk (the rejected sizing) really would have cleared the cap on MCP", () => {
      const halfCeilingPage = {
        chunk: "x".repeat(Math.floor(MAX_RESPONSE_CHARS / 2)),
        offset: 0,
        totalLength: MAX_RESPONSE_CHARS * 10,
        hasMore: true,
        nextOffset: Math.floor(MAX_RESPONSE_CHARS / 2),
      };
      const payloadSize = responseSize(halfCeilingPage);
      expect(payloadSize).not.toBeNull();
      const delivered = payloadSize! * wireCopiesFor("mcp");
      expect(delivered).toBeGreaterThan(MAX_RESPONSE_CHARS);
    });
  });

  describe("input validation", () => {
    it("refuses a limit beyond MAX_BODY_CHUNK_CHARS", async () => {
      const item = await createItem("x");
      await expect(bodyOf({ id: item.id, limit: MAX_BODY_CHUNK_CHARS + 1 })).rejects.toThrow();
    });

    it("refuses a negative offset", async () => {
      const item = await createItem("x");
      await expect(bodyOf({ id: item.id, offset: -1 })).rejects.toThrow();
    });
  });
});
