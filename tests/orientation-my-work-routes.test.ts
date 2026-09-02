// The HTTP adapter's orientation and my-work routes, driven directly as
// route handlers (SCHEMA.md §22 "run in-process wherever the process
// boundary is not the thing being tested"), against a real Postgres. Same
// module-import ordering constraint as tests/items-routes.test.ts: point
// DATABASE_URL at the scratch database before importing the route modules,
// since `service/live.ts` constructs its singleton on module load.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticatedRequest, stubAuthEnvironment } from "./helpers/authenticated-requests";
import { claimItem, type ClaimInput } from "@/lib/claims";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("orientation and my-work HTTP routes against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("orient_mywork_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let collectionRoute: typeof import("@/app/api/items/route");
  let orientationRoute: typeof import("@/app/api/items/[id]/orientation/route");
  let myWorkRoute: typeof import("@/app/api/my-work/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    collectionRoute = await import("@/app/api/items/route");
    orientationRoute = await import("@/app/api/items/[id]/orientation/route");
    myWorkRoute = await import("@/app/api/my-work/route");
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

  async function createItemViaRoute(overrides: Record<string, unknown> = {}) {
    const response = await collectionRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        title: "Route subject",
        body: "x",
        area: "route-orient-area",
        originType: "auto",
        ...overrides,
      }),
    );
    return (await response.json()) as { item: { id: string } };
  }

  async function claim(input: ClaimInput) {
    return prisma.$transaction((tx) => claimItem(tx, input));
  }

  /**
   * Retries the orientation route until `whatChanged` is non-empty. See
   * `tests/orientation-operation.test.ts`'s `orientationUntilChanged` for
   * why this is necessary rather than asserting immediately: the visibility
   * horizon is deliberately conservative and Postgres transaction ids are
   * cluster-wide, so a long-running transaction in an unrelated,
   * concurrently-running test file's own scratch database can hold this
   * suite's horizon back for a moment. This is `readSinceBounded` behaving
   * correctly under real concurrency, not a route bug.
   */
  async function orientationRouteUntilChanged(
    itemId: string,
  ): Promise<{ whatChanged: readonly { id: string }[] }> {
    // Same ~30s budget as orientationUntilChanged, and for the same reason.
    for (let attempt = 0; attempt < 150; attempt++) {
      const payload = await orientationRoute
        .GET(authenticatedRequest(`http://localhost/api/items/${itemId}/orientation`), {
          params: Promise.resolve({ id: itemId }),
        })
        .then((r) => r.json() as Promise<{ whatChanged: readonly { id: string }[] }>);
      if (payload.whatChanged.length > 0) return payload;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `orientation route's whatChanged for ${itemId} stayed empty after 150 retries (~30s).`,
    );
  }

  describe("GET /items/{id}/orientation", () => {
    it("returns 200 with checkpoint, state, whatChanged, openLoops and crew", async () => {
      const created = await createItemViaRoute({ title: "Orientation via route" });
      const response = await orientationRoute.GET(
        authenticatedRequest(`http://localhost/api/items/${created.item.id}/orientation`),
        { params: Promise.resolve({ id: created.item.id }) },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        item: { id: string; state: string };
        checkpoint: unknown;
        whatChanged: unknown[];
        openLoops: {
          notDone: unknown[];
          children: unknown[];
          loops: unknown[];
          loopsTruncated: boolean;
          loopTextTruncated: boolean;
        };
        crew: unknown[];
      };
      expect(payload.item.id).toBe(created.item.id);
      expect(payload.item.state).toBe("on_deck");
      expect(payload.checkpoint).toBeNull();
      // All three sources of "still outstanding", asserted exhaustively so a
      // fourth one added later has to come through this test rather than
      // appearing silently in the transport payload. `loops` is the one an
      // item can carry while it is still in flight (SCHEMA.md §3a).
      //
      // The two truncation flags travel beside them because `loops` is
      // bounded in count and in text: a caller has to be able to tell a
      // short list from a cut one, and on this item neither bound was hit.
      //
      // `nonWorkExcluded` travels with them for the same reason and is
      // asserted here rather than only in the operation's own tests: it is a
      // third way the list can be shorter than the item's real loop count,
      // so a caller reading the transport payload has to be able to see it.
      // Zero on this item, which has no loops at all.
      expect(payload.openLoops).toEqual({
        notDone: [],
        children: [],
        loops: [],
        loopsTruncated: false,
        loopTextTruncated: false,
        nonWorkExcluded: 0,
      });
      expect(payload.crew).toEqual([]);
    });

    it("returns 404 for an id that does not exist — not a 500", async () => {
      const response = await orientationRoute.GET(
        authenticatedRequest("http://localhost/api/items/does-not-exist/orientation"),
        { params: Promise.resolve({ id: "does-not-exist" }) },
      );
      expect(response.status).toBe(404);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("not_found");
    });

    it("the `since` query parameter reaches the service call and narrows whatChanged", async () => {
      const created = await createItemViaRoute({ title: "Since via route" });
      const first = await orientationRouteUntilChanged(created.item.id);
      const createEventId = first.whatChanged[0]?.id;
      expect(createEventId).toBeDefined();

      const response = await orientationRoute.GET(
        authenticatedRequest(
          `http://localhost/api/items/${created.item.id}/orientation?since=${createEventId}`,
        ),
        { params: Promise.resolve({ id: created.item.id }) },
      );
      const payload = (await response.json()) as { whatChanged: readonly unknown[] };
      // Nothing happened after the create event itself, so passing its own
      // id as `since` must exclude it.
      expect(payload.whatChanged).toEqual([]);
    }, 35_000);
  });

  describe("GET /my-work", () => {
    it("returns 200 with an empty list for a session holding nothing", async () => {
      const response = await myWorkRoute.GET(
        authenticatedRequest("http://localhost/api/my-work?sessionId=route-session-empty"),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { items: unknown[] };
      expect(payload.items).toEqual([]);
    });

    it("returns 400 invalid_input when sessionId is missing from the query string", async () => {
      const response = await myWorkRoute.GET(authenticatedRequest("http://localhost/api/my-work"));
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields).toContain("sessionId");
    });

    it("reports the session's held item with its role, over the real query-string binding", async () => {
      const created = await createItemViaRoute({ title: "Held via route" });
      await claim({
        itemId: created.item.id,
        role: "visual_reviewer",
        holderType: "agent",
        holderId: "crew-visual",
        sessionId: "route-session-holder",
        machine: "laptop",
      });

      const response = await myWorkRoute.GET(
        authenticatedRequest("http://localhost/api/my-work?sessionId=route-session-holder"),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        items: readonly { item: { id: string }; assignment: { role: string } }[];
      };
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]?.item.id).toBe(created.item.id);
      expect(payload.items[0]?.assignment.role).toBe("visual_reviewer");
    });
  });
});
