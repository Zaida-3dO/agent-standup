// The HTTP adapter's item-detail route, driven directly as a route handler
// (SCHEMA.md §22 — "call the route handler directly"), against a real
// Postgres. Same import-ordering constraint as tests/board-routes.test.ts:
// DATABASE_URL must point at the scratch database before the route module
// (which reaches `service/live.ts`'s process-global singleton) is imported.
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

describeIfDb("item detail HTTP route against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("item_detail_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let detailRoute: typeof import("@/app/api/items/[id]/detail/route");
  let itemsRoute: typeof import("@/app/api/items/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    detailRoute = await import("@/app/api/items/[id]/detail/route");
    itemsRoute = await import("@/app/api/items/route");
    prisma = createTestPrismaClient(scratchUrl);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(overrides: Record<string, unknown>): Promise<{ id: string }> {
    const response = await itemsRoute.POST(
      authenticatedRequest("http://localhost/api/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "route detail item",
          body: "x",
          area: "detail-routes",
          originType: "auto",
          ...overrides,
        }),
      }),
    );
    const payload = (await response.json()) as { item: { id: string } };
    return payload.item;
  }

  async function get(id: string, query = ""): Promise<Response> {
    return detailRoute.GET(
      authenticatedRequest(`http://localhost/api/items/${id}/detail${query}`),
      {
        params: Promise.resolve({ id }),
      },
    );
  }

  it("returns the detail under a `detail` key", async () => {
    const project = await createItem({});
    const task = await createItem({ parentId: project.id, title: "the task" });

    const response = await get(task.id);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { detail: { item: { id: string } } };
    expect(payload.detail.item.id).toBe(task.id);
  });

  it("serialises without throwing — every bigint is stringified before the boundary", async () => {
    // `NextResponse.json` throws outright on a bigint, so an unmapped event
    // id would make this route fail on any item with history.
    const project = await createItem({});
    const task = await createItem({ parentId: project.id });

    const response = await get(task.id);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      detail: { history: { id: unknown }[] };
    };
    for (const entry of payload.detail.history) {
      expect(typeof entry.id).toBe("string");
    }
  });

  it("answers 404 for an item that does not exist", async () => {
    const response = await get("no-such-item");
    expect(response.status).toBe(404);
  });

  it("passes historyLimit through to the operation", async () => {
    const project = await createItem({});
    const task = await createItem({ parentId: project.id });

    const response = await get(task.id, "?historyLimit=1");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { detail: { history: unknown[] } };
    expect(payload.detail.history.length).toBeLessThanOrEqual(1);
  });

  it("rejects a non-numeric historyLimit rather than silently using the default", async () => {
    // An adapter that swallowed a bad value would turn a caller's mistake
    // into a surprising default instead of an error naming the field.
    const project = await createItem({});
    const task = await createItem({ parentId: project.id });

    const response = await get(task.id, "?historyLimit=lots");
    expect(response.status).toBe(400);
  });
});
