// The HTTP read surfaces that answered questions they never ran.
//
// Four findings from the external feedback batch of 2026-09-17 share one
// shape: **a read answers a question it did not actually run, in a way that
// looks like data rather than an omission.** A dropped filter comes back as
// an empty result rather than a refusal, and a field the view never fetched
// comes back as `null` rather than absent — both are indistinguishable, to
// the caller, from a true answer.
//
// **What would make these tests hollow.** Asserting that a route returns 200
// proves nothing about whether it read the parameter: the bug being fixed
// returned 200 the whole time. So each case here is authored so that the
// pre-fix code returns a DIFFERENT value, not a different status — the
// search case asserts a loop is FOUND (it returned `[]` before), and the
// detail case asserts the links are PRESENT (they were reported as null).
//
// Runs against a real Postgres because the claims are about rows and about a
// `json_agg` projection only a real server evaluates. Skips without
// TEST_DATABASE_URL.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import { authenticatedRequest, stubAuthEnvironment } from "./helpers/authenticated-requests";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const caller = { caller: { actor: "tester", transport: "http" } } as const;

describeIfDb("HTTP read surfaces carry the fields they accept", () => {
  const dbName = scratchDatabaseName("http_read_surface_fields");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let itemId: string;
  let searchRoute: typeof import("@/app/api/search/route");

  // Every route these cases call authenticates; this configures the token
  // the request helper presents.
  beforeAll(stubAuthEnvironment);

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // The route module reaches `service/live.ts`'s process-global singleton,
    // so DATABASE_URL has to point at the scratch database before it is
    // imported.
    process.env.DATABASE_URL = scratchUrl;
    searchRoute = await import("@/app/api/search/route");
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.person.create({ data: { id: "tester", displayName: "tester" } });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    const project = (await runtime.call(
      "create_project",
      {
        title: "read surfaces project",
        body: "body",
        area: "web",
        originType: "person",
        originPersonId: "tester",
      },
      caller,
    )) as { id: string };

    const task = (await runtime.call(
      "create_task",
      {
        projectId: project.id,
        title: "read surfaces task",
        body: "body",
        area: "web",
        originType: "person",
        originPersonId: "tester",
        links: [
          { key: "coda-row", url: "https://example.invalid/coda/row" },
          { key: "pr", url: "https://example.invalid/pr/1" },
        ],
      },
      caller,
    )) as { id: string };
    itemId = task.id;

    // Three live claims, so a `limit=1` page is genuinely partial and the
    // assertion below distinguishes "the limit was read" from "there was
    // only one anyway". One claim per item: an item may be held by several
    // roles of the SAME crew, but a second unrelated session on the same
    // item is refused as a foreign crew, which is not what this is testing.
    for (const session of ["s-one", "s-two", "s-three"]) {
      const held = (await runtime.call(
        "create_task",
        {
          projectId: project.id,
          title: `fleet holder ${session}`,
          body: "body",
          area: "web",
          originType: "person",
          originPersonId: "tester",
        },
        caller,
      )) as { id: string };
      await runtime.call(
        "claim",
        {
          itemId: held.id,
          role: "builder",
          holderType: "agent",
          holderId: session,
          sessionId: session,
          machine: "test-machine",
        },
        caller,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (scratchUrl) await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  // Finding 1. The operation has always supported `includeLoops`; the HTTP
  // adapter never read it, so `loopMatches` came back empty alongside a
  // notice advising the caller to pass the flag they had just passed.
  //
  // The single-character change that breaks this: deleting the
  // `input.includeLoops = ...` assignment in `src/app/api/search/route.ts`
  // returns `loopMatches: []` and fails the length assertion below.
  it("search over HTTP honours includeLoops and finds loop text", async () => {
    const phrase = "resign the release commit";
    await runtime.call("loop_add", { itemId, text: `remember to ${phrase}` }, caller);

    const response = await searchRoute.GET(
      authenticatedRequest(
        `http://test.invalid/api/search?query=${encodeURIComponent(phrase)}&includeLoops=true`,
      ),
    );
    const body = (await response.json()) as { loopMatches?: { loopId: string; excerpt: string }[] };

    expect(response.status).toBe(200);
    expect(body.loopMatches ?? []).toHaveLength(1);
    expect(body.loopMatches![0]!.excerpt).toContain("resign");
  });

  // The same query WITHOUT the flag must still return no loops. Without this
  // the test above would pass against a route that ignored the parameter and
  // searched loops unconditionally — which is a different bug, not a fix.
  it("search over HTTP still excludes loop text when includeLoops is absent", async () => {
    const response = await searchRoute.GET(
      authenticatedRequest("http://test.invalid/api/search?query=resign%20the%20release%20commit"),
    );
    const body = (await response.json()) as { loopMatches?: unknown[] };
    expect(body.loopMatches ?? []).toHaveLength(0);
  });

  // The same class as finding 1, found by auditing the other adapters: the
  // fleet read is paged by the operation and the route sent a hardcoded
  // `{}`, so `nextCursor` named a page no HTTP caller could request.
  //
  // Asserts the page SIZE rather than the status, so a route that ignored
  // `limit` again would fail: before the fix this returned all three.
  it("the fleet read over HTTP honours limit, so its pages are reachable", async () => {
    const fleetRoute = await import("@/app/api/fleet/route");
    const response = await fleetRoute.GET(
      authenticatedRequest("http://test.invalid/api/fleet?limit=1"),
    );
    const body = (await response.json()) as {
      assignments: unknown[];
      nextCursor?: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.assignments).toHaveLength(1);
    // Two more claims exist, so the page is genuinely partial and the cursor
    // is the only way to reach them.
    expect(body.nextCursor).toBeTruthy();
  });

  // Criterion 6. `POST /items/{id}/loops/close` binds `loopId` to the literal
  // "close" and, with no POST export on that route, answered with an empty
  // body and no error — which is what an external report read as "the close
  // was accepted and its reason discarded".
  //
  // Asserts the BODY names the right call, not merely that the status is 4xx:
  // the complaint was about an unreadable answer, not a missing one.
  it("POST to the loops collection path without a loop id refuses, naming the real call", async () => {
    const loopRoute = await import("@/app/api/items/[id]/loops/[loopId]/route");
    const response = await loopRoute.POST(
      authenticatedRequest(`http://test.invalid/api/items/${itemId}/loops/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loopId: "whatever", reason: "resolved" }),
      }),
      { params: Promise.resolve({ id: itemId, loopId: "close" }) },
    );
    const body = (await response.json()) as { error?: { message?: string; fields?: string[] } };

    expect(response.status).toBe(400);
    expect(body.error?.message).toContain("{loopId}/close");
    expect(body.error?.message).toContain("nothing was closed");
    expect(body.error?.fields).toEqual(["loopId"]);
  });

  // Finding 3. `/detail` is meant to be the fullest view, and was reported as
  // the one view that hid a field the sibling read returned.
  it("the detail read carries the links the item holds", async () => {
    const detail = (await runtime.call("get_item_detail", { id: itemId }, caller)) as unknown as {
      item: { links: readonly { key: string; url: string }[] | null };
    };
    expect(detail.item.links).not.toBeNull();
    expect([...(detail.item.links ?? [])].map((l) => l.key).sort()).toEqual(["coda-row", "pr"]);
  });
});
