// `POST /api/backfill` — the HTTP adapter's endpoint, driven as a route
// handler against a real Postgres (SCHEMA.md §22: "call the route handler
// directly" where the process boundary is not the thing being tested).
// Same shape as tests/admin-routes.test.ts.
//
// **Why this file exists.** The r06 review of PR #79 found that nothing
// under `tests/` reached the route at all — it was exercised only by a full
// integration run, so its authentication, its JSON parsing and its
// error-to-status mapping were unasserted. This is the entry point to a
// bulk-write path, which makes "reachable but never asserted directly" the
// wrong state for it to be in.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
// Every fixture is invented; this repository is public (CLAUDE.md).
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BACKFILL_ENV_VAR } from "@/lib/backfill/enabled";
import { authenticatedRequest, stubAuthEnvironment } from "./helpers/authenticated-requests";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const TASK_A = "T-19700101-example-one";

/** A payload the contract accepts, with one importable task. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    defaultArea: "imported",
    tasks: [
      {
        id: TASK_A,
        title: "Title",
        body: "# Brief\n",
        status: "executing",
      },
    ],
    statusAliases: { executing: "executing" },
    ...overrides,
  };
}

/** Sets the env gate for one call and always puts the environment back. */
async function withGate<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env[BACKFILL_ENV_VAR];
  if (value === undefined) delete process.env[BACKFILL_ENV_VAR];
  else process.env[BACKFILL_ENV_VAR] = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env[BACKFILL_ENV_VAR];
    else process.env[BACKFILL_ENV_VAR] = before;
  }
}

describeIfDb("POST /api/backfill", () => {
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("backfill_api_route");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let route: typeof import("@/app/api/backfill/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // Same ordering constraint admin-routes.test.ts documents: point
    // DATABASE_URL at the scratch database before importing anything that
    // reaches `service/live.ts`'s process-global singleton.
    process.env.DATABASE_URL = scratchUrl;
    route = await import("@/app/api/backfill/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  }, 120_000);

  afterEach(async () => {
    // Each case starts from an empty import. Items carry the area's FK, so
    // they go first. Through the client rather than raw SQL: the models
    // carry no `@@map`, so the tables are `"Item"`/`"Area"`, and letting
    // Prisma name them keeps this correct if that ever changes.
    await prisma.itemArea.deleteMany();
    await prisma.event.deleteMany();
    await prisma.item.deleteMany();
    await prisma.area.deleteMany();
  });

  /** The imported rows for a legacy id, read back out of the database. */
  async function importedRows(legacyId: string) {
    return prisma.item.findMany({
      where: { customFields: { path: ["legacy_id"], equals: legacyId } },
      select: { title: true },
    });
  }

  /** POSTs a JSON body through the real handler. */
  async function post(body: unknown): Promise<Response> {
    return route.POST(
      authenticatedRequest("http://localhost/api/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  it("imports the payload's tasks and reports the counts", async () => {
    const response = await withGate("true", () => post({ payload: payload() }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.itemsImported).toBe(1);

    // Asserted in the database, not only in the response: the counts are the
    // thing under test, so believing them about themselves would prove
    // nothing.
    const rows = await importedRows(TASK_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Title");
  });

  it("refuses with 403 when the window is closed, and writes nothing", async () => {
    const response = await withGate(undefined, () => post({ payload: payload() }));

    expect(response.status).toBe(403);
    const body = await response.json();
    // The refusal is the service's, rendered unedited — it names the
    // variable, so whoever hit it knows what to do next.
    expect(JSON.stringify(body)).toContain(BACKFILL_ENV_VAR);

    expect(await prisma.item.count()).toBe(0);
  });

  it("refuses a gate set to any value other than the exact affirmative", async () => {
    // The fail-closed property, reached through the route rather than
    // asserted on the predicate alone: `"TRUE"` is not `"true"`.
    const response = await withGate("TRUE", () => post({ payload: payload() }));

    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request before it reaches the service", async () => {
    const response = await withGate("true", () =>
      route.POST(
        new Request("http://localhost/api/backfill", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload: payload() }),
        }),
      ),
    );

    expect(response.status).toBe(401);
    expect(await prisma.item.count()).toBe(0);
  });

  it("answers 400 for a body that is not JSON at all", async () => {
    const response = await withGate("true", () => post("{not json"));

    expect(response.status).toBe(400);
  });

  it("answers 400 for a payload the contract refuses, without importing part of it", async () => {
    // A task with `originType: "person"` and no `originPersonId` — the
    // refine covered in tests/backfill-contract.test.ts, here proving the
    // route surfaces it as a 400 rather than a 500.
    const response = await withGate("true", () =>
      post({
        payload: payload({
          tasks: [
            {
              id: TASK_A,
              title: "Title",
              body: "# Brief\n",
              status: "executing",
              originType: "person",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await prisma.item.count()).toBe(0);
  });

  it("is idempotent — a second identical POST imports nothing further", async () => {
    await withGate("true", () => post({ payload: payload() }));
    const second = await withGate("true", () => post({ payload: payload() }));

    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.itemsImported).toBe(0);
    expect(body.itemsSkipped).toBe(1);

    expect(await importedRows(TASK_A)).toHaveLength(1);
  });

  it("carries the reminder that the window is still open", async () => {
    // The window being left open is the realistic failure (the module's own
    // header says so), so every success says it is still open.
    const response = await withGate("true", () => post({ payload: payload() }));

    const body = await response.json();
    expect(JSON.stringify(body)).toContain(BACKFILL_ENV_VAR);
  });

  it("echoes a request id on both a success and a refusal", async () => {
    const ok = await withGate("true", () => post({ payload: payload() }));
    const refused = await withGate(undefined, () => post({ payload: payload() }));

    expect(ok.headers.get("x-request-id")).toBeTruthy();
    expect(refused.headers.get("x-request-id")).toBeTruthy();
  });
});
