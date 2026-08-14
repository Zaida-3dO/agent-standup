// The HTTP adapter's people route, driven directly as a route handler
// (SCHEMA.md §22 — "call the route handler directly"), against a real
// Postgres. Same import-ordering constraint as tests/board-routes.test.ts:
// DATABASE_URL must point at the scratch database before the route module
// (which reaches `service/live.ts`'s process-global singleton) is imported.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("people HTTP route against Postgres", () => {
  const dbName = scratchDatabaseName("people_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let peopleRoute: typeof import("@/app/api/people/route");

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    process.env.DATABASE_URL = scratchUrl;
    peopleRoute = await import("@/app/api/people/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("GET /people returns 200 with an empty list against a database with no people", async () => {
    const response = await peopleRoute.GET();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { people: unknown[] };
    expect(payload.people).toEqual([]);
  });

  it("GET /people returns a created profile with the fields the picker renders", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName", "avatar", "colour", "createdAt")
       VALUES ('people-route-a', 'Route Person', null, '#abcdef', now())`,
    );

    const response = await peopleRoute.GET();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      people: { id: string; displayName: string; avatar: string | null; colour: string | null }[];
    };
    const found = payload.people.find((p) => p.id === "people-route-a");
    expect(found).toEqual({
      id: "people-route-a",
      displayName: "Route Person",
      avatar: null,
      colour: "#abcdef",
    });
  });

  it("GET /people excludes an archived profile over the real HTTP round trip", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName", "createdAt", "archivedAt")
       VALUES ('people-route-archived', 'Gone', now(), now())`,
    );

    const response = await peopleRoute.GET();
    const payload = (await response.json()) as { people: { id: string }[] };
    expect(payload.people.some((p) => p.id === "people-route-archived")).toBe(false);
  });
});
