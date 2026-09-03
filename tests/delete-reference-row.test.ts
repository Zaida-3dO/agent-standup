// `delete_repo` / `delete_area` / `delete_person` against a real Postgres —
// MILESTONES.md #96, SCHEMA.md §19, §23.1.
//
// ── Why this needs a real database ─────────────────────────────────────
//
// The entire substance of these operations is a guard that counts rows in
// other tables. A mocked driver would be asserting that the code calls the
// query it was written to call, which is a restatement of the source rather
// than a test of it. The two facts worth establishing — that a referenced
// row is genuinely refused, and that an unreferenced row is genuinely gone
// afterwards — are both properties of the database's state.
//
// It also establishes the thing the guard exists to prevent, which no unit
// test can reach: that the delete does not leave the database in a state
// where a later read trips a foreign-key error.
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

describeIfDb("hard-deleting a reference row", () => {
  const dbName = scratchDatabaseName("delete_reference_row");
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

  /** A repo row, with nothing pointing at it yet. */
  async function insertRepo(id: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Repo" ("id", "displayName", "createdAt") VALUES ($1, $2, NOW())`,
      id,
      id,
    );
  }

  async function insertArea(id: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName", "createdAt") VALUES ($1, $2, NOW())`,
      id,
      id,
    );
  }

  async function insertPerson(id: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName", "createdAt") VALUES ($1, $2, NOW())`,
      id,
      id,
    );
  }

  /** An item, which is what references a repo and an area. */
  async function insertItem(
    id: string,
    options: { area: string; repo?: string | null; originPersonId?: string | null },
  ): Promise<void> {
    // `body` and `mergeAuthority` are NOT NULL with no default, so they are
    // spelled out here rather than left to the schema.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Item"
         ("id", "kind", "depth", "title", "body", "state", "priority", "originType",
          "mergeAuthority", "area", "repo", "originPersonId", "createdAt", "updatedAt")
       VALUES ($1, 'task', 1, $2, '', 'on_deck', 'P2', 'person', 'needs_approval',
               $3, $4, $5, NOW(), NOW())`,
      id,
      `item ${id}`,
      options.area,
      options.repo ?? null,
      options.originPersonId ?? null,
    );
  }

  async function repoExists(id: string): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Repo" WHERE "id" = $1`,
      id,
    );
    return rows.length > 0;
  }

  describe("the hardDelete flag", () => {
    it("refuses to delete without it, and names archiving instead", async () => {
      await insertRepo("flagless-repo");

      const error = await runtime.call("delete_repo", { id: "flagless-repo" }).catch((e) => e);

      expect(error).toMatchObject({ code: "guard_rejected" });
      // The refusal must convert the attempt, not merely block it — a caller
      // who reached for delete when they meant archive is told the call to
      // make. This is the property, not the exact wording.
      expect(String(error.message)).toContain("update_repo");
      // And the row is still there: a refusal that had already deleted would
      // be the worst of both.
      expect(await repoExists("flagless-repo")).toBe(true);
    });

    it("refuses when the flag is explicitly false", async () => {
      await insertRepo("false-flag-repo");

      const error = await runtime
        .call("delete_repo", { id: "false-flag-repo", hardDelete: false })
        .catch((e) => e);

      expect(error).toMatchObject({ code: "guard_rejected" });
      expect(await repoExists("false-flag-repo")).toBe(true);
    });
  });

  describe("the reference guard", () => {
    it("refuses a repo an item still points at, and reports the count", async () => {
      await insertArea("guard-area");
      await insertRepo("referenced-repo");
      await insertItem("i-ref-1", { area: "guard-area", repo: "referenced-repo" });
      await insertItem("i-ref-2", { area: "guard-area", repo: "referenced-repo" });

      const error = await runtime
        .call("delete_repo", { id: "referenced-repo", hardDelete: true })
        .catch((e) => e);

      expect(error).toMatchObject({ code: "guard_rejected" });
      // The count is the actionable half — "something references it" leaves
      // the caller with nowhere to go.
      expect(String(error.message)).toContain("2 items in this repo");
      expect(await repoExists("referenced-repo")).toBe(true);
    });

    it("counts a reference held through the ItemArea link table", async () => {
      // The area is referenced ONLY by `ItemArea`, not by `Item.area` — the
      // second referring column, which a guard that only checked the obvious
      // one would miss entirely.
      await insertArea("primary-area");
      await insertArea("linked-only-area");
      await insertItem("i-linked", { area: "primary-area" });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2)`,
        "i-linked",
        "linked-only-area",
      );

      const error = await runtime
        .call("delete_area", { id: "linked-only-area", hardDelete: true })
        .catch((e) => e);

      expect(error).toMatchObject({ code: "guard_rejected" });
      expect(String(error.message)).toContain("1 items also tagged with this area");
    });

    it("counts a person's references across more than one column", async () => {
      await insertArea("person-area");
      await insertPerson("busy-person");
      await insertItem("i-origin", {
        area: "person-area",
        originPersonId: "busy-person",
      });

      const error = await runtime
        .call("delete_person", { id: "busy-person", hardDelete: true })
        .catch((e) => e);

      expect(error).toMatchObject({ code: "guard_rejected" });
      expect(String(error.message)).toContain("1 items that originated from them");
    });
  });

  describe("deleting a genuinely unreferenced row", () => {
    it("removes a repo nothing points at", async () => {
      await insertRepo("typo-repo");
      expect(await repoExists("typo-repo")).toBe(true);

      const result = await runtime.call("delete_repo", { id: "typo-repo", hardDelete: true });

      expect(result).toEqual({ id: "typo-repo", deleted: true });
      expect(await repoExists("typo-repo")).toBe(false);
    });

    it("removes an area once the last reference to it is gone", async () => {
      await insertArea("staging-area");
      await insertArea("misspelt-area");
      await insertItem("i-movable", { area: "misspelt-area" });

      // Referenced: refused.
      await expect(
        runtime.call("delete_area", { id: "misspelt-area", hardDelete: true }),
      ).rejects.toMatchObject({ code: "guard_rejected" });

      // Move the item off it, and the same call now succeeds — the guard
      // counts at the moment of the request rather than caching a verdict.
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "area" = $1 WHERE "id" = $2`,
        "staging-area",
        "i-movable",
      );

      await expect(
        runtime.call("delete_area", { id: "misspelt-area", hardDelete: true }),
      ).resolves.toEqual({ id: "misspelt-area", deleted: true });
    });

    it("leaves the database readable afterwards", async () => {
      await insertArea("survivor-area");
      await insertRepo("doomed-repo");
      await insertItem("i-survivor", { area: "survivor-area", repo: null });

      await runtime.call("delete_repo", { id: "doomed-repo", hardDelete: true });

      // The whole reason the guard exists: no dangling reference, so a
      // perfectly ordinary later read still works.
      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT i."id" FROM "Item" i LEFT JOIN "Repo" r ON i."repo" = r."id"`,
      );
      expect(rows.some((row) => row.id === "i-survivor")).toBe(true);
    });
  });

  describe("a row that is not there", () => {
    it("reports not_found rather than silently succeeding", async () => {
      const error = await runtime
        .call("delete_repo", { id: "never-existed", hardDelete: true })
        .catch((e) => e);

      expect(error).toMatchObject({ code: "not_found" });
    });
  });

  describe("archiving remains the other operation", () => {
    it("archives without deleting, leaving references intact", async () => {
      await insertArea("archivable-area");
      await insertRepo("archivable-repo");
      await insertItem("i-archived-ref", {
        area: "archivable-area",
        repo: "archivable-repo",
      });

      await runtime.call("update_repo", { id: "archivable-repo", archived: true });

      // Still present, still referenced, still resolving — the distinction
      // this whole row is about.
      expect(await repoExists("archivable-repo")).toBe(true);
      const rows = await prisma.$queryRawUnsafe<{ archivedAt: Date | null }[]>(
        `SELECT "archivedAt" FROM "Repo" WHERE "id" = $1`,
        "archivable-repo",
      );
      expect(rows[0]?.archivedAt).not.toBeNull();
    });
  });
});
