// The HTTP adapter's people route, driven directly as a route handler
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

describeIfDb("people HTTP route against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("people_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let peopleRoute: typeof import("@/app/api/people/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    peopleRoute = await import("@/app/api/people/route");
    prisma = createTestPrismaClient(scratchUrl);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("GET /people returns 200 with an empty list against a database with no people", async () => {
    const response = await peopleRoute.GET(authenticatedRequest("http://localhost/api/people"));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { people: unknown[] };
    expect(payload.people).toEqual([]);
  });

  it("GET /people returns a created profile with the fields the picker renders", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName", "avatar", "colour", "createdAt")
       VALUES ('people-route-a', 'Route Person', null, '#abcdef', now())`,
    );

    const response = await peopleRoute.GET(authenticatedRequest("http://localhost/api/people"));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      people: {
        id: string;
        displayName: string;
        avatar: string | null;
        colour: string | null;
        archivedAt: string | null;
      }[];
    };
    const found = payload.people.find((p) => p.id === "people-route-a");
    // T13: `archivedAt` joined the shape (always present, null when active)
    // so `/admin/people` can render the same record the picker reads — see
    // list-people.ts's header.
    expect(found).toEqual({
      id: "people-route-a",
      displayName: "Route Person",
      avatar: null,
      colour: "#abcdef",
      archivedAt: null,
    });
  });

  it("GET /people excludes an archived profile over the real HTTP round trip", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName", "createdAt", "archivedAt")
       VALUES ('people-route-archived', 'Gone', now(), now())`,
    );

    const response = await peopleRoute.GET(authenticatedRequest("http://localhost/api/people"));
    const payload = (await response.json()) as { people: { id: string }[] };
    expect(payload.people.some((p) => p.id === "people-route-archived")).toBe(false);
  });

  it("GET /people?includeArchived=true includes an archived profile, with archivedAt set", async () => {
    const response = await peopleRoute.GET(
      authenticatedRequest("http://localhost/api/people?includeArchived=true"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      people: { id: string; archivedAt: string | null }[];
    };
    const found = payload.people.find((p) => p.id === "people-route-archived");
    expect(found).toBeDefined();
    expect(found?.archivedAt).not.toBeNull();
  });

  it("GET /people?includeArchived=false behaves exactly like the default (no query param)", async () => {
    const response = await peopleRoute.GET(
      authenticatedRequest("http://localhost/api/people?includeArchived=false"),
    );
    const payload = (await response.json()) as { people: { id: string }[] };
    expect(payload.people.some((p) => p.id === "people-route-archived")).toBe(false);
  });

  // `list_people` is paged (MILESTONES.md #109) and this route used to read
  // only `includeArchived`, so `limit` and `cursor` arrived and were silently
  // dropped: a caller asking for one page got the default hundred with no
  // `nextCursor` it could act on. PR #420 fixed that and nothing tested it —
  // deleting either `input.limit` or `input.cursor` from the route left the
  // whole suite green, so the exact bug could return unnoticed.
  //
  // These drive the real route handler against real Postgres, so what is
  // asserted is the query string actually reaching `list_people`, not a
  // restatement of the route's own arithmetic.
  describe("paging query parameters", () => {
    // Distinct, ordered `createdAt` values, because the read orders by
    // `("createdAt", "id")` — fixed timestamps rather than `now()` so the
    // page boundaries below are deterministic rather than insertion-race
    // dependent. Archived from the earlier cases is excluded by default,
    // and these four sort after everything already inserted.
    const ids = ["page-a", "page-b", "page-c", "page-d"];

    beforeAll(async () => {
      for (const [index, id] of ids.entries()) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Person" ("id", "displayName", "createdAt")
           VALUES ($1, $2, timestamptz '2030-01-01 00:00:00Z' + ($3 || ' minutes')::interval)`,
          id,
          `Paged ${id}`,
          String(index),
        );
      }
    });

    it("GET /people?limit=N returns exactly N rows and a usable nextCursor", async () => {
      const response = await peopleRoute.GET(
        authenticatedRequest("http://localhost/api/people?limit=2"),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        people: { id: string }[];
        nextCursor: string | null;
      };
      // Dropping `input.limit` yields the default hundred — every person in
      // the database — so both the count and the cursor fail here.
      expect(payload.people).toHaveLength(2);
      expect(payload.nextCursor).not.toBeNull();
      expect(payload.nextCursor).toBe(payload.people[1]?.id);
    });

    it("passing nextCursor back returns the following page, not the one already seen", async () => {
      const first = (await (
        await peopleRoute.GET(authenticatedRequest("http://localhost/api/people?limit=2"))
      ).json()) as { people: { id: string }[]; nextCursor: string | null };

      const second = (await (
        await peopleRoute.GET(
          authenticatedRequest(
            `http://localhost/api/people?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
          ),
        )
      ).json()) as { people: { id: string }[]; nextCursor: string | null };

      // The property that fails when `input.cursor` is dropped: without it
      // the second request is just the first one again.
      const firstIds = first.people.map((p) => p.id);
      const secondIds = second.people.map((p) => p.id);
      expect(secondIds).not.toEqual(firstIds);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
      expect(second.people).toHaveLength(2);
    });

    it("walks the whole set in pages without repeating or skipping a row", async () => {
      // The end-to-end property the two parameters exist to provide, and the
      // one a caller actually depends on. Asserted against the set inserted
      // above rather than against a second call to the same route.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const url = new URL("http://localhost/api/people");
        url.searchParams.set("limit", "2");
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        const payload = (await (
          await peopleRoute.GET(authenticatedRequest(url.toString()))
        ).json()) as { people: { id: string }[]; nextCursor: string | null };
        seen.push(...payload.people.map((p) => p.id));
        cursor = payload.nextCursor;
        if (cursor === null) break;
      }

      expect(cursor).toBeNull();
      // No duplicates anywhere in the walk.
      expect(new Set(seen).size).toBe(seen.length);
      // Every row inserted here was visited, in `createdAt` order.
      expect(seen.filter((id) => ids.includes(id))).toEqual(ids);
    });
  });
});
