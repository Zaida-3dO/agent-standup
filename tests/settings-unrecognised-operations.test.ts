// `remove_unrecognised_setting` and the widened `get_settings` — the
// unrecognised section MILESTONES.md #86 renders and SCHEMA.md §17.3
// describes ("listed under 'Unrecognised' on `/settings` with a remove
// action").
//
// A real database is required for the same reason tests/settings-operations
// gives: the properties under test are the revision counter moving, the
// audit event landing, and a row surviving a round trip through jsonb —
// none of which an in-memory model can prove.
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

/** A key no build declares. */
const RETIRED_KEY = "retired.setting.from.an.older.build";

describeIfDb("the unrecognised-override surface against Postgres", () => {
  const dbName = scratchDatabaseName("settings_unrecognised");
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

  async function seedRow(key: string, value: unknown): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "settings" ("key", "value", "updatedByType", "updatedById")
       VALUES ($1, $2::jsonb, 'system'::"ActorType", NULL)
       ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
      key,
      JSON.stringify(value),
    );
  }

  async function rowExists(key: string): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ key: string }[]>(
      `SELECT "key" FROM "settings" WHERE "key" = $1`,
      key,
    );
    return rows.length > 0;
  }

  async function revision(): Promise<bigint> {
    const rows = await prisma.$queryRawUnsafe<{ revision: bigint }[]>(
      `SELECT "revision" FROM "settings_revision" WHERE "id" = 1`,
    );
    return rows[0]?.revision ?? 0n;
  }

  const caller = { caller: { transport: "test" as const } };

  describe("get_settings reports what /settings has to render", () => {
    it("lists a stored row whose key the registry does not declare", async () => {
      await seedRow(RETIRED_KEY, { was: "configured" });
      const answer = await runtime.call("get_settings", {}, caller);
      const listed = answer.unrecognised.find((row) => row.key === RETIRED_KEY);
      expect(listed).toBeDefined();
      expect(listed?.storedValue).toEqual({ was: "configured" });
    });

    it("does not list a declared key among the unrecognised", async () => {
      // The partition must be exactly `isSettingKey`, or a real setting
      // would appear in a section offering to delete it as junk.
      await seedRow("items.max_depth", 4);
      const answer = await runtime.call("get_settings", {}, caller);
      expect(answer.unrecognised.map((row) => row.key)).not.toContain("items.max_depth");
      expect(answer.settings.find((s) => s.key === "items.max_depth")?.source).toBe("override");
    });

    it("carries the build constants and the bootstrap variables", async () => {
      const answer = await runtime.call("get_settings", {}, caller);
      expect(answer.constants.map((row) => row.name)).toContain("APP_VERSION");
      expect(answer.bootstrap.map((row) => row.name)).toContain("DATABASE_URL");
    });

    it("carries no bootstrap value, only whether each is set", async () => {
      const answer = await runtime.call("get_settings", {}, caller);
      const serialised = JSON.stringify(answer.bootstrap);
      // The process running this test has a real DATABASE_URL; the answer
      // must not contain it anywhere.
      expect(serialised).not.toContain("postgres://");
      for (const row of answer.bootstrap) {
        expect(typeof row.set).toBe("boolean");
        expect(Object.keys(row).sort()).toEqual(["meaning", "name", "set"]);
      }
    });
  });

  describe("removing an unrecognised row", () => {
    it("deletes the row, bumps the revision, and reports what it removed", async () => {
      await seedRow(RETIRED_KEY, 42);
      const before = await revision();

      const removed = await runtime.call(
        "remove_unrecognised_setting",
        { key: RETIRED_KEY },
        caller,
      );

      expect(removed.key).toBe(RETIRED_KEY);
      expect(removed.removedValue).toBe(42);
      expect(await rowExists(RETIRED_KEY)).toBe(false);
      // §17.2: bumped in the same transaction as every settings write.
      expect(await revision()).toBeGreaterThan(before);
    });

    it("audits the removal as a setting_change with no after-value", async () => {
      await seedRow(RETIRED_KEY, "gone");
      await runtime.call("remove_unrecognised_setting", { key: RETIRED_KEY }, caller);

      const events = await prisma.$queryRawUnsafe<{ payload: Record<string, unknown> }[]>(
        `SELECT "payload" FROM "Event"
           WHERE "type" = 'setting_change'::"EventType" AND "payload"->>'key' = $1
           ORDER BY "id" DESC LIMIT 1`,
        RETIRED_KEY,
      );
      expect(events).toHaveLength(1);
      const payload = events[0]!.payload as { from: { set: boolean }; to: { set: boolean } };
      expect(payload.from.set).toBe(true);
      expect(payload.to.set).toBe(false);
    });

    it("refuses a key the registry DOES declare, pointing at delete_setting", async () => {
      // Doing the delete anyway would skip delete_setting's rendering of the
      // key back at its default, so the page would show a value that is
      // absent from the database.
      await seedRow("items.max_depth", 4);
      await expect(
        runtime.call("remove_unrecognised_setting", { key: "items.max_depth" }, caller),
      ).rejects.toThrow(/delete_setting/);
      // And the row is untouched.
      expect(await rowExists("items.max_depth")).toBe(true);
    });

    it("refuses a key with no stored row rather than reporting a phantom success", async () => {
      // Unlike delete_setting, this is deliberately not idempotent: there is
      // no such thing as an undeclared key "at its default", so success
      // would claim it removed something that was never there.
      await expect(
        runtime.call("remove_unrecognised_setting", { key: "never.stored.anywhere" }, caller),
      ).rejects.toThrow(/No stored override row/);
    });

    it("does not move the revision when it refuses", async () => {
      const before = await revision();
      await expect(
        runtime.call("remove_unrecognised_setting", { key: "never.stored.anywhere" }, caller),
      ).rejects.toThrow();
      expect(await revision()).toBe(before);
    });

    it("leaves the row out of the next get_settings answer", async () => {
      await seedRow(RETIRED_KEY, 1);
      await runtime.call("remove_unrecognised_setting", { key: RETIRED_KEY }, caller);
      const answer = await runtime.call("get_settings", {}, caller);
      expect(answer.unrecognised.map((row) => row.key)).not.toContain(RETIRED_KEY);
    });
  });
});
