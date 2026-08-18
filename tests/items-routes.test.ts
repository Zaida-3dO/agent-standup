// The HTTP adapter's items routes, driven directly as route handlers
// (SCHEMA.md §22 "Cost… run in-process wherever the process boundary is not
// the thing being tested — call the route handler directly"), against a
// real Postgres. `service/live.ts`'s exported `service` instance is process-
// global, so these tests point `DATABASE_URL` at a scratch database before
// importing anything that reaches it, then import the route modules — the
// same ordering constraint `service-transaction-db.test.ts` documents for
// installing a test operation into the shared registry.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticatedRequest, stubAuthEnvironment } from "./helpers/authenticated-requests";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("items HTTP routes against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("items_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let collectionRoute: typeof import("@/app/api/items/route");
  let itemRoute: typeof import("@/app/api/items/[id]/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // `src/lib/prisma.ts` reads DATABASE_URL from the environment at
    // construction time, and `src/lib/service/live.ts` constructs its
    // singleton on module load — so the env var must point at the scratch
    // database *before* the route modules (which import `live.ts`
    // transitively through `service.call`) are ever imported.
    process.env.DATABASE_URL = scratchUrl;
    collectionRoute = await import("@/app/api/items/route");
    itemRoute = await import("@/app/api/items/[id]/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
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

  it("POST creates an item and returns 201 with the created record", async () => {
    const response = await collectionRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        title: "Route-created",
        body: "x",
        area: "route-tests",
        originType: "auto",
      }),
    );
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { item: { id: string; title: string } };
    expect(payload.item.title).toBe("Route-created");
    expect(typeof payload.item.id).toBe("string");
  });

  it("POST with malformed JSON returns 400, not a 500", async () => {
    const response = await collectionRoute.POST(
      authenticatedRequest("http://localhost/api/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("POST with a missing required field returns 400 with the offending field named", async () => {
    const response = await collectionRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        body: "no title given",
        area: "route-tests",
        originType: "auto",
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; fields: string[] } };
    expect(payload.error.code).toBe("invalid_input");
    expect(payload.error.fields).toContain("title");
  });

  it("GET /items/{id} reads back what POST created", async () => {
    const created = await collectionRoute
      .POST(
        jsonRequest("http://localhost/api/items", "POST", {
          title: "Read via route",
          body: "x",
          area: "route-tests",
          originType: "auto",
        }),
      )
      .then((r) => r.json() as Promise<{ item: { id: string } }>);

    const response = await itemRoute.GET(
      authenticatedRequest(`http://localhost/api/items/${created.item.id}`),
      {
        params: Promise.resolve({ id: created.item.id }),
      },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { item: { title: string } };
    expect(payload.item.title).toBe("Read via route");
  });

  it("GET /items/{id} returns 404 for an id that does not exist", async () => {
    const response = await itemRoute.GET(authenticatedRequest("http://localhost/api/items/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("not_found");
  });

  it("PATCH edits a field through the route and the GET route reflects it", async () => {
    const created = await collectionRoute
      .POST(
        jsonRequest("http://localhost/api/items", "POST", {
          title: "Before patch",
          body: "x",
          area: "route-tests",
          originType: "auto",
          priority: "P2",
        }),
      )
      .then((r) => r.json() as Promise<{ item: { id: string } }>);

    const patchResponse = await itemRoute.PATCH(
      jsonRequest(`http://localhost/api/items/${created.item.id}`, "PATCH", { priority: "P0" }),
      { params: Promise.resolve({ id: created.item.id }) },
    );
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()) as { item: { priority: string } };
    expect(patched.item.priority).toBe("P0");

    // `?full=true` — `priority` is not in the slim default shape
    // (MILESTONES.md #107), and reading it back is what this test is for.
    // This also exercises the route's own threading of the opt-in: without
    // it the parameter would be dropped in the adapter and the assertion
    // would fail on `undefined`.
    const reread = await itemRoute
      .GET(authenticatedRequest(`http://localhost/api/items/${created.item.id}?full=true`), {
        params: Promise.resolve({ id: created.item.id }),
      })
      .then((r) => r.json() as Promise<{ item: { priority: string } }>);
    expect(reread.item.priority).toBe("P0");
  });

  it("PATCH on a non-existent id returns 404, not a 500 or a silent success", async () => {
    const response = await itemRoute.PATCH(
      jsonRequest("http://localhost/api/items/does-not-exist", "PATCH", { priority: "P0" }),
      { params: Promise.resolve({ id: "does-not-exist" }) },
    );
    expect(response.status).toBe(404);
  });

  it("GET /items?area= excludes items outside that area, over the actual query-string parsing", async () => {
    await collectionRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        title: "In target area",
        body: "x",
        area: "route-filter-target",
        originType: "auto",
      }),
    );
    await collectionRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        title: "In a different area",
        body: "x",
        area: "route-filter-other",
        originType: "auto",
      }),
    );

    // Same as above: `area` is only in the full record, so this asserts the
    // filter and the collection route's `?full=` threading together.
    const response = await collectionRoute.GET(
      authenticatedRequest("http://localhost/api/items?area=route-filter-target&full=true"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { items: { title: string; area: string }[] };
    expect(payload.items.length).toBe(1);
    expect(payload.items[0]?.area).toBe("route-filter-target");
  });

  it("a guard rejection surfaces as 422 through the route, not 500", async () => {
    // items.max_depth defaults to 6; build a chain to depth 7 through the
    // real HTTP route to prove the mapping table (respond.ts) reaches
    // guard_rejected -> 422, not just the service layer's own error shape.
    let parentId: string | undefined;
    for (let depth = 0; depth <= 6; depth++) {
      const created = await collectionRoute
        .POST(
          jsonRequest("http://localhost/api/items", "POST", {
            title: `route-depth-${depth}`,
            body: "x",
            area: "route-depth-guard",
            originType: "auto",
            parentId,
          }),
        )
        .then((r) => r.json() as Promise<{ item: { id: string } }>);
      parentId = created.item.id;
    }
    const response = await collectionRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        title: "one too deep via route",
        body: "x",
        area: "route-depth-guard",
        originType: "auto",
        parentId,
      }),
    );
    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error: { code: string; guard: string } };
    expect(payload.error.code).toBe("guard_rejected");
    expect(payload.error.guard).toBe("items.max_depth");
  });
});
