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

    // A second project, so a `limit=1` page over `get_projects` is
    // genuinely partial rather than happening to be the only one.
    await runtime.call(
      "create_project",
      {
        title: "read surfaces project two",
        body: "body",
        area: "web",
        originType: "person",
        originPersonId: "tester",
      },
      caller,
    );

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

  // The identical class again, this time in `get_projects` — the exact
  // shape `get_fleet` had before its own fix: the route never mentioned
  // `limit` or `cursor` though the operation declares both and its own
  // summary says "pass limit and cursor, read nextCursor".
  //
  // Asserts the page SIZE, not the status, for the same reason as the fleet
  // case above: the pre-fix route returned 200 with every project on it.
  // The single-character change that breaks this: deleting the
  // `queryInput(request, "get_projects")` call in
  // `src/app/api/projects/route.ts` (or reverting it to a hand-written
  // reader that never mentions `limit`) returns every project on one page.
  it("get_projects over HTTP honours limit and cursor, so its second page is reachable", async () => {
    const projectsRoute = await import("@/app/api/projects/route");
    const first = await projectsRoute.GET(
      authenticatedRequest("http://test.invalid/api/projects?limit=1"),
    );
    const firstBody = (await first.json()) as {
      projects: { id: string }[];
      nextCursor?: string | null;
    };

    expect(first.status).toBe(200);
    // This suite's `create_project` in `beforeAll` plus the extra projects
    // below make at least two, so a `limit=1` page is genuinely partial.
    expect(firstBody.projects).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await projectsRoute.GET(
      authenticatedRequest(
        `http://test.invalid/api/projects?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      ),
    );
    const secondBody = (await second.json()) as { projects: { id: string }[] };

    expect(second.status).toBe(200);
    expect(secondBody.projects).toHaveLength(1);
    // The second page names a different project than the first — proof the
    // cursor actually advanced rather than the route silently ignoring it
    // and serving page one twice.
    expect(secondBody.projects[0]!.id).not.toBe(firstBody.projects[0]!.id);
  });

  // `get_board`'s `trust` filter (MILESTONES.md #131) was never read over
  // HTTP: the route mentioned 17 of its 18 declared fields and skipped this
  // one. An imported (`originType: "source"`) row with nobody having
  // recorded a `historical_verification` against it is `unverified`; an
  // ordinary row created here is `trusted`. Asserts by ITEM CONTENT — which
  // ids come back — not merely by status, so a route that accepted and
  // ignored the parameter (returning every item regardless) would still
  // fail: it would return both ids under `trust=unverified`.
  it("the board read over HTTP honours the trust filter", async () => {
    const boardRoute = await import("@/app/api/board/route");
    const trustProject = (await runtime.call(
      "create_project",
      {
        title: "trust filter project",
        body: "body",
        area: "web",
        originType: "person",
        originPersonId: "tester",
      },
      caller,
    )) as { id: string };
    const sourceTask = (await runtime.call(
      "create_task",
      {
        projectId: trustProject.id,
        title: "imported task nobody has checked",
        body: "body",
        area: "web",
        originType: "source",
      },
      caller,
    )) as { id: string };

    // `?column=backlog` names the column explicitly — `on_deck` (the
    // default state a fresh task lands in) maps there, and `backlog` is
    // withheld by default (MILESTONES.md #109) unless asked for by name.
    const unverified = await boardRoute.GET(
      authenticatedRequest("http://test.invalid/api/board?trust=unverified&column=backlog"),
    );
    const unverifiedBody = (await unverified.json()) as {
      board: { columns: Record<string, { entries: { item: { id: string } }[] }> };
    };
    const unverifiedIds = Object.values(unverifiedBody.board.columns).flatMap((section) =>
      section.entries.map((entry) => entry.item.id),
    );

    expect(unverified.status).toBe(200);
    expect(unverifiedIds).toContain(sourceTask.id);
    expect(unverifiedIds).not.toContain(itemId);

    const trusted = await boardRoute.GET(
      authenticatedRequest("http://test.invalid/api/board?trust=trusted&column=backlog"),
    );
    const trustedBody = (await trusted.json()) as {
      board: { columns: Record<string, { entries: { item: { id: string } }[] }> };
    };
    const trustedIds = Object.values(trustedBody.board.columns).flatMap((section) =>
      section.entries.map((entry) => entry.item.id),
    );

    expect(trusted.status).toBe(200);
    expect(trustedIds).toContain(itemId);
    expect(trustedIds).not.toContain(sourceTask.id);
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
