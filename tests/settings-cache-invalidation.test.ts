// A settings write must be visible to the very next read in the same
// process — with no sleep, and without waiting out the cache's revalidation
// interval.
//
// `cache.ts` documents that as the writing process's own obligation ("the
// process that has just written a setting calls this rather than waiting out
// its own revalidation interval to observe its own write"), and nothing was
// discharging it: no write path called `invalidate()`. So a setting written
// through any adapter could stay stale for up to `DEFAULT_REVALIDATE_AFTER_MS`
// (3s) in the process that wrote it. That is a correctness surprise for
// exactly the flows settings exist to control, and it is also a flaky-test
// source — invisible to any test slower than the interval, which is most of
// them.
//
// Timing is deliberately not part of the assertion. A test that wrote,
// slept, and observed the new value would pass with no fix at all; these
// read back immediately, so only invalidation can make them pass.
//
// Runs against a real Postgres, driving the real route handlers, because the
// claim is about the process-global cache in `service/live.ts` and the
// singleton it wires. Skips without TEST_DATABASE_URL, the same convention
// as every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("a settings write is visible to the next read, with no sleep", () => {
  const dbName = scratchDatabaseName("settings_cache_invalidation");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let collectionRoute: typeof import("@/app/api/settings/route");
  let keyRoute: typeof import("@/app/api/settings/[key]/route");
  let live: typeof import("@/lib/service/live");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // Same ordering constraint the other route tests document: point
    // DATABASE_URL at the scratch database before importing anything that
    // reaches `service/live.ts`'s process-global singleton.
    process.env.DATABASE_URL = scratchUrl;
    collectionRoute = await import("@/app/api/settings/route");
    keyRoute = await import("@/app/api/settings/[key]/route");
    live = await import("@/lib/service/live");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function jsonRequest(url: string, method: string, body?: unknown): Request {
    return new Request(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function putSetting(key: string, value: unknown): Promise<Response> {
    return keyRoute.PUT(jsonRequest(`http://localhost/api/settings/${key}`, "PUT", { value }), {
      params: Promise.resolve({ key }),
    });
  }

  async function readSetting(key: string): Promise<unknown> {
    const response = await keyRoute.GET(new Request(`http://localhost/api/settings/${key}`), {
      params: Promise.resolve({ key }),
    });
    return ((await response.json()) as { value: unknown }).value;
  }

  /** Warms the cache so a held snapshot exists to go stale. */
  async function warmCache(): Promise<void> {
    await live.settingsCache.get();
    expect(live.settingsCache.peek()).not.toBeNull();
  }

  it("PUT then read observes the new value immediately", async () => {
    await warmCache();

    const response = await putSetting("budget.enabled", true);
    expect(response.status).toBe(200);

    // The assertion the bug report asked for. Without invalidation the
    // snapshot held above is still current for up to 3s, and the resolver
    // serves it — so this reads `false`, the registry default.
    await expect(
      live.settingsCache.get().then((snapshot) => snapshot.values["budget.enabled"]),
    ).resolves.toBe(true);
  });

  it("drops the held snapshot on a successful write", async () => {
    await warmCache();
    await putSetting("budget.enabled", false);

    // `peek()` reads the held snapshot without a database round trip, so
    // this distinguishes "invalidated" from "happened to be rebuilt".
    // Deleting the `settingsCache.invalidate()` call makes this fail.
    expect(live.settingsCache.peek()).toBeNull();
  });

  it("DELETE invalidates too — clearing an override is a change like any other", async () => {
    await putSetting("budget.enabled", true);
    await warmCache();

    const response = await keyRoute.DELETE(
      new Request("http://localhost/api/settings/budget.enabled", { method: "DELETE" }),
      { params: Promise.resolve({ key: "budget.enabled" }) },
    );
    expect(response.status).toBe(200);

    expect(live.settingsCache.peek()).toBeNull();
    // Back to the registry default, observed with no sleep.
    expect(await readSetting("budget.enabled")).toBe(false);
  });

  it("PATCH invalidates too", async () => {
    await warmCache();

    const response = await collectionRoute.PATCH(
      // `{set, value}` rather than a bare value: the operation keeps "set to
      // null" and "clear the override" distinguishable all the way to the
      // audit ledger.
      jsonRequest("http://localhost/api/settings", "PATCH", {
        settings: { "budget.enabled": { set: true, value: true } },
      }),
    );
    expect(response.status).toBe(200);

    expect(live.settingsCache.peek()).toBeNull();
  });

  it("leaves the snapshot alone when the write is refused", async () => {
    await warmCache();
    const held = live.settingsCache.peek();

    // A key this build does not declare: the operation rejects, nothing is
    // written, and the revision does not move.
    const response = await putSetting("no.such.setting", true);
    expect(response.status).toBeGreaterThanOrEqual(400);

    // Invalidating on a failed write would cost a database round trip per
    // rejected call for no benefit — the snapshot is still accurate,
    // because nothing changed. An unconditional invalidate fails this.
    expect(live.settingsCache.peek()).toBe(held);
  });

  it("leaves the snapshot alone for a read", async () => {
    await warmCache();
    const held = live.settingsCache.peek();

    await readSetting("budget.enabled");
    await collectionRoute.GET();

    // The complement that stops "invalidate on every call" from passing the
    // tests above. A read is not a change, and discarding the snapshot on
    // one would defeat the entire point of holding it.
    expect(live.settingsCache.peek()).toBe(held);
  });
});
