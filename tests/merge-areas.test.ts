// `merge_areas`, against a real Postgres — split from row `6b2fb637`.
//
// The behaviour under test is the de-duplication pass: an item that already
// holds BOTH the losing and the surviving area must end up holding one, not
// crash on `ItemArea`'s composite primary key `(itemId, areaId)`. That case
// — "put an item in both areas, then merge" — is the exact scenario the
// naive `UPDATE "ItemArea" SET "areaId" = $to WHERE "areaId" = $from` would
// corrupt (a primary-key collision, or a silently dropped membership under
// `ON CONFLICT DO NOTHING`), and it is the case this file exercises first
// rather than last.
//
// Each rejection/assertion names, in a comment above it, a single source
// change that would make it pass wrongly — so a test that cannot fail is
// visible as such rather than counted as coverage.
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

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface Created {
  id: string;
  area: string;
  areas: string[];
  title: string;
}

interface Rejection {
  code: string;
  fields?: string[];
  guard?: string;
  message: string;
}

interface MergeResult {
  to: { id: string; archivedAt: string | null };
  from: { id: string; archivedAt: string | null };
  itemsMerged: number;
  duplicatesResolved: number;
}

describeIfDb("merge_areas", () => {
  const dbName = scratchDatabaseName("merge_areas");
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

  function base(title: string) {
    return { title, body: "The brief.", originType: "auto" as const };
  }

  async function call(name: string, input: unknown): Promise<Created> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(name, input)) as Created;
  }

  async function callMerge(input: unknown): Promise<MergeResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)("merge_areas", input)) as MergeResult;
  }

  async function rejectionOf(name: string, input: unknown): Promise<Rejection> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await (runtime.call as any)(name, input).catch((e: unknown) => e);
    return error as Rejection;
  }

  /** The `ItemArea` rows for an item, read straight from the table. */
  async function linkedAreas(itemId: string): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<{ areaId: string }[]>(
      `SELECT "areaId" FROM "ItemArea" WHERE "itemId" = $1 ORDER BY "areaId"`,
      itemId,
    );
    return rows.map((row) => row.areaId);
  }

  /** The `Item.area` column — the primary area — read straight from the table. */
  async function primaryArea(itemId: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ area: string }[]>(
      `SELECT "area" FROM "Item" WHERE "id" = $1`,
      itemId,
    );
    return rows[0]!.area;
  }

  async function areaArchivedAt(id: string): Promise<Date | null> {
    const rows = await prisma.$queryRawUnsafe<{ archivedAt: Date | null }[]>(
      `SELECT "archivedAt" FROM "Area" WHERE "id" = $1`,
      id,
    );
    return rows[0]!.archivedAt;
  }

  async function eventsFor(itemId: string): Promise<{ type: string; payload: unknown }[]> {
    const rows = await prisma.$queryRawUnsafe<{ type: string; payload: unknown }[]>(
      `SELECT "type", "payload" FROM "Event" WHERE "itemId" = $1 ORDER BY "id" ASC`,
      itemId,
    );
    return rows;
  }

  describe("the exact collision the naive UPDATE corrupts", () => {
    // THE test this row exists for: an item already holding both `from` and
    // `to`, then merged. A naive `UPDATE "ItemArea" SET "areaId" = 'to'
    // WHERE "areaId" = 'from'` hits `ItemArea`'s composite primary key
    // `(itemId, areaId)` here, because the `to` row for this item already
    // exists — this is precisely the case that must not throw and must not
    // silently drop a row.
    it("de-duplicates an item that already holds both areas, without a constraint violation", async () => {
      const item = await call("create_project", {
        ...base("Already in both"),
        areas: ["web", "infra"],
      });
      expect(await linkedAreas(item.id)).toEqual(["infra", "web"]);

      // Fails (throws P2002 / unique violation, or the promise rejects at
      // all) if the merge is implemented as a bare UPDATE rather than a
      // delete-then-conditional-insert — this is the assertion that the
      // operation does not crash on the exact case it exists to handle.
      const result = await callMerge({ from: "infra", to: "web" });

      expect(result.duplicatesResolved).toBe(1);
      expect(result.itemsMerged).toBe(1);

      // The item ends up holding ONE area, not two, not zero. Fails if the
      // de-duplication drops both memberships (e.g. an unconditional delete
      // of `from` with no compensating insert when `to` was already absent
      // for some OTHER item in the batch) or keeps both (the merge did
      // nothing).
      expect(await linkedAreas(item.id)).toEqual(["web"]);
      expect(await primaryArea(item.id)).toBe("web");
    });

    it("still merges an item that only held the losing area (the ordinary case)", async () => {
      const item = await call("create_project", { ...base("Only losing area"), area: "infra" });

      const result = await callMerge({ from: "infra", to: "web" });
      expect(result.duplicatesResolved).toBe(0);
      expect(result.itemsMerged).toBe(1);

      // Fails if the ordinary (non-duplicate) path forgets to insert `to`
      // after deleting `from` — the item would end up in NO area at all,
      // silently violating "every item has at least one area".
      expect(await linkedAreas(item.id)).toEqual(["web"]);
      expect(await primaryArea(item.id)).toBe("web");
    });

    it("leaves an item holding neither area untouched", async () => {
      const item = await call("create_project", { ...base("Elsewhere"), area: "docs" });
      await callMerge({ from: "infra", to: "web" });

      // Fails if the merge scans ALL items instead of only those holding
      // `from` — this item's area would be rewritten to `web` too.
      expect(await primaryArea(item.id)).toBe("docs");
      expect(await linkedAreas(item.id)).toEqual(["docs"]);
    });

    it("moves the primary area only for an item whose primary WAS the losing area", async () => {
      // Primary is "extra", secondary is "infra" — so `infra` is present in
      // ItemArea but Item.area does not point at it.
      const item = await call("create_project", {
        ...base("Secondary only"),
        areas: ["extra", "infra"],
      });
      expect(await primaryArea(item.id)).toBe("extra");

      await callMerge({ from: "infra", to: "web" });

      // Fails if the merge rewrites `Item.area` unconditionally instead of
      // only when it equalled `from` — this item's primary would be
      // clobbered to `web` even though its primary was never `infra`.
      expect(await primaryArea(item.id)).toBe("extra");
      expect(await linkedAreas(item.id)).toEqual(["extra", "web"]);
    });
  });

  describe("the ledger", () => {
    it("records one field_change event per affected item, naming the area change", async () => {
      const item = await call("create_project", { ...base("Gets an event"), area: "infra" });
      await callMerge({ from: "infra", to: "web" });

      const events = await eventsFor(item.id);
      const areaChange = events.find(
        (e) => e.type === "field_change" && (e.payload as { field?: string }).field === "area",
      );
      // Fails if the merge writes rows to ItemArea/Item directly without
      // going through recordFieldChanges — the ledger would have nothing
      // explaining why this item's area changed.
      expect(areaChange).toBeDefined();
      expect((areaChange!.payload as { from: unknown; to: unknown }).from).toBe("infra");
      expect((areaChange!.payload as { from: unknown; to: unknown }).to).toBe("web");
    });

    it("writes no area-change event for an item the merge did not touch", async () => {
      const item = await call("create_project", { ...base("Untouched"), area: "docs" });
      const beforeCount = (await eventsFor(item.id)).length;
      await callMerge({ from: "infra", to: "web" });

      // Fails if the merge appends an event for every item in the system
      // rather than only the ones it actually changed — the untouched
      // item's own creation event(s) are the baseline; the merge must add
      // nothing further to them.
      expect(await eventsFor(item.id)).toHaveLength(beforeCount);
    });
  });

  describe("the losing area's fate", () => {
    it("archives the losing area rather than deleting the row", async () => {
      await call("create_project", { ...base("Seed infra"), area: "infra" });
      const result = await callMerge({ from: "infra", to: "web" });

      // Fails if the merge hard-deletes the row (the row would 404 on the
      // read below instead of coming back archived) — the reversal story
      // this row's acceptance criteria ask for depends on the row surviving.
      expect(result.from.archivedAt).not.toBeNull();
      expect(await areaArchivedAt("infra")).not.toBeNull();
    });

    it("leaves the surviving area unarchived", async () => {
      await call("create_project", { ...base("Seed web"), area: "web" });
      const result = await callMerge({ from: "infra", to: "web" });

      expect(result.to.archivedAt).toBeNull();
      expect(await areaArchivedAt("web")).toBeNull();
    });
  });

  describe("guards", () => {
    it("refuses to merge an area into itself", async () => {
      const rejection = await rejectionOf("merge_areas", { from: "web", to: "web" });
      // Fails if the same-area check is removed — the call would instead
      // proceed to a no-op merge (or worse, archive the only copy of the
      // area every affected item still needs).
      expect(rejection.code).toBe("guard_rejected");
    });

    it("refuses when the losing area does not exist", async () => {
      const rejection = await rejectionOf("merge_areas", { from: "does-not-exist", to: "web" });
      expect(rejection.code).toBe("not_found");
    });

    it("refuses when the surviving area does not exist", async () => {
      await call("create_project", { ...base("Seed infra 2"), area: "infra" });
      const rejection = await rejectionOf("merge_areas", { from: "infra", to: "does-not-exist" });
      expect(rejection.code).toBe("not_found");
    });
  });
});
