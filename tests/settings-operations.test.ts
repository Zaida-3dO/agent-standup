// Settings service operations against a real Postgres — SCHEMA.md §17.2,
// §17.3, §19; MILESTONES.md #78.
//
// Same shape as tests/items-operations.test.ts: a real database is required
// because the properties under test — transaction atomicity, the revision
// counter moving, JSON null surviving a round trip through jsonb — are
// exactly the things an in-memory model cannot prove.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("settings service operations against Postgres", () => {
  const dbName = scratchDatabaseName("settings_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function revision(): Promise<bigint> {
    const rows = await prisma.$queryRawUnsafe<{ revision: bigint }[]>(
      `SELECT "revision" FROM "settings_revision" WHERE "id" = 1`,
    );
    return rows[0]?.revision ?? 0n;
  }

  async function storedRow(key: string): Promise<{ key: string; value: unknown } | null> {
    const rows = await prisma.$queryRawUnsafe<{ key: string; value: unknown }[]>(
      `SELECT "key", "value" FROM "settings" WHERE "key" = $1`,
      key,
    );
    return rows[0] ?? null;
  }

  async function settingChangeEvents(
    key: string,
  ): Promise<{ payload: { key: string; from: unknown; to: unknown; batch_id: string } }[]> {
    return prisma.$queryRawUnsafe(
      `SELECT "payload" FROM "Event"
       WHERE "type" = 'setting_change'::"EventType" AND "payload"->>'key' = $1
       ORDER BY "id" ASC`,
      key,
    );
  }

  describe("get_settings", () => {
    it("returns the resolved settings, defaults included, with a revision", async () => {
      const result = (await runtime.call("get_settings", {})) as {
        settings: readonly { key: string; value: unknown; source: string }[];
        revision: string;
      };
      const maxDepth = result.settings.find((s) => s.key === "items.max_depth");
      expect(maxDepth?.value).toBe(6); // the registry default
      expect(maxDepth?.source).toBe("default");
      expect(typeof result.revision).toBe("string");
    });

    it("reports source: override for a key with a stored row", async () => {
      await runtime.call("put_setting", { key: "items.max_depth", value: 3 });
      const result = (await runtime.call("get_settings", {})) as {
        settings: readonly { key: string; value: unknown; source: string }[];
      };
      const maxDepth = result.settings.find((s) => s.key === "items.max_depth");
      expect(maxDepth?.value).toBe(3);
      expect(maxDepth?.source).toBe("override");
    });
  });

  describe("get_setting", () => {
    it("reads one key by name", async () => {
      const result = (await runtime.call("get_setting", {
        key: "liveness.stale_after_seconds",
      })) as { key: string; value: unknown };
      expect(result.key).toBe("liveness.stale_after_seconds");
      expect(result.value).toBe(900);
    });

    it("refuses a key this build does not declare", async () => {
      const error = await runtime
        .call("get_setting", { key: "not.a.real.key" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });
  });

  describe("put_setting — AC3, AC4, AC5, AC6", () => {
    it("sets an override, validated against the registry schema", async () => {
      const before = await revision();
      const result = (await runtime.call("put_setting", {
        key: "poll.interval_seconds",
        value: 120,
      })) as { value: unknown; source: string };
      expect(result.value).toBe(120);
      expect(result.source).toBe("override");

      const row = await storedRow("poll.interval_seconds");
      expect(row?.value).toBe(120);
      expect(await revision()).toBe(before + 1n);
    });

    it("refuses a value that fails the registry's schema — AC4, write-time validation", async () => {
      // A key untouched by any other test in this file, so "nothing was
      // written" can be asserted as "still no row" rather than "unchanged
      // from whatever an earlier test in the same run left it at".
      // liveness.dead_after_seconds' schema is z.number().int().positive().
      const before = await revision();
      const error = await runtime
        .call("put_setting", { key: "liveness.dead_after_seconds", value: -5 })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      // Nothing written, nothing bumped, on a refused write.
      expect(await storedRow("liveness.dead_after_seconds")).toBeNull();
      expect(await revision()).toBe(before);
    });

    it("refuses an unknown key", async () => {
      const error = await runtime
        .call("put_setting", { key: "no.such.key", value: 1 })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });

    it("stores an explicit JSON null as a real value, distinct from no row — AC6", async () => {
      const before = await revision();
      const result = (await runtime.call("put_setting", {
        key: "notify.doc",
        value: null,
      })) as { value: unknown; source: string };
      expect(result.value).toBeNull();
      expect(result.source).toBe("override");

      const row = await storedRow("notify.doc");
      expect(row).not.toBeNull();
      expect(row?.value).toBeNull(); // JSON null, a row exists
      expect(await revision()).toBe(before + 1n);
    });

    it("appends a setting_change event with the {set, value} discriminator on from/to", async () => {
      await runtime.call("put_setting", { key: "budget.enabled", value: true });
      const events = await settingChangeEvents("budget.enabled");
      const last = events[events.length - 1];
      expect(last?.payload.from).toEqual({ set: false });
      expect(last?.payload.to).toEqual({ set: true, value: true });
      expect(typeof last?.payload.batch_id).toBe("string");
    });
  });

  describe("delete_setting — AC3, AC5", () => {
    it("clears an existing override back to the registry default", async () => {
      await runtime.call("put_setting", { key: "minting.backlog_low_threshold", value: 10 });
      expect(await storedRow("minting.backlog_low_threshold")).not.toBeNull();

      const result = (await runtime.call("delete_setting", {
        key: "minting.backlog_low_threshold",
      })) as { value: unknown; source: string };
      expect(result.value).toBe(3); // the registry default
      expect(result.source).toBe("default");
      expect(await storedRow("minting.backlog_low_threshold")).toBeNull();
    });

    it("bumps settings_revision on a delete, not only on a set — AC5, the case §17.2 exists to protect", async () => {
      await runtime.call("put_setting", {
        key: "dispatch.failed_after_seconds",
        value: 60,
      });
      const afterSet = await revision();

      await runtime.call("delete_setting", { key: "dispatch.failed_after_seconds" });
      const afterDelete = await revision();

      // A max(updated_at)-based signal would not necessarily move here — a
      // delete removes a row rather than touching one, which is exactly
      // §17.2's "a delete can lower a maximum" case. The counter must still
      // strictly increase.
      expect(afterDelete).toBe(afterSet + 1n);
    });

    it("appends a setting_change event recording the clear, {set:false} on the to side", async () => {
      await runtime.call("put_setting", { key: "model_picker.enabled", value: true });
      await runtime.call("delete_setting", { key: "model_picker.enabled" });
      const events = await settingChangeEvents("model_picker.enabled");
      const last = events[events.length - 1];
      expect(last?.payload.from).toEqual({ set: true, value: true });
      expect(last?.payload.to).toEqual({ set: false });
    });

    it("is a no-op — no event, no revision bump — clearing a key with no override", async () => {
      const before = await revision();
      const beforeEvents = (await settingChangeEvents("crew.wait_poll_interval_seconds")).length;

      await runtime.call("delete_setting", { key: "crew.wait_poll_interval_seconds" });

      expect(await revision()).toBe(before);
      expect((await settingChangeEvents("crew.wait_poll_interval_seconds")).length).toBe(
        beforeEvents,
      );
    });
  });

  describe("patch_settings — AC2 (one transaction, all-or-nothing), AC5", () => {
    it("applies every key in the map in one call, with one revision bump for the batch", async () => {
      const before = await revision();
      const result = (await runtime.call("patch_settings", {
        settings: {
          "poll.interval_seconds": { set: true, value: 90 },
          "budget.enabled": { set: true, value: true },
        },
      })) as { settings: readonly { key: string; value: unknown }[] };

      expect(result.settings.map((s) => s.value).sort()).toEqual([90, true].sort());
      expect((await storedRow("poll.interval_seconds"))?.value).toBe(90);
      expect((await storedRow("budget.enabled"))?.value).toBe(true);
      // One bump for the whole call, not one per key (§19).
      expect(await revision()).toBe(before + 1n);
    });

    it("clears one key and sets another in the same call", async () => {
      await runtime.call("put_setting", { key: "poll.interval_seconds", value: 45 });
      await runtime.call("patch_settings", {
        settings: {
          "poll.interval_seconds": { set: false },
          "budget.enabled": { set: true, value: true },
        },
      });
      expect(await storedRow("poll.interval_seconds")).toBeNull();
      expect((await storedRow("budget.enabled"))?.value).toBe(true);
    });

    it("applies NONE of the map when one key is invalid — AC2, atomicity", async () => {
      // A happy-path patch proves nothing about atomicity: this seeds a
      // batch where the first key is perfectly valid and the second fails
      // its schema, and asserts the valid one was never written either.
      // Both keys are ones no other test in this file touches, so
      // "unwritten" can be asserted as "still no row" rather than depending
      // on execution order against a shared key.
      const before = await revision();
      const error = await runtime
        .call("patch_settings", {
          settings: {
            "dispatch.resume_attempts_before_blocked": { set: true, value: 5 },
            "liveness.stale_after_seconds": { set: true, value: -1 }, // fails .positive()
          },
        })
        .catch((e: unknown) => e);

      expect((error as { code: string }).code).toBe("invalid_input");
      expect(await storedRow("dispatch.resume_attempts_before_blocked")).toBeNull();
      expect(await storedRow("liveness.stale_after_seconds")).toBeNull();
      expect(await revision()).toBe(before);
    });

    it("applies NONE of the map when one key is unknown — atomicity holds for not_found too", async () => {
      const before = await revision();
      const error = await runtime
        .call("patch_settings", {
          settings: {
            "minting.backlog_low_threshold": { set: true, value: 77 },
            "no.such.key": { set: true, value: 1 },
          },
        })
        .catch((e: unknown) => e);

      expect((error as { code: string }).code).toBe("not_found");
      expect(await storedRow("minting.backlog_low_threshold")).toBeNull();
      expect(await revision()).toBe(before);
    });

    it("refuses an empty map", async () => {
      const error = await runtime.call("patch_settings", { settings: {} }).catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
    });

    it("writes one setting_change event per key sharing a single batch_id", async () => {
      await runtime.call("patch_settings", {
        settings: {
          "poll.interval_seconds": { set: true, value: 55 },
          "budget.enabled": { set: true, value: false },
        },
      });
      const pollEvents = await settingChangeEvents("poll.interval_seconds");
      const budgetEvents = await settingChangeEvents("budget.enabled");
      const pollBatch = pollEvents[pollEvents.length - 1]?.payload.batch_id;
      const budgetBatch = budgetEvents[budgetEvents.length - 1]?.payload.batch_id;
      expect(pollBatch).toBeDefined();
      expect(pollBatch).toBe(budgetBatch);
    });
  });

  describe("JSON null vs no row vs a real value — AC6, three distinct cases", () => {
    it("distinguishes: never set (default) / explicitly null / a real value", async () => {
      // Case 1: never set at all — no row.
      const neverSet = (await runtime.call("get_setting", {
        key: "visual_review.doc",
      })) as { value: unknown; source: string };
      expect(neverSet.source).toBe("default");
      expect(neverSet.value).toBeNull(); // the registry default happens to be null too

      // Case 2: explicitly set to null — a row exists, storing JSON null.
      await runtime.call("put_setting", { key: "visual_review.doc", value: null });
      const explicitNull = (await runtime.call("get_setting", {
        key: "visual_review.doc",
      })) as { value: unknown; source: string };
      expect(explicitNull.source).toBe("override"); // a row exists now
      expect(explicitNull.value).toBeNull();
      expect(await storedRow("visual_review.doc")).not.toBeNull(); // proves the row

      // Case 3: a real value.
      await runtime.call("put_setting", { key: "visual_review.doc", value: "/docs/visual.md" });
      const real = (await runtime.call("get_setting", {
        key: "visual_review.doc",
      })) as { value: unknown; source: string };
      expect(real.source).toBe("override");
      expect(real.value).toBe("/docs/visual.md");
    });
  });
});
