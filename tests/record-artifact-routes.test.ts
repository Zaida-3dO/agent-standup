// The HTTP adapter's `POST /items/{id}/artifacts` and
// `POST /items/{id}/review-requests` routes (MILESTONES.md #98), driven
// directly as route handlers (SCHEMA.md §22 — "run in-process wherever the
// process boundary is not the thing being tested"), against a real Postgres.
//
// `service/live.ts`'s exported `service` is process-global, so `DATABASE_URL`
// is pointed at the scratch database *before* the route modules are imported
// — the same ordering constraint tests/claims-routes.test.ts documents.
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

describeIfDb("artifact HTTP routes against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("artifact_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let artifactsRoute: typeof import("@/app/api/items/[id]/artifacts/route");
  let reviewRequestsRoute: typeof import("@/app/api/items/[id]/review-requests/route");
  let itemCounter = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    artifactsRoute = await import("@/app/api/items/[id]/artifacts/route");
    reviewRequestsRoute = await import("@/app/api/items/[id]/review-requests/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "route-area", displayName: "Route area" } });
    // `record_artifact` refuses a `createdByType: "person"` whose id names
    // nobody (#134), so the person these fixtures credit has to exist.
    await prisma.person.create({ data: { id: "user-a", displayName: "User A" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function jsonRequest(url: string, method: string, body?: unknown): Request {
    return authenticatedRequest(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function seedItem(): Promise<string> {
    itemCounter += 1;
    const id = `artifact-route-item-${itemCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: "Route item",
        body: "body",
        state: "executing" as never,
        originType: "auto",
        area: "route-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  describe("POST /items/{id}/artifacts", () => {
    it("records the artifact and answers 201 with the row", async () => {
      const id = await seedItem();
      const response = await artifactsRoute.POST(
        jsonRequest(`http://test.invalid/api/items/${id}/artifacts`, "POST", {
          kind: "code_review",
          verdict: "lgtm",
          commitSha: "sha-1",
          createdByType: "person",
          createdById: "user-a",
        }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        artifact: { id: string; itemId: string; kind: string; verdict: string; createdAt: string };
      };
      expect(payload.artifact.itemId).toBe(id);
      expect(payload.artifact.kind).toBe("code_review");
      expect(payload.artifact.verdict).toBe("lgtm");
      // Serialised as an ISO string, not a Date — `NextResponse.json` would
      // otherwise emit whatever its own Date handling produces, and a client
      // reading this field has no way to know which it got.
      expect(typeof payload.artifact.createdAt).toBe("string");
      expect(Number.isNaN(Date.parse(payload.artifact.createdAt))).toBe(false);

      const stored = await prisma.artifact.findUnique({ where: { id: payload.artifact.id } });
      expect(stored?.itemId).toBe(id);
    });

    it("takes the item id from the path, not the body", async () => {
      const id = await seedItem();
      const other = await seedItem();
      const response = await artifactsRoute.POST(
        jsonRequest(`http://test.invalid/api/items/${id}/artifacts`, "POST", {
          itemId: other,
          kind: "plan",
          createdByType: "agent",
          createdById: "agent-a",
        }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(201);
      const payload = (await response.json()) as { artifact: { itemId: string } };
      // The path wins. A body that could redirect the write to another item
      // would make the URL a suggestion rather than the address it reads as.
      expect(payload.artifact.itemId).toBe(id);
    });

    it("answers 404 for an item that does not exist", async () => {
      const response = await artifactsRoute.POST(
        jsonRequest("http://test.invalid/api/items/nope/artifacts", "POST", {
          kind: "plan",
          createdByType: "agent",
          createdById: "agent-a",
        }),
        { params: Promise.resolve({ id: "nope" }) },
      );
      expect(response.status).toBe(404);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("not_found");
      expect(payload.error.fields).toEqual(["itemId"]);
    });

    it("answers 400 for an input the service refuses", async () => {
      const id = await seedItem();
      const response = await artifactsRoute.POST(
        jsonRequest(`http://test.invalid/api/items/${id}/artifacts`, "POST", {
          kind: "commit",
          createdByType: "agent",
          createdById: "agent-a",
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields).toEqual(["commitSha"]);
    });

    it("answers 400 for a malformed body", async () => {
      const id = await seedItem();
      const response = await artifactsRoute.POST(
        authenticatedRequest(`http://test.invalid/api/items/${id}/artifacts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(400);
      // Mutation evidence: the whole envelope, so a change that dropped
      // `fields` or reworded `code` is caught rather than only the status.
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_input",
          message: "Request body must be valid JSON.",
          fields: [],
        },
      });
    });
  });

  describe("POST /items/{id}/review-requests", () => {
    it("records the request and answers 201 with the event", async () => {
      const id = await seedItem();
      const response = await reviewRequestsRoute.POST(
        jsonRequest(`http://test.invalid/api/items/${id}/review-requests`, "POST", {
          round: 2,
          actorType: "agent",
          actorId: "agent-b",
        }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(201);
      const payload = (await response.json()) as { event: { id: string; ts: string } };
      // The event id is a bigint in the database; serialised as a string so
      // `NextResponse.json` does not throw on it.
      expect(typeof payload.event.id).toBe("string");

      const events = await prisma.event.findMany({
        where: { itemId: id, type: "review_requested" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ round: 2 });
    });

    it("answers 404 for an item that does not exist", async () => {
      const response = await reviewRequestsRoute.POST(
        jsonRequest("http://test.invalid/api/items/nope/review-requests", "POST", {}),
        { params: Promise.resolve({ id: "nope" }) },
      );
      expect(response.status).toBe(404);
    });

    it("answers 400 for a malformed body", async () => {
      const id = await seedItem();
      const response = await reviewRequestsRoute.POST(
        authenticatedRequest(`http://test.invalid/api/items/${id}/review-requests`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_input",
          message: "Request body must be valid JSON.",
          fields: [],
        },
      });
    });
  });
});
