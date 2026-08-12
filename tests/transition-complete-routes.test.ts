// The HTTP adapter's transition and complete routes (SCHEMA.md §19
// `POST /items/{id}/transition?dry_run=`, §18 `complete`) — MILESTONES.md
// #27 AC1-AC5, driven as route handlers over a real Postgres. Same ordering
// constraint `items-routes.test.ts` documents: point DATABASE_URL at the
// scratch database *before* importing the route modules, since
// `service/live.ts` constructs its singleton on module load.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

function validSummary(overrides: Record<string, unknown> = {}) {
  return {
    shipped: ["Delivered the thing."],
    not_done: [],
    user_facing: false,
    how_verified: "Ran it locally and watched it work end to end.",
    watch_for: [],
    ...overrides,
  };
}

describeIfDb("transition and complete HTTP routes against Postgres", () => {
  const dbName = scratchDatabaseName("transition_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let collectionRoute: typeof import("@/app/api/items/route");
  let transitionRoute: typeof import("@/app/api/items/[id]/transition/route");
  let completeRoute: typeof import("@/app/api/items/[id]/complete/route");

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    process.env.DATABASE_URL = scratchUrl;
    collectionRoute = await import("@/app/api/items/route");
    transitionRoute = await import("@/app/api/items/[id]/transition/route");
    completeRoute = await import("@/app/api/items/[id]/complete/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function jsonRequest(url: string, method: string, body?: unknown): Request {
    return new Request(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Creates a root project, then a **task** under it — never a bare root
   * item. A root-level create is a `project` (kind is derived from depth,
   * `create-item.ts`), and a project has no stored state to transition
   * (DECISIONS.md §13c) — `applyTransition` refuses it outright
   * (`ProjectHasNoStateError`, mapped to 403). Every route test below
   * transitions the returned id, so it has to be a `task`.
   */
  async function createItemViaRoute(overrides: Record<string, unknown> = {}): Promise<string> {
    const projectResponse = await collectionRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        title: "Route project",
        body: "x",
        area: "transition-route-tests",
        originType: "auto",
      }),
    );
    const project = (await projectResponse.json()) as { item: { id: string } };

    const response = await collectionRoute.POST(
      jsonRequest("http://localhost/api/items", "POST", {
        title: "Route item",
        body: "x",
        area: "transition-route-tests",
        originType: "auto",
        parentId: project.item.id,
        ...overrides,
      }),
    );
    const payload = (await response.json()) as { item: { id: string } };
    return payload.item.id;
  }

  async function readState(id: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id } });
    return row.state;
  }

  describe("AC1 — POST /items/{id}/transition", () => {
    it("moves the item and returns 200 with the applied outcome", async () => {
      const id = await createItemViaRoute();

      const response = await transitionRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/transition`, "POST", { to: "someday" }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        item: { state: string };
        outcome: { allowed: boolean; rehearsed: boolean };
      };
      expect(payload.item.state).toBe("someday");
      expect(payload.outcome.allowed).toBe(true);
      expect(payload.outcome.rehearsed).toBe(false);
      expect(await readState(id)).toBe("someday");
    });

    it("a guard rejection surfaces as 422 through the route, not 500", async () => {
      const id = await createItemViaRoute();

      const response = await transitionRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/transition`, "POST", { to: "blocked" }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(422);
      const payload = (await response.json()) as { error: { code: string; guard: string } };
      expect(payload.error.code).toBe("guard_rejected");
      expect(payload.error.guard).toBe("state-machine.blocked_required_fields");
      expect(await readState(id)).toBe("on_deck"); // untouched — still the create default
    });

    it("a non-existent item returns 404, not 500", async () => {
      const response = await transitionRoute.POST(
        jsonRequest("http://localhost/api/items/does-not-exist/transition", "POST", {
          to: "someday",
        }),
        { params: Promise.resolve({ id: "does-not-exist" }) },
      );
      expect(response.status).toBe(404);
    });

    it("malformed JSON returns 400, not a 500", async () => {
      const id = await createItemViaRoute();
      const response = await transitionRoute.POST(
        new Request(`http://localhost/api/items/${id}/transition`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(400);
    });
  });

  describe("AC3/AC4 — ?dry_run=true through the route", () => {
    it("reports the outcome as 200 JSON — never a thrown RehearsalRollback surfacing as 500", async () => {
      const id = await createItemViaRoute();

      const response = await transitionRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/transition?dry_run=true`, "POST", {
          to: "someday",
        }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        outcome: { allowed: boolean; rehearsed: boolean };
      };
      expect(payload.outcome.allowed).toBe(true);
      expect(payload.outcome.rehearsed).toBe(true);
      // AC4's load-bearing assertion, at the route level this time: a
      // separate query after the HTTP call returned still shows no change.
      expect(await readState(id)).toBe("on_deck");
    });

    it("a rehearsed rejection is still 200 (it's a reported outcome, not an HTTP error)", async () => {
      const id = await createItemViaRoute();

      const response = await transitionRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/transition?dry_run=true`, "POST", {
          to: "blocked",
        }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        outcome: { allowed: boolean; rejection?: { guard: string } };
      };
      expect(payload.outcome.allowed).toBe(false);
      expect(payload.outcome.rejection?.guard).toBe("state-machine.blocked_required_fields");
      expect(await readState(id)).toBe("on_deck");
    });

    it("dry_run=false (or the param absent) actually writes — proving the route reads the query param, not a hardcoded rehearsal", async () => {
      const id = await createItemViaRoute();
      const response = await transitionRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/transition?dry_run=false`, "POST", {
          to: "someday",
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { outcome: { rehearsed: boolean } };
      expect(payload.outcome.rehearsed).toBe(false);
      expect(await readState(id)).toBe("someday");
    });
  });

  describe("AC2 — POST /items/{id}/complete", () => {
    it("finishes the item, persists the summary, and returns 200", async () => {
      // No prior transition needed — `complete` runs against the all-to-all
      // state machine (SCHEMA.md §16), so a fresh `on_deck` item can go
      // straight to `merged`, the same way `transition` can. Routing through
      // `in_review` first would additionally need a `review_requested`
      // artifact (row #17's guard), which is not what this test is about.
      const id = await createItemViaRoute();

      const response = await completeRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/complete`, "POST", {
          to: "merged",
          summary: validSummary(),
        }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as { item: { state: string } };
      expect(payload.item.state).toBe("merged");
      expect(await readState(id)).toBe("merged");

      const summaryRows = await prisma.$queryRawUnsafe<{ itemId: string }[]>(
        `SELECT "itemId" FROM "Summary" WHERE "itemId" = $1`,
        id,
      );
      expect(summaryRows).toHaveLength(1);
    });

    it("a missing/invalid summary surfaces as a client error through the route, not 500", async () => {
      // No prior transition needed — `complete` (like `transition`) runs
      // against the all-to-all state machine, so this exercises the
      // route/schema rejection directly rather than needing a legal path
      // into `in_review` first (which itself needs a review-requested
      // artifact this test isn't about).
      const id = await createItemViaRoute();

      const response = await completeRoute.POST(
        jsonRequest(`http://localhost/api/items/${id}/complete`, "POST", { to: "merged" }),
        { params: Promise.resolve({ id }) },
      );

      expect(response.status).toBe(400); // zod schema rejection: summary is required
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("invalid_input");
      expect(await readState(id)).toBe("on_deck");
    });
  });

  describe("AC5 — thin shells (structural, this file's own contribution beyond items-routes-thin-shell.test.ts's generic scan)", () => {
    it("neither route module has a top-level export named prisma or PrismaClient", async () => {
      // A cheap, additional sanity check specific to these two new files: the
      // canonical proof is items-routes-thin-shell.test.ts's resolved-import
      // scan over the whole src/app/api/items tree, which already covers
      // these files by directory walk. This just asserts the module's own
      // export surface is exactly what a thin shell exposes — HTTP method
      // handlers, nothing else.
      expect(Object.keys(transitionRoute)).toEqual(["POST"]);
      expect(Object.keys(completeRoute)).toEqual(["POST"]);
    });
  });
});
