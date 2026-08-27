// `get_item_body` against a real Postgres — row 977dc07e.
//
// **Why a real database.** `SUBSTRING`'s 1-indexing and `LENGTH`'s
// character counting are Postgres behaviour, not this module's own code —
// a stub returning canned strings would prove nothing about the offset
// arithmetic the handler leans on. The oversized-body reproduction below
// also needs a row Postgres actually stores and actually measures the
// `LENGTH` of, which is the property under test.
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

  async function bodyOf(input: Record<string, unknown>): Promise<GetItemBodyOutput> {
    return (await runtime.call("get_item_body", input)) as GetItemBodyOutput;
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
    });

    it("is false for an offset already past the end — returns an empty chunk, not an error", async () => {
      const item = await createItem("short");
      const page = await bodyOf({ id: item.id, offset: 100 });
      expect(page.chunk).toBe("");
      expect(page.hasMore).toBe(false);
      expect(page.totalLength).toBe(5);
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
      let offset = 0;
      for (let guard = 0; guard < 50; guard++) {
        const page = await bodyOf({ id: item.id, offset, limit: 100 });
        assembled += page.chunk;
        if (!page.hasMore) break;
        offset += page.chunk.length;
      }
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
      let offset = 0;
      let pages = 0;
      for (let guard = 0; guard < 100; guard++) {
        const page = await bodyOf({ id: item.id, offset });
        pages++;
        assembled += page.chunk;
        expect(page.totalLength).toBe(bigBody.length);
        if (!page.hasMore) break;
        offset += page.chunk.length;
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
