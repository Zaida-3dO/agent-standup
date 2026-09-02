// The HTTP adapter's events routes, driven directly as route handlers
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

describeIfDb("events HTTP routes against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("since_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let eventsRoute: typeof import("@/app/api/events/route");
  let seenRoute: typeof import("@/app/api/events/[id]/seen/route");
  let itemsRoute: typeof import("@/app/api/items/route");
  let notesRoute: typeof import("@/app/api/items/[id]/notes/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    eventsRoute = await import("@/app/api/events/route");
    seenRoute = await import("@/app/api/events/[id]/seen/route");
    itemsRoute = await import("@/app/api/items/route");
    notesRoute = await import("@/app/api/items/[id]/notes/route");
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

  async function createPerson(id: string): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      id,
      id,
    );
    return id;
  }

  async function createItem(title: string): Promise<string> {
    const response = await itemsRoute.POST(
      jsonRequest("http://test/api/items", "POST", {
        title,
        body: "x",
        area: "since-routes",
        originType: "auto",
      }),
    );
    const payload = (await response.json()) as { item: { id: string } };
    return payload.item.id;
  }

  /**
   * Appends an event through the real route, then waits for it to clear the
   * visibility horizon.
   *
   * **The wait is load-bearing.** `GET /events` reads through
   * `readSinceBounded`, which bounds itself to `txId < horizon` so it can
   * never permanently skip a row (SCHEMA.md §3). That horizon is
   * `pg_snapshot_xmin` — server-wide, not per-database — so any transaction
   * open anywhere on the shared test server holds back every row written
   * after it started, and vitest runs the DB-backed files in parallel.
   * Without this, a write here is legitimately invisible to the read that
   * follows and the test fails for a reason unrelated to the route.
   *
   * It waits for the guarantee rather than defeating it: an assertion still
   * fails for real if the row never becomes visible.
   */
  async function appendNote(itemId: string, body: string): Promise<string> {
    const response = await notesRoute.POST(
      jsonRequest(`http://test/api/items/${itemId}/notes`, "POST", { body }),
      { params: Promise.resolve({ id: itemId }) },
    );
    const payload = (await response.json()) as { event: { id: string } };
    const id = String(payload.event.id);
    await waitForVisibility(id);
    return id;
  }

  /** Polls until `eventId` is inside the horizon a bounded read would use, or gives up loudly. */
  async function waitForVisibility(eventId: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await getEvents(`?since=${BigInt(eventId) - 1n}&limit=1`);
      const events = body.events as { id: string }[] | undefined;
      if (events?.some((event) => event.id === eventId)) return;
      if (Date.now() > deadline) {
        throw new Error(
          `Event ${eventId} never became visible to a horizon-bounded read within ${timeoutMs}ms.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function getEvents(query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await eventsRoute.GET(authenticatedRequest(`http://test/api/events${query}`));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /**
   * Polls `GET /api/events` until `eventId` appears in the slice, or gives up.
   *
   * The slice is bounded by the transaction-visibility horizon, which is
   * `pg_snapshot_xmin` and therefore **server-wide**: a transaction open in
   * another test file, against its own scratch database, still holds it back.
   * So a row this test just committed is not necessarily readable on the very
   * next call — that delay is the documented cost of the bound, not a fault.
   *
   * Reading once turns ordinary contention into a red test. Polling keeps the
   * assertion honest, because it still fails if the row never arrives.
   */
  async function getEventsUntilVisible(
    query: string,
    eventId: string,
    attempts = 200,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    let last = await getEvents(query);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const events = (last.body.events ?? []) as { id: string }[];
      if (events.some((event) => event.id === eventId)) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
      last = await getEvents(query);
    }
    return last;
  }

  async function postSeen(
    eventId: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await seenRoute.POST(
      jsonRequest(`http://test/api/events/${eventId}/seen`, "POST", body),
      { params: Promise.resolve({ id: eventId }) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  describe("GET /api/events", () => {
    it("answers 200 with a slice, a cursor and a horizon", async () => {
      const itemId = await createItem("Route slice");
      const eventId = await appendNote(itemId, "note");

      // Anchored to our own event — see `appendNote` on why a read from the
      // start of a shared ledger is not a reliable way to get this row.
      const { status, body } = await getEventsUntilVisible(
        `?since=${BigInt(eventId) - 1n}`,
        eventId,
      );
      expect(status).toBe(200);
      expect((body.events as { id: string }[]).some((e) => e.id === eventId)).toBe(true);
      expect(Array.isArray(body.events)).toBe(true);
      expect(typeof body.cursor).toBe("string");
      expect(typeof body.horizon).toBe("string");
    }, 30_000);

    it("resolves read state for the profile in the query string", async () => {
      const person = await createPerson("route-reader");
      const itemId = await createItem("Route read state");
      const eventId = await appendNote(itemId, "note");
      await postSeen(eventId, { personId: person });

      const { body } = await getEventsUntilVisible(
        `?personId=${person}&since=${BigInt(eventId) - 1n}`,
        eventId,
      );
      const events = body.events as { id: string; seen: boolean }[];
      expect(events.find((e) => e.id === eventId)?.seen).toBe(true);
    }, 30_000);

    it("treats a bare unseenOnly flag as true", async () => {
      // `?unseenOnly` with no value is how a query string spells a flag.
      const person = await createPerson("route-flag");
      const itemId = await createItem("Route flag");
      const eventId = await appendNote(itemId, "note");
      await postSeen(eventId, { personId: person });

      const { status, body } = await getEvents(`?personId=${person}&unseenOnly`);
      expect(status).toBe(200);
      const events = body.events as { id: string }[];
      expect(events.some((e) => e.id === eventId)).toBe(false);
    }, 30_000);

    it("refuses an unparseable limit with 400 rather than silently serving a default", async () => {
      const { status, body } = await getEvents("?limit=lots");
      expect(status).toBe(400);
      expect(JSON.stringify(body)).toContain("limit");
    }, 30_000);

    it("refuses a limit above the cap with 400", async () => {
      expect((await getEvents("?limit=5000")).status).toBe(400);
    }, 30_000);

    it("refuses a non-numeric cursor with 400", async () => {
      expect((await getEvents("?since=abc")).status).toBe(400);
    }, 30_000);

    it("honours a numeric limit from the query string", async () => {
      const itemId = await createItem("Route limit");
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await appendNote(itemId, `note ${i}`));

      // Anchored just below our own first event rather than reading from
      // `since=0`. The default read starts at the very beginning of a
      // ledger this suite shares with every other DB-backed file, and the
      // horizon can legitimately hold back rows down there — so a bare
      // `?limit=2` could return fewer than two for a reason that says
      // nothing about whether the limit was honoured. Anchoring makes the
      // assertion about this parameter and nothing else.
      const { body } = await getEvents(`?since=${BigInt(ids[0]!) - 1n}&limit=2`);
      expect((body.events as unknown[]).length).toBe(2);
    }, 30_000);
  });

  describe("POST /api/events/{id}/seen", () => {
    it("answers 200 and reports the write", async () => {
      const person = await createPerson("route-marker");
      const itemId = await createItem("Route mark");
      const eventId = await appendNote(itemId, "note");

      const { status, body } = await postSeen(eventId, { personId: person });
      expect(status).toBe(200);
      expect(body.alreadySeen).toBe(false);
      expect(typeof body.seenAt).toBe("string");
    }, 30_000);

    it("answers 200 on a repeat too — same status, alreadySeen in the body", async () => {
      // Deliberately NOT 201-then-200: that would leak the distinction
      // into the status line and invite a caller to branch on it.
      const person = await createPerson("route-repeat");
      const itemId = await createItem("Route repeat");
      const eventId = await appendNote(itemId, "note");

      const first = await postSeen(eventId, { personId: person });
      const second = await postSeen(eventId, { personId: person });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.alreadySeen).toBe(true);
      expect(second.body.seenAt).toBe(first.body.seenAt);
    }, 30_000);

    it("refuses an unknown event with 404", async () => {
      const person = await createPerson("route-404-event");
      expect((await postSeen("999999999", { personId: person })).status).toBe(404);
    }, 30_000);

    it("refuses an unknown profile with 404", async () => {
      const itemId = await createItem("Route 404 profile");
      const eventId = await appendNote(itemId, "note");
      expect((await postSeen(eventId, { personId: "nobody" })).status).toBe(404);
    }, 30_000);

    it("refuses a missing personId with 400 naming the field", async () => {
      const itemId = await createItem("Route missing person");
      const eventId = await appendNote(itemId, "note");
      const { status, body } = await postSeen(eventId, {});
      expect(status).toBe(400);
      expect(JSON.stringify(body)).toContain("personId");
    }, 30_000);

    it("refuses an empty body with 400 naming personId, not a JSON parse error", async () => {
      // An empty body is a caller who forgot the field, and the refusal
      // should say so rather than complaining about JSON.
      const itemId = await createItem("Route empty body");
      const eventId = await appendNote(itemId, "note");
      const response = await seenRoute.POST(
        authenticatedRequest(`http://test/api/events/${eventId}/seen`, { method: "POST" }),
        { params: Promise.resolve({ id: eventId }) },
      );
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain("personId");
    }, 30_000);

    it("refuses malformed JSON with 400", async () => {
      const itemId = await createItem("Route bad json");
      const eventId = await appendNote(itemId, "note");
      const response = await seenRoute.POST(
        authenticatedRequest(`http://test/api/events/${eventId}/seen`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        { params: Promise.resolve({ id: eventId }) },
      );
      expect(response.status).toBe(400);
    }, 30_000);

    it("takes the event id from the path, not the body", async () => {
      // A body that names a different event must not override the path —
      // otherwise the URL and the effect disagree.
      const person = await createPerson("route-path-wins");
      const itemId = await createItem("Route path wins");
      const real = await appendNote(itemId, "the real one");
      const decoy = await appendNote(itemId, "the decoy");

      await postSeen(real, { personId: person, eventId: decoy });

      const rows = await prisma.$queryRawUnsafe<{ eventId: bigint }[]>(
        `SELECT "eventId" FROM "EventSeen" WHERE "personId" = $1`,
        person,
      );
      expect(rows.map((r) => String(r.eventId))).toEqual([real]);
    }, 30_000);
  });
});
