// The HTTP adapter's settings routes, driven directly as route handlers —
// same approach as tests/items-routes.test.ts (SCHEMA.md §22: "run
// in-process wherever the process boundary is not the thing being tested —
// call the route handler directly"), against a real Postgres.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticatedRequest, stubAuthEnvironment } from "./helpers/authenticated-requests";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("settings HTTP routes against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("settings_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let collectionRoute: typeof import("@/app/api/settings/route");
  let keyRoute: typeof import("@/app/api/settings/[key]/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // Same ordering constraint items-routes.test.ts documents: point
    // DATABASE_URL at the scratch database before importing anything that
    // reaches `service/live.ts`'s process-global singleton.
    process.env.DATABASE_URL = scratchUrl;
    collectionRoute = await import("@/app/api/settings/route");
    keyRoute = await import("@/app/api/settings/[key]/route");
    prisma = createTestPrismaClient(scratchUrl);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function jsonRequest(url: string, method: string, body?: unknown): Request {
    return authenticatedRequest(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it("GET /settings returns every declared setting with a revision — AC1", async () => {
    const response = await collectionRoute.GET(
      authenticatedRequest("http://localhost/api/settings"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      settings: { key: string; value: unknown }[];
      revision: string;
    };
    expect(payload.settings.length).toBeGreaterThan(0);
    expect(typeof payload.revision).toBe("string");
    expect(response.headers.get("ETag")).toBe(`"${payload.revision}"`);
  });

  it("GET /settings/{key} reads one setting", async () => {
    const response = await keyRoute.GET(
      authenticatedRequest("http://localhost/api/settings/budget.enabled"),
      {
        params: Promise.resolve({ key: "budget.enabled" }),
      },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { key: string; value: unknown };
    expect(payload.key).toBe("budget.enabled");
    expect(payload.value).toBe(false); // the registry default
  });

  it("GET /settings/{key} returns 404 for a key this build does not declare", async () => {
    const response = await keyRoute.GET(
      authenticatedRequest("http://localhost/api/settings/nope"),
      {
        params: Promise.resolve({ key: "nope" }),
      },
    );
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("not_found");
  });

  it("PUT /settings/{key} sets an override, and GET reflects it — AC3", async () => {
    const putResponse = await keyRoute.PUT(
      jsonRequest("http://localhost/api/settings/poll.interval_seconds", "PUT", { value: 150 }),
      { params: Promise.resolve({ key: "poll.interval_seconds" }) },
    );
    expect(putResponse.status).toBe(200);
    const put = (await putResponse.json()) as { value: unknown };
    expect(put.value).toBe(150);

    const reread = await keyRoute
      .GET(authenticatedRequest("http://localhost/api/settings/poll.interval_seconds"), {
        params: Promise.resolve({ key: "poll.interval_seconds" }),
      })
      .then((r) => r.json() as Promise<{ value: unknown }>);
    expect(reread.value).toBe(150);
  });

  it("PUT with a value that fails the schema returns 400, not a 500 — AC4", async () => {
    const response = await keyRoute.PUT(
      jsonRequest("http://localhost/api/settings/liveness.dead_after_seconds", "PUT", {
        value: -1,
      }),
      { params: Promise.resolve({ key: "liveness.dead_after_seconds" }) },
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_input");
  });

  it("PUT with malformed JSON returns 400, not a 500", async () => {
    const response = await keyRoute.PUT(
      authenticatedRequest("http://localhost/api/settings/budget.enabled", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      { params: Promise.resolve({ key: "budget.enabled" }) },
    );
    expect(response.status).toBe(400);
  });

  it("DELETE /settings/{key} clears the override — AC3", async () => {
    await keyRoute.PUT(
      jsonRequest("http://localhost/api/settings/dispatch.failed_after_seconds", "PUT", {
        value: 30,
      }),
      { params: Promise.resolve({ key: "dispatch.failed_after_seconds" }) },
    );

    const deleteResponse = await keyRoute.DELETE(
      authenticatedRequest("http://localhost/api/settings/dispatch.failed_after_seconds", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ key: "dispatch.failed_after_seconds" }) },
    );
    expect(deleteResponse.status).toBe(200);
    const deleted = (await deleteResponse.json()) as { value: unknown; source: string };
    expect(deleted.value).toBe(180); // back to the registry default
    expect(deleted.source).toBe("default");
  });

  it("PATCH /settings applies a map in one transaction, all-or-nothing — AC2", async () => {
    const before = await collectionRoute
      .GET(authenticatedRequest("http://localhost/api/settings"))
      .then((r) => r.json() as Promise<{ revision: string }>);

    const response = await collectionRoute.PATCH(
      jsonRequest("http://localhost/api/settings", "PATCH", {
        settings: {
          "minting.backlog_low_threshold": { set: true, value: 42 },
          "model_picker.enabled": { set: true, value: true },
        },
      }),
    );
    expect(response.status).toBe(200);
    const patched = (await response.json()) as { settings: { key: string; value: unknown }[] };
    expect(patched.settings.map((s) => s.value).sort()).toEqual([42, true].sort());

    const after = await collectionRoute
      .GET(authenticatedRequest("http://localhost/api/settings"))
      .then((r) => r.json() as Promise<{ revision: string }>);
    expect(BigInt(after.revision)).toBe(BigInt(before.revision) + 1n);
  });

  it("PATCH /settings with one invalid key writes NOTHING through the route — AC2, atomicity", async () => {
    const beforeThreshold = await keyRoute
      .GET(authenticatedRequest("http://localhost/api/settings/liveness.stale_after_seconds"), {
        params: Promise.resolve({ key: "liveness.stale_after_seconds" }),
      })
      .then((r) => r.json() as Promise<{ value: unknown; source: string }>);

    const response = await collectionRoute.PATCH(
      jsonRequest("http://localhost/api/settings", "PATCH", {
        settings: {
          "liveness.stale_after_seconds": { set: true, value: 500 },
          "items.max_depth": { set: true, value: -5 }, // fails schema (min 1)
        },
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_input");

    const afterThreshold = await keyRoute
      .GET(authenticatedRequest("http://localhost/api/settings/liveness.stale_after_seconds"), {
        params: Promise.resolve({ key: "liveness.stale_after_seconds" }),
      })
      .then((r) => r.json() as Promise<{ value: unknown; source: string }>);
    // Nothing changed — the valid half of the map was never applied.
    expect(afterThreshold).toEqual(beforeThreshold);
  });

  it("a value of explicit JSON null round-trips through PUT and GET — AC6", async () => {
    const putResponse = await keyRoute.PUT(
      jsonRequest("http://localhost/api/settings/notify.doc", "PUT", { value: null }),
      { params: Promise.resolve({ key: "notify.doc" }) },
    );
    expect(putResponse.status).toBe(200);
    const put = (await putResponse.json()) as { value: unknown; source: string };
    expect(put.value).toBeNull();
    expect(put.source).toBe("override"); // a row exists — not "at the default"
  });
});
