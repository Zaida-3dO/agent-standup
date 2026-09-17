// An item's links, against a real Postgres.
//
// What only a database can establish, and what the pure tests beside this
// one therefore cannot:
//
//   - the `(itemId, key, url)` primary key really de-duplicates, so
//     idempotency holds against a writer that never went through
//     `normalizeLinks` (acceptance criterion 1);
//   - `search` really returns an item found ONLY by a link — the SQL
//     predicate and the application ranker agreeing end to end, which is the
//     whole measured point of the feature (criterion 3);
//   - the read path really carries links back on every item read.
//
// Each rejection case names, in a comment above it, a single source change
// that would make it pass wrongly.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ItemLink {
  key: string;
  url: string;
}

interface Created {
  id: string;
  links: ItemLink[];
  title: string;
}

describeIfDb("item links", () => {
  const dbName = scratchDatabaseName("item_links");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function base(title: string) {
    return { title, body: "The brief.", area: "web", originType: "auto" as const };
  }

  async function call(name: string, input: unknown): Promise<Created> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(name, input)) as Created;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function rejectionOf(name: string, input: unknown): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (runtime.call as any)(name, input).catch((e: unknown) => e);
  }

  /** The `ItemLink` rows for an item, read straight from the table. */
  async function storedLinks(itemId: string): Promise<ItemLink[]> {
    return prisma.$queryRawUnsafe<ItemLink[]>(
      `SELECT "key", "url" FROM "ItemLink" WHERE "itemId" = $1 ORDER BY "key", "url"`,
      itemId,
    );
  }

  describe("writing links", () => {
    it("stores the links a create supplies, and reads them back", async () => {
      const item = await call("create_project", {
        ...base("Carries pointers"),
        links: [
          { key: "slack", url: "https://chat.example.test/archives/C1/p1" },
          { key: "ticket", url: "https://tracker.example.test/browse/T-1" },
        ],
      });

      expect(item.links).toEqual([
        { key: "slack", url: "https://chat.example.test/archives/C1/p1" },
        { key: "ticket", url: "https://tracker.example.test/browse/T-1" },
      ]);
      expect(await storedLinks(item.id)).toHaveLength(2);
    });

    // Fails if `insertItem` stops calling `setItemLinks` — the create would
    // return the links it was handed while the table stayed empty, which is
    // the shape of bug a response-only assertion cannot see.
    it("really writes rows, not just an echo of the input", async () => {
      const item = await call("create_project", {
        ...base("Writes rows"),
        links: [{ key: "doc", url: "coda://docs/d1/rows/r1" }],
      });
      expect(await storedLinks(item.id)).toEqual([{ key: "doc", url: "coda://docs/d1/rows/r1" }]);
    });

    it("accepts an item with no links at all, returning an empty list", async () => {
      const item = await call("create_project", base("No pointers"));
      expect(item.links).toEqual([]);
      expect(await storedLinks(item.id)).toEqual([]);
    });

    it("carries an item's links onto get_item", async () => {
      const created = await call("create_project", {
        ...base("Read back in full"),
        links: [{ key: "pr", url: "https://forge.example.test/org/repo/pull/1" }],
      });
      const read = await call("get_item", { id: created.id, full: true });
      expect(read.links).toEqual([
        { key: "pr", url: "https://forge.example.test/org/repo/pull/1" },
      ]);
    });
  });

  describe("de-duplication is the database's, not the write path's", () => {
    // **Acceptance criterion 1, at the layer that actually guarantees it.**
    // `normalizeLinks` already collapses a duplicate before it reaches SQL,
    // so a test going through the operation cannot tell a real constraint
    // from an application check. This inserts twice DIRECTLY, bypassing the
    // service entirely.
    //
    // Fails if the primary key is narrowed to `(itemId)` or `(itemId, key)`
    // — the second insert would then conflict on a different tuple and the
    // second row of a legitimate pair would vanish — or if it is dropped, in
    // which case both duplicate rows persist.
    it("is idempotent on (key, url) for a writer that bypasses the service", async () => {
      const item = await call("create_project", base("Direct writes"));
      const insert = `INSERT INTO "ItemLink" ("itemId", "key", "url") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`;

      await prisma.$executeRawUnsafe(insert, item.id, "slack", "https://example.test/t");
      await prisma.$executeRawUnsafe(insert, item.id, "slack", "https://example.test/t");
      await prisma.$executeRawUnsafe(insert, item.id, "slack", "https://example.test/t");

      expect(await storedLinks(item.id)).toEqual([{ key: "slack", url: "https://example.test/t" }]);
    });

    // The other half of what the composite key means. Fails if the key is
    // narrowed to `(itemId, key)`: these would collide and an item could
    // never carry two docs, which the motivating corpus does on nine items.
    it("keeps one key against several urls", async () => {
      const item = await call("create_project", {
        ...base("Three docs"),
        links: [
          { key: "doc", url: "https://example.test/1" },
          { key: "doc", url: "https://example.test/2" },
          { key: "doc", url: "https://example.test/3" },
        ],
      });
      expect(await storedLinks(item.id)).toHaveLength(3);
    });

    // Fails if the key is narrowed to `(itemId, url)`.
    it("keeps one url under several keys", async () => {
      const item = await call("create_project", {
        ...base("One page, two claims"),
        links: [
          { key: "escalation", url: "https://example.test/x" },
          { key: "ticket", url: "https://example.test/x" },
        ],
      });
      expect(await storedLinks(item.id)).toHaveLength(2);
    });

    // A genuine constraint refuses a true duplicate rather than silently
    // absorbing it. `ON CONFLICT DO NOTHING` is what makes the insert above
    // idempotent; without it the database must raise.
    it("refuses a true duplicate when the insert does not opt out", async () => {
      const item = await call("create_project", base("Bare insert"));
      const bare = `INSERT INTO "ItemLink" ("itemId", "key", "url") VALUES ($1, $2, $3)`;
      await prisma.$executeRawUnsafe(bare, item.id, "pr", "https://example.test/p");
      await expect(
        prisma.$executeRawUnsafe(bare, item.id, "pr", "https://example.test/p"),
      ).rejects.toThrow();
    });

    it("cascades: deleting an item removes its links", async () => {
      const item = await call("create_project", {
        ...base("Goes away"),
        links: [{ key: "slack", url: "https://example.test/gone" }],
      });
      await prisma.$executeRawUnsafe(`DELETE FROM "Item" WHERE "id" = $1`, item.id);
      expect(await storedLinks(item.id)).toEqual([]);
    });
  });

  describe("updating links", () => {
    it("writes the whole set, so an edit states every link the item has", async () => {
      const item = await call("create_project", {
        ...base("Set is rewritten"),
        links: [{ key: "old", url: "https://example.test/old" }],
      });
      await call("update_item", {
        id: item.id,
        links: [{ key: "new", url: "https://example.test/new" }],
      });
      expect(await storedLinks(item.id)).toEqual([{ key: "new", url: "https://example.test/new" }]);
    });

    // Fails if `links: []` were treated as "no change" — there would then be
    // no way to remove a link recorded in error.
    it("clears every link when given an empty list", async () => {
      const item = await call("create_project", {
        ...base("Cleared"),
        links: [{ key: "wrong", url: "https://example.test/wrong" }],
      });
      await call("update_item", { id: item.id, links: [] });
      expect(await storedLinks(item.id)).toEqual([]);
    });

    // Fails if the field stopped being optional, or if an omitted `links`
    // were read as an empty set — every ordinary edit would then silently
    // wipe an item's pointers.
    it("leaves links untouched when the edit does not mention them", async () => {
      const item = await call("create_project", {
        ...base("Untouched"),
        links: [{ key: "keep", url: "https://example.test/keep" }],
      });
      await call("update_item", { id: item.id, title: "Renamed" });
      expect(await storedLinks(item.id)).toEqual([
        { key: "keep", url: "https://example.test/keep" },
      ]);
    });

    it("refuses an executable scheme on update, leaving the stored set alone", async () => {
      const item = await call("create_project", {
        ...base("Refused edit"),
        links: [{ key: "good", url: "https://example.test/good" }],
      });
      const error = await rejectionOf("update_item", {
        id: item.id,
        links: [{ key: "bad", url: "javascript:alert(1)" }],
      });
      expect(error).toBeInstanceOf(Error);
      expect(await storedLinks(item.id)).toEqual([
        { key: "good", url: "https://example.test/good" },
      ]);
    });

    // The transaction claim: a refused create leaves NO item behind, so a
    // caller is never told a link was rejected while the row it belonged to
    // was written anyway.
    it("writes no item at all when a create's link is refused", async () => {
      const before = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "Item" WHERE "title" = $1`,
        "Rolled back",
      );
      const error = await rejectionOf("create_project", {
        ...base("Rolled back"),
        links: [{ key: "bad", url: "data:text/html,<script>" }],
      });
      expect(error).toBeInstanceOf(Error);
      const after = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "Item" WHERE "title" = $1`,
        "Rolled back",
      );
      expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    });
  });

  describe("search reaches an item through its links", () => {
    // **The measured point of the whole feature.** Before it, 141 of 141
    // artifact rows carrying a ref had that ref nowhere in their item's body,
    // and search read item columns alone — so a pointer recorded properly was
    // findable by nothing.
    //
    // The body here deliberately does NOT contain the URL, so a pass cannot
    // come from the pre-existing body predicate. Fails if the `EXISTS`
    // subquery is removed from `search.ts`, or if the ranker stops scoring
    // links (the row would be matched and then dropped as unranked).
    it("finds an item by a url that appears nowhere in its text", async () => {
      const url = "https://chat.example.test/archives/CZZZ/p1700000000";
      const item = await call("create_project", {
        ...base("Findable by link only"),
        links: [{ key: "slack", url }],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (runtime.call as any)("search", { query: url })) as {
        matches: { id: string; matchedIn: string }[];
      };
      expect(result.matches.map((m) => m.id)).toContain(item.id);
      expect(result.matches.find((m) => m.id === item.id)!.matchedIn).toBe("link");
    });

    it("finds an item by a link key", async () => {
      const item = await call("create_project", {
        ...base("Findable by key"),
        links: [{ key: "zzdesignzz", url: "https://design.example.test/f/1" }],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (runtime.call as any)("search", { query: "zzdesignzz" })) as {
        matches: { id: string }[];
      };
      expect(result.matches.map((m) => m.id)).toContain(item.id);
    });

    it("finds an item by a fragment of a url", async () => {
      const item = await call("create_project", {
        ...base("Findable by fragment"),
        links: [{ key: "ticket", url: "https://tracker.example.test/browse/QQQ-4242" }],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (runtime.call as any)("search", { query: "QQQ-4242" })) as {
        matches: { id: string }[];
      };
      expect(result.matches.map((m) => m.id)).toContain(item.id);
    });

    it("does not return an item whose links do not match", async () => {
      await call("create_project", {
        ...base("Unrelated pointers"),
        links: [{ key: "slack", url: "https://chat.example.test/archives/CAAA/p1" }],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (runtime.call as any)("search", {
        query: "nothingmatchesthisstring",
      })) as { matches: unknown[]; notice: string };
      expect(result.matches).toEqual([]);
    });

    // Acceptance criterion 5. An empty result is ambiguous unless the notice
    // says where it did not look: a caller who recorded a reference in a
    // corpus this read never touches would otherwise be told, in effect,
    // that the reference does not exist — and re-spelling the query, the one
    // remedy an unqualified notice suggests, cannot help.
    //
    // Fails if `UNSEARCHED_CORPUS_NOTE` is dropped from the empty-result
    // branches.
    it("names what it did NOT search when nothing matched", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (runtime.call as any)("search", {
        query: "nothingmatchesthisstring",
      })) as { notice: string };

      expect(result.notice).toContain("artifacts");
      expect(result.notice).toContain("not searched");
      // And it names links as part of what it DID search.
      expect(result.notice).toContain("link");
    });
  });
});
