// MILESTONES.md #109 parts 1 and 3, and #123 — a board is many paginated
// reads, each reporting its column's true size.
//
// **What would make this file hollow.** Asserting that a page "contains"
// items proves nothing: an unbounded read contains them too. The
// load-bearing assertions are therefore about **what is absent and what is
// counted** — that a page stops at `limit` while `total` does not, that a
// withheld column reports a real total with no entries, and that the
// completed column is reachable at all. A test that only checked presence
// would go green against the very implementation both rows exist to
// replace.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticatedRequest, stubAuthEnvironment } from "./helpers/authenticated-requests";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import type { BoardOutput } from "@/lib/service/operations/get-board";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the board pages one column at a time", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("board_pagination");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let boardRoute: typeof import("@/app/api/board/route");

  const AREA = "pagination-tests";

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // The route module reaches `service/live.ts`'s process-global singleton,
    // so DATABASE_URL has to point at the scratch database before it is
    // imported — the ordering constraint tests/board-routes.test.ts documents.
    process.env.DATABASE_URL = scratchUrl;
    boardRoute = await import("@/app/api/board/route");
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    // A corpus shaped like the one #123 measured: a large completed
    // majority, a sizeable backlog, a modest live set. The proportions are
    // the point — they are what makes "completed renders empty" and "every
    // count is wrong" observable rather than theoretical.
    await seed("merged", 40);
    await seed("cancelled", 5);
    await seed("on_deck", 30);
    await seed("executing", 12);
    await seed("in_review", 3);
    await seed("blocked", 4);
    await seed("paused", 2);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /**
   * Items inserted directly at the state under test.
   *
   * Reaching `merged` legitimately needs artifacts and a whole state-machine
   * walk per item (MILESTONES.md #98), and what is being proved here is a
   * read's paging and counting, not how an item arrived anywhere.
   * `createdAt` is spread so the keyset cursor has a real ordering to walk
   * rather than a heap of identical timestamps.
   */
  async function seed(state: string, count: number): Promise<void> {
    // `Item.area` is a foreign key; the area has to exist before any item
    // can reference it.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      AREA,
    );
    for (let i = 0; i < count; i++) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Item" ("id", "kind", "title", "body", "state", "priority", "area", "originType", "driveMode", "mergeAuthority", "createdAt", "updatedAt")
         VALUES ($1, 'task'::"ItemKind", $2, 'body', $3::"ItemState", 'P2'::"Priority", $4, 'auto'::"OriginType", 'autonomous'::"DriveMode", 'agent_judgement'::"MergeAuthority", now() - ($5 || ' seconds')::interval, now())`,
        `pg-${state}-${i}`,
        `${state} item ${i}`,
        state,
        AREA,
        String(i),
      );
      // The area filter reads the `ItemArea` join table, never `Item.area`
      // — see `areaFilterCondition`. An item inserted without its join row
      // is invisible to every area-filtered read, so the fixture writes
      // both exactly as `setItemAreas` does.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        `pg-${state}-${i}`,
        AREA,
      );
    }
  }

  function board(input: Record<string, unknown> = {}): Promise<BoardOutput> {
    return runtime.call("get_board", { area: AREA, ...input }) as Promise<BoardOutput>;
  }

  describe("the default read — open work only (#109 part 2)", () => {
    it("returns in_progress and waiting, and withholds backlog and completed", async () => {
      const result = await board();
      expect(result.columns.in_progress.withheld).toBe(false);
      expect(result.columns.waiting.withheld).toBe(false);
      expect(result.columns.backlog.withheld).toBe(true);
      expect(result.columns.completed.withheld).toBe(true);
    });

    // The narrowing that distinguishes #109 from #103. A default that
    // merely excluded terminal work would return all 30 backlog items here,
    // so this assertion fails against #103's behaviour — which is exactly
    // what makes it worth having.
    it("returns no backlog entries at all, though 30 backlog items exist", async () => {
      const result = await board();
      expect(result.columns.backlog.entries).toEqual([]);
      expect(result.columns.backlog.total).toBe(30);
    });

    it("carries a notice naming the withheld columns and the calls that return them", async () => {
      const result = await board();
      expect(result.notice).toContain("30 in backlog");
      expect(result.notice).toContain("45 in completed");
      expect(result.notice).toContain('get_board with column: "completed"');
    });

    it("carries no notice when one column was asked for explicitly", async () => {
      const result = await board({ column: "backlog" });
      expect(result.notice).toBeNull();
    });
  });

  describe("counts are counted, not measured off the page (#123)", () => {
    // The defect in its original form: the completed column rendering empty
    // with a count of 0 while the store holds finished work.
    it("reports the completed column's real total even when withholding it", async () => {
      const result = await board();
      expect(result.columns.completed.entries).toEqual([]);
      expect(result.columns.completed.total).toBe(45);
    });

    it("makes the completed column reachable, with its items", async () => {
      const result = await board({ column: "completed" });
      expect(result.columns.completed.withheld).toBe(false);
      expect(result.columns.completed.entries.length).toBeGreaterThan(0);
      expect(result.columns.completed.total).toBe(45);
      for (const entry of result.columns.completed.entries) {
        expect(["merged", "cancelled"]).toContain(entry.item.state);
      }
    });

    // The assertion that catches a count derived from the page — the exact
    // shape of #123's "every column count is wrong".
    it("reports a total larger than the page when the column is paginated", async () => {
      const result = await board({ column: "backlog", limit: 5 });
      expect(result.columns.backlog.entries).toHaveLength(5);
      expect(result.columns.backlog.total).toBe(30);
    });

    it("counts each column against the same filters the page is drawn from", async () => {
      const result = await board({ column: "backlog", state: "on_deck" });
      expect(result.columns.backlog.total).toBe(30);
      // `someday` was never seeded in this area, so a filter that genuinely
      // reaches the count must produce a different number than the
      // unfiltered one — a count ignoring filters would report 30 here too.
      const empty = await board({ column: "backlog", state: "someday" });
      expect(empty.columns.backlog.total).toBe(0);
    });

    it("distinguishes an empty column from a withheld one", async () => {
      // Same empty `entries`, opposite meanings — #123's closing line.
      const withheld = await board();
      const genuinelyEmpty = await board({ column: "backlog", state: "someday" });
      expect(withheld.columns.backlog.entries).toEqual([]);
      expect(genuinelyEmpty.columns.backlog.entries).toEqual([]);
      expect(withheld.columns.backlog.withheld).toBe(true);
      expect(withheld.columns.backlog.total).toBe(30);
      expect(genuinelyEmpty.columns.backlog.withheld).toBe(false);
      expect(genuinelyEmpty.columns.backlog.total).toBe(0);
    });
  });

  describe("the cursor walks a column (#109 part 1)", () => {
    it("pages through every item exactly once, with no repeats and no gaps", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      // Bounded rather than `while (true)`: a cursor bug that never
      // terminates should fail the test, not hang the suite.
      for (let page = 0; page < 20; page++) {
        const result: BoardOutput = await board({ column: "backlog", limit: 7, cursor });
        seen.push(...result.columns.backlog.entries.map((entry) => entry.item.id));
        const next = result.columns.backlog.nextCursor;
        if (next === null) break;
        cursor = next;
      }
      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
    });

    it("reports no next cursor on the last page", async () => {
      const result = await board({ column: "waiting", limit: 200 });
      expect(result.columns.waiting.entries).toHaveLength(6);
      expect(result.columns.waiting.nextCursor).toBeNull();
    });

    it("reports a next cursor while more remains", async () => {
      const result = await board({ column: "backlog", limit: 5 });
      expect(result.columns.backlog.nextCursor).not.toBeNull();
    });

    it("bounds a page even when the caller names no limit", async () => {
      const result = await board({ column: "completed" });
      // 45 completed items exist; the default bound is below that, so an
      // unbounded read is directly observable here.
      expect(result.columns.completed.entries.length).toBeLessThan(45);
      expect(result.columns.completed.nextCursor).not.toBeNull();
    });

    // The regression this guards is subtle and was found by measurement,
    // not by reasoning: bounding *rows* does not bound *size* (#107), so the
    // slim projection's default page is far too many whole records. An
    // implementation that used one default for both shapes passes every
    // row-count assertion in this file while returning a payload several
    // times over any sensible ceiling.
    it("uses a smaller default page for whole records than for slim cards", async () => {
      const slim = await board({ column: "backlog" });
      const full = await board({ column: "backlog", full: true });
      expect(full.columns.backlog.entries.length).toBeLessThan(slim.columns.backlog.entries.length);
      // And the size, which is the thing that actually matters, follows.
      expect(JSON.stringify(full).length).toBeLessThan(40_000);
    });

    it("still honours an explicit limit in the full projection", async () => {
      const result = await board({ column: "backlog", full: true, limit: 10 });
      expect(result.columns.backlog.entries).toHaveLength(10);
    });

    it("refuses a limit above the ceiling rather than silently capping it", async () => {
      await expect(board({ column: "backlog", limit: 5000 })).rejects.toMatchObject({
        code: "invalid_input",
      });
    });
  });

  describe("the HTTP adapter carries the same controls", () => {
    async function get(query: string): Promise<{ board: BoardOutput }> {
      const response = await boardRoute.GET(
        authenticatedRequest(`http://localhost/api/board?area=${AREA}&${query}`),
      );
      return (await response.json()) as { board: BoardOutput };
    }

    it("pages a named column over HTTP", async () => {
      const body = await get("column=backlog&limit=4");
      expect(body.board.columns.backlog.entries).toHaveLength(4);
      expect(body.board.columns.backlog.total).toBe(30);
      expect(body.board.columns.backlog.nextCursor).not.toBeNull();
    });

    it("reaches the completed column over HTTP", async () => {
      const body = await get("column=completed&limit=3");
      expect(body.board.columns.completed.entries).toHaveLength(3);
      expect(body.board.columns.completed.total).toBe(45);
    });

    it("withholds backlog and completed on an unfiltered HTTP read, with the notice", async () => {
      const body = await get("");
      expect(body.board.columns.backlog.withheld).toBe(true);
      expect(body.board.notice).toContain("backlog");
    });

    it("passes the cursor through, so a second page differs from the first", async () => {
      const first = await get("column=backlog&limit=4");
      const cursor = first.board.columns.backlog.nextCursor;
      const second = await get(`column=backlog&limit=4&cursor=${cursor}`);
      const firstIds = first.board.columns.backlog.entries.map((entry) => entry.item.id);
      const secondIds = second.board.columns.backlog.entries.map((entry) => entry.item.id);
      expect(secondIds).not.toEqual(firstIds);
      for (const id of secondIds) expect(firstIds).not.toContain(id);
    });
  });
});
