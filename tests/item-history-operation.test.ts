// `get_item_history` against a real Postgres — T24.
//
// **Why a real database.** The claim worth pinning is that the keyset
// cursor walks an append-only table without repeating or skipping a row,
// including while rows are being inserted. That is a property of the
// ordering and the `id < cursor` predicate against actual Postgres; a stub
// returning canned pages would prove nothing about either. The bigint
// stringification is the same — `id` is a real `BigInt` only when it comes
// from the driver.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import {
  getItemHistory,
  type GetItemHistoryOutput,
} from "@/lib/service/operations/get-item-history";
import type { ServiceContext } from "@/lib/service/context";
import type { ItemDetailOutput } from "@/lib/service/operations/get-item-detail";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_item_history against Postgres", () => {
  const dbName = scratchDatabaseName("item_history");
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

  async function createItem(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "history-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string }>;
  }

  /** Appends `count` notes, which is the cheapest way to grow a real ledger. */
  async function addNotes(itemId: string, count: number, prefix = "note"): Promise<void> {
    for (let index = 0; index < count; index++) {
      await runtime.call("note", {
        itemId,
        body: `${prefix}-${index}`,
        actorType: "agent",
        actorId: "tester",
      });
    }
  }

  async function historyOf(input: Record<string, unknown>): Promise<GetItemHistoryOutput> {
    return (await runtime.call("get_item_history", input)) as GetItemHistoryOutput;
  }

  /**
   * Runs the handler against a stub that records every statement, and
   * returns them.
   *
   * Direct rather than through the runtime because the question is what SQL
   * the operation *issues*, which no assertion on its return value can see
   * — the handler maps its result field by field, so a query selecting
   * columns nothing reads produces an identical response. The stub answers
   * every read with one plausible row so the handler runs to completion.
   */
  async function recordQueries(input: {
    id: string;
    full?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<string[]> {
    const queries: string[] = [];
    const db = {
      $queryRawUnsafe: async (query: string) => {
        queries.push(query);
        if (query.includes("COUNT(*)")) return [{ count: 1n }];
        if (query.includes('FROM "Item"')) return [{ id: input.id }];
        return [
          {
            id: 1n,
            ts: new Date(),
            type: "note",
            actorType: "agent",
            actorId: null,
            sessionId: null,
            headline: null,
            body: null,
            payload: null,
          },
        ];
      },
      $executeRawUnsafe: async () => 0,
    };
    await getItemHistory.handler({ db } as unknown as ServiceContext, {
      id: input.id,
      full: input.full ?? false,
      limit: input.limit ?? 50,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return queries;
  }

  describe("the page it returns", () => {
    it("refuses an id that does not exist rather than returning an empty ledger", async () => {
      await expect(historyOf({ id: "no-such-item" })).rejects.toThrow(/No such item/);
    });

    it("returns entries newest first", async () => {
      const item = await createItem({ area: "history-order" });
      await addNotes(item.id, 4, "ordered");
      const page = await historyOf({ id: item.id, limit: 50, full: true });
      const ids = page.entries.map((entry) => BigInt(entry.id));
      const sorted = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      expect(ids).toEqual(sorted);
    });

    it("bounds the page at limit, however long the ledger is", async () => {
      const item = await createItem({ area: "history-bound" });
      await addNotes(item.id, 8);
      const page = await historyOf({ id: item.id, limit: 3 });
      expect(page.entries).toHaveLength(3);
    });

    it("stringifies the bigint id, which cannot cross a JSON boundary", async () => {
      const item = await createItem({ area: "history-bigint" });
      await addNotes(item.id, 1);
      const page = await historyOf({ id: item.id, limit: 5 });
      expect(typeof page.entries[0]?.id).toBe("string");
      // The proof it survives the boundary at all: `JSON.stringify` throws
      // outright on a BigInt rather than truncating it.
      expect(() => JSON.stringify(page)).not.toThrow();
    });

    it("reads only the item it was asked about", async () => {
      const mine = await createItem({ area: "history-mine" });
      const theirs = await createItem({ area: "history-theirs" });
      await addNotes(mine.id, 2, "mine");
      await addNotes(theirs.id, 2, "theirs");
      const page = await historyOf({ id: mine.id, limit: 50, full: true });
      const bodies = page.entries.map((entry) => (entry as { body?: string | null }).body ?? "");
      expect(bodies.some((body) => body.includes("mine"))).toBe(true);
      expect(bodies.some((body) => body.includes("theirs"))).toBe(false);
    });
  });

  describe("the total", () => {
    it("counts the whole ledger, not the page — which is what makes 'page 3 of 40' sayable", async () => {
      const item = await createItem({ area: "history-total" });
      await addNotes(item.id, 6);
      const page = await historyOf({ id: item.id, limit: 2 });
      expect(page.entries).toHaveLength(2);
      // A total derived from the page would say 2.
      expect(page.total).toBeGreaterThanOrEqual(6);
    });
  });

  describe("the cursor", () => {
    it("walks the WHOLE ledger across pages with no repeats and no gaps", async () => {
      const item = await createItem({ area: "history-walk" });
      await addNotes(item.id, 9, "walk");

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 30; guard++) {
        const page: GetItemHistoryOutput = await historyOf(
          cursor === undefined ? { id: item.id, limit: 2 } : { id: item.id, limit: 2, cursor },
        );
        seen.push(...page.entries.map((entry) => entry.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // No repeats…
      expect(new Set(seen).size).toBe(seen.length);
      // …and nothing skipped: the walk saw the entire ledger.
      const total = (await historyOf({ id: item.id, limit: 1 })).total;
      expect(seen).toHaveLength(total);
    });

    it("skips no row when the ledger grows mid-walk — the reason this is keyset and not OFFSET", async () => {
      // The failure an `OFFSET` cursor has and this one does not. Page one
      // is taken, then new events are appended (which an offset would push
      // rows *past*, silently repeating them on page two), then page two is
      // taken from the cursor.
      const item = await createItem({ area: "history-grow" });
      await addNotes(item.id, 6, "before");

      const first = await historyOf({ id: item.id, limit: 3 });
      expect(first.nextCursor).not.toBeNull();

      await addNotes(item.id, 4, "after");

      const second = await historyOf({ id: item.id, limit: 3, cursor: first.nextCursor! });
      const firstIds = new Set(first.entries.map((entry) => entry.id));
      for (const entry of second.entries) {
        // With an OFFSET this assertion is what fails: the four new rows
        // would have shifted page one's rows down into page two.
        expect(firstIds.has(entry.id)).toBe(false);
      }
      // And every row on page two is genuinely older than the cursor.
      for (const entry of second.entries) {
        expect(BigInt(entry.id) < BigInt(first.nextCursor!)).toBe(true);
      }
    });

    it("reports no next cursor once the ledger is exhausted", async () => {
      const item = await createItem({ area: "history-end" });
      await addNotes(item.id, 2);
      const page = await historyOf({ id: item.id, limit: 200 });
      expect(page.nextCursor).toBeNull();
    });

    it("reports a next cursor while more remain", async () => {
      const item = await createItem({ area: "history-more" });
      await addNotes(item.id, 5);
      const page = await historyOf({ id: item.id, limit: 2 });
      expect(page.nextCursor).not.toBeNull();
      expect(page.nextCursor).toBe(page.entries[page.entries.length - 1]?.id);
    });

    it("returns nothing past the oldest entry rather than wrapping around", async () => {
      const item = await createItem({ area: "history-past-end" });
      await addNotes(item.id, 3);
      const all = await historyOf({ id: item.id, limit: 200 });
      const oldest = all.entries[all.entries.length - 1]!.id;
      const past = await historyOf({ id: item.id, limit: 10, cursor: oldest });
      expect(past.entries).toEqual([]);
      expect(past.nextCursor).toBeNull();
    });
  });

  describe("the returned shape", () => {
    it("is slim by default — no payload, no body, on EVERY entry", async () => {
      const item = await createItem({ area: "history-slim" });
      await addNotes(item.id, 3, "a body that would be returned");
      const page = await historyOf({ id: item.id, limit: 50 });
      expect(page.entries.length).toBeGreaterThan(0);
      // Every entry, not just the first: the newest event on a fresh item
      // is a `field_change` whose body is null anyway, so asserting only
      // `entries[0]` would pass against a read that returned bodies.
      for (const entry of page.entries) {
        expect(entry).not.toHaveProperty("payload");
        expect(entry).not.toHaveProperty("body");
        // …while still carrying what a timeline row actually draws.
        expect(entry).toHaveProperty("ts");
        expect(entry).toHaveProperty("type");
        expect(entry).toHaveProperty("actorType");
      }
    });

    it("does not SELECT the two unbounded columns when slim — the size bound, not just the shape", async () => {
      // The mapping below the query builds the slim object field by field,
      // so a read that selected `payload` and `body` anyway would still
      // *return* the right shape while paying the full transfer cost — and
      // payload plus body measure ~95% of an event. The response shape
      // therefore cannot detect that mistake; only the SQL can. This runs
      // the handler against a recording stub and asserts the query it
      // actually issued.
      const slimQueries = await recordQueries({ id: "some-id" });
      const selects = slimQueries.filter((query) => query.includes('FROM "Event"'));
      expect(selects.length).toBeGreaterThan(0);
      const pageQuery = selects.find((query) => query.includes("ORDER BY"));
      expect(pageQuery).toBeDefined();
      expect(pageQuery).not.toContain('"payload"');
      expect(pageQuery).not.toContain('"body"');

      // …and `full` is what asks for them back, so this is a real choice
      // rather than a column list nothing consults.
      const fullQueries = await recordQueries({ id: "some-id", full: true });
      const fullPageQuery = fullQueries
        .filter((query) => query.includes('FROM "Event"'))
        .find((query) => query.includes("ORDER BY"));
      expect(fullPageQuery).toContain('"payload"');
      expect(fullPageQuery).toContain('"body"');
    });

    it("returns payload and body on full", async () => {
      const item = await createItem({ area: "history-full" });
      await addNotes(item.id, 1, "the-note-body");
      const page = await historyOf({ id: item.id, limit: 5, full: true });
      const note = page.entries.find((entry) => entry.type === "note");
      expect(note).toBeDefined();
      expect(note).toHaveProperty("body");
      expect(String((note as { body?: string | null }).body)).toContain("the-note-body");
    });

    it("returns an ISO timestamp string, not a Date", async () => {
      const item = await createItem({ area: "history-ts" });
      await addNotes(item.id, 1);
      const entry = (await historyOf({ id: item.id, limit: 1 })).entries[0];
      expect(typeof entry?.ts).toBe("string");
      expect(entry?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("alongside get_item_detail", () => {
    it("continues exactly where the detail payload's window ended — no gap, no repeat", async () => {
      // This is the seam the Activity tab relies on: it pages from the last
      // entry the detail response carried. If the two reads disagreed about
      // ordering, a row would be skipped or shown twice at the boundary.
      const item = await createItem({ area: "history-seam" });
      await addNotes(item.id, 10, "seam");

      const detail = (await runtime.call("get_item_detail", {
        id: item.id,
        historyLimit: 4,
      })) as ItemDetailOutput;
      expect(detail.historyTruncated).toBe(true);

      const oldestShown = detail.history[detail.history.length - 1]!.id;
      const older = await historyOf({ id: item.id, limit: 4, cursor: oldestShown });

      const shownIds = new Set(detail.history.map((entry) => entry.id));
      for (const entry of older.entries) {
        expect(shownIds.has(entry.id)).toBe(false);
        expect(BigInt(entry.id) < BigInt(oldestShown)).toBe(true);
      }
      // Nothing between the two: the next entry after the window is the
      // first one this returned.
      const all = await historyOf({ id: item.id, limit: 200 });
      const allIds = all.entries.map((entry) => entry.id);
      const boundaryIndex = allIds.indexOf(oldestShown);
      expect(older.entries[0]?.id).toBe(allIds[boundaryIndex + 1]);
    });
  });

  describe("input validation", () => {
    it("refuses a limit beyond the bound every paged read in the product shares", async () => {
      const item = await createItem({ area: "history-limit" });
      await expect(historyOf({ id: item.id, limit: 201 })).rejects.toThrow();
    });

    it("refuses a cursor that is not a number as INVALID INPUT, naming the field", async () => {
      // Two things are being asserted, and the second is the one worth
      // having. Quietly ignoring an unparseable cursor would serve the
      // newest page to a caller who asked to continue from deeper in the
      // ledger — a wrong answer that looks like a right one. But it must
      // also be refused as a *caller* error: without the schema constraint
      // the value still reaches Postgres, whose `::bigint` cast fails and
      // surfaces as an internal error — reporting a typo as a server fault,
      // with no field named and nothing the caller can act on.
      const item = await createItem({ area: "history-bad-cursor" });
      await addNotes(item.id, 2);
      const error = await historyOf({ id: item.id, cursor: "not-a-number" }).catch(
        (caught: unknown) => caught,
      );
      expect((error as { code?: string }).code).toBe("invalid_input");
      expect((error as { fields?: string[] }).fields).toContain("cursor");
    });
  });
});
