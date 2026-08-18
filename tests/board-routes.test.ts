// The HTTP adapter's board route, driven directly as a route handler
// (SCHEMA.md §22 — "call the route handler directly"), against a real
// Postgres. Same import-ordering constraint as tests/items-routes.test.ts:
// DATABASE_URL must point at the scratch database before the route module
// (which reaches `service/live.ts`'s process-global singleton) is imported.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  stubAuthEnvironment,
} from "./helpers/authenticated-requests";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("board HTTP route against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("board_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let boardRoute: typeof import("@/app/api/board/route");
  let itemsRoute: typeof import("@/app/api/items/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    boardRoute = await import("@/app/api/board/route");
    itemsRoute = await import("@/app/api/items/route");
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

  async function createItem(overrides: Record<string, unknown>): Promise<{ id: string }> {
    const response = await itemsRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        title: "route board item",
        body: "x",
        area: "board-route-tests",
        originType: "auto",
        ...overrides,
      }),
    );
    const payload = (await response.json()) as { item: { id: string } };
    return payload.item;
  }

  it("GET /board returns 200 with all four columns present", async () => {
    const response = await boardRoute.GET(authenticatedRequest("http://localhost/api/board"));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      board: { columns: Record<string, unknown> };
    };
    // Every column is present on every response, including the ones a
    // default read withholds — a withheld column still reports its real
    // total (MILESTONES.md #123), so it has to be there to report it.
    expect(payload.board.columns).toHaveProperty("backlog");
    expect(payload.board.columns).toHaveProperty("in_progress");
    expect(payload.board.columns).toHaveProperty("waiting");
    expect(payload.board.columns).toHaveProperty("completed");
  });

  it("a newly created item (on_deck) shows up on the board in backlog, over the real HTTP round trip", async () => {
    const created = await createItem({ area: "board-route-backlog" });

    // `column=backlog` because #109's default read answers "what is being
    // worked on" and withholds backlog — reaching it is an explicit ask.
    const response = await boardRoute.GET(
      authenticatedRequest("http://localhost/api/board?area=board-route-backlog&column=backlog"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      board: { columns: { backlog: { entries: { item: { id: string } }[] } } };
    };
    expect(
      payload.board.columns.backlog.entries.some((entry) => entry.item.id === created.id),
    ).toBe(true);
  });

  it("GET /board?area= excludes items in a different area, over the actual query-string parsing", async () => {
    const inArea = await createItem({ area: "board-route-filter-target" });
    await createItem({ area: "board-route-filter-other" });

    const response = await boardRoute.GET(
      authenticatedRequest("http://localhost/api/board?area=board-route-filter-target&column=backlog"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      board: { columns: Record<string, { entries: { item: { id: string } }[] }> };
    };
    const allIds = Object.values(payload.board.columns)
      .flatMap((section) => section.entries)
      .map((entry) => entry.item.id);
    expect(allIds).toEqual([inArea.id]);
  });

  it("GET /board?repo= excludes an item in a different repo, over the actual query-string parsing", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Repo" ("id", "displayName", "defaultBranch", "host", "needsVisualReview")
       VALUES ('board-route-repo-a', 'Repo A', 'main', 'github', false),
              ('board-route-repo-b', 'Repo B', 'main', 'github', false)
       ON CONFLICT ("id") DO NOTHING`,
    );
    const inRepoA = await createItem({ area: "board-route-repo", repo: "board-route-repo-a" });
    await createItem({ area: "board-route-repo", repo: "board-route-repo-b" });

    const response = await boardRoute.GET(
      authenticatedRequest("http://localhost/api/board?repo=board-route-repo-a&column=backlog"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      board: { columns: Record<string, { entries: { item: { id: string } }[] }> };
    };
    const allIds = Object.values(payload.board.columns)
      .flatMap((section) => section.entries)
      .map((entry) => entry.item.id);
    expect(allIds).toEqual([inRepoA.id]);
  });

  it("GET /board?kind=project excludes a task, over the actual query-string parsing", async () => {
    const project = await createItem({ area: "board-route-kind" });
    await createItem({ area: "board-route-kind", parentId: project.id });

    const response = await boardRoute.GET(
      authenticatedRequest("http://localhost/api/board?area=board-route-kind&kind=project&column=backlog"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      board: { columns: Record<string, { entries: { item: { id: string } }[] }> };
    };
    const allIds = Object.values(payload.board.columns)
      .flatMap((section) => section.entries)
      .map((entry) => entry.item.id);
    expect(allIds).toEqual([project.id]);
  });

  it("an invalid priority value is rejected as 400, not a 500", async () => {
    const response = await boardRoute.GET(
      authenticatedRequest("http://localhost/api/board?priority=not-a-real-priority"),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_input");
  });

  it("an invalid state value is rejected as 400, not a 500", async () => {
    const response = await boardRoute.GET(
      authenticatedRequest("http://localhost/api/board?state=not-a-real-state"),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_input");
  });

  it("GET /board?state= excludes an item in a different state, over the actual query-string parsing", async () => {
    // A root item (no parentId) is a PROJECT — the state filter deliberately
    // excludes those, so both items here must be tasks under a project or
    // this would pass by excluding both rather than by narrowing.
    const project = await createItem({ area: "board-route-state" });
    const blocked = await createItem({ area: "board-route-state", parentId: project.id });
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = 'blocked'::"ItemState" WHERE "id" = $1`,
      blocked.id,
    );
    await createItem({ area: "board-route-state", parentId: project.id }); // stays on_deck

    const response = await boardRoute.GET(
      authenticatedRequest("http://localhost/api/board?area=board-route-state&state=blocked"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      board: { columns: Record<string, { entries: { item: { id: string } }[] }> };
    };
    const allIds = Object.values(payload.board.columns)
      .flatMap((section) => section.entries)
      .map((entry) => entry.item.id);
    expect(allIds).toEqual([blocked.id]);
  });

  it("GET /board?search= matches a title substring over the actual query-string parsing, and excludes a non-matching item", async () => {
    const matching = await createItem({
      area: "board-route-search",
      title: "Fix the routing table",
      body: "x",
    });
    await createItem({ area: "board-route-search", title: "Something else", body: "x" });

    const response = await boardRoute.GET(
      authenticatedRequest(
        "http://localhost/api/board?area=board-route-search&search=routing&column=backlog",
      ),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      board: { columns: Record<string, { entries: { item: { id: string } }[] }> };
    };
    const allIds = Object.values(payload.board.columns)
      .flatMap((section) => section.entries)
      .map((entry) => entry.item.id);
    expect(allIds).toEqual([matching.id]);
  });

  it("GET /board?state=&priority= composed excludes an item matching only one of the two, over the actual query-string parsing", async () => {
    // Root items are projects (excluded by the state filter, by design) —
    // both items here must be tasks under a project.
    const project = await createItem({ area: "board-route-compose" });
    const target = await createItem({
      area: "board-route-compose",
      parentId: project.id,
      priority: "P1",
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = 'paused'::"ItemState" WHERE "id" = $1`,
      target.id,
    );
    const wrongPriority = await createItem({
      area: "board-route-compose",
      parentId: project.id,
      priority: "P3",
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = 'paused'::"ItemState" WHERE "id" = $1`,
      wrongPriority.id,
    );

    const response = await boardRoute.GET(
      authenticatedRequest("http://localhost/api/board?area=board-route-compose&state=paused&priority=P1"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      board: { columns: Record<string, { entries: { item: { id: string } }[] }> };
    };
    const allIds = Object.values(payload.board.columns)
      .flatMap((section) => section.entries)
      .map((entry) => entry.item.id);
    expect(allIds).toEqual([target.id]);
  });
});
