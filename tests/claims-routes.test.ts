// The HTTP adapter's claim/release/heartbeat/checkpoint/note routes, driven
// directly as route handlers (SCHEMA.md §22 "Cost… run in-process wherever
// the process boundary is not the thing being tested — call the route
// handler directly"), against a real Postgres. `service/live.ts`'s exported
// `service` instance is process-global, so this test points `DATABASE_URL`
// at a scratch database before importing anything that reaches it, then
// imports the route modules — the same ordering constraint
// tests/items-routes.test.ts documents.
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

describeIfDb("claim/release/heartbeat/checkpoint/note HTTP routes against Postgres", () => {
  const dbName = scratchDatabaseName("claim_routes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let claimRoute: typeof import("@/app/api/claims/route");
  let releaseRoute: typeof import("@/app/api/claims/release/route");
  let heartbeatRoute: typeof import("@/app/api/claims/heartbeat/route");
  let checkpointRoute: typeof import("@/app/api/checkpoints/route");
  let notesRoute: typeof import("@/app/api/items/[id]/notes/route");
  let itemCounter = 0;

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    process.env.DATABASE_URL = scratchUrl;
    claimRoute = await import("@/app/api/claims/route");
    releaseRoute = await import("@/app/api/claims/release/route");
    heartbeatRoute = await import("@/app/api/claims/heartbeat/route");
    checkpointRoute = await import("@/app/api/checkpoints/route");
    notesRoute = await import("@/app/api/items/[id]/notes/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "route-area", displayName: "Route area" } });
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

  async function seedItem(): Promise<string> {
    itemCounter += 1;
    const id = `route-item-${itemCounter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: "on_deck",
        originType: "auto",
        area: "route-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  // -- POST /api/claims -----------------------------------------------------

  it("POST /api/claims claims an item and returns 201", async () => {
    const itemId = await seedItem();
    const response = await claimRoute.POST(
      jsonRequest("http://localhost/api/claims", "POST", {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "crew",
        sessionId: "route-s1",
        machine: "laptop",
      }),
    );
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { assignment: { itemId: string; role: string } };
    expect(payload.assignment.itemId).toBe(itemId);
    expect(payload.assignment.role).toBe("builder");
  });

  it("POST /api/claims with malformed JSON returns 400, not a 500", async () => {
    const response = await claimRoute.POST(
      new Request("http://localhost/api/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    // Mutation evidence: `_shared/respond.ts`'s invalidJsonResponse literal
    // — a mutant that changed `code`, `message` or `fields` would still
    // return 400 (caught above), but only this body assertion catches a
    // change to the envelope's own content.
    const payload = (await response.json()) as {
      error: { code: string; message: string; fields: string[] };
    };
    expect(payload.error).toEqual({
      code: "invalid_input",
      message: "Request body must be valid JSON.",
      fields: [],
    });
  });

  it("POST /api/claims returns 409 (conflict) for a second orchestrator, not 500", async () => {
    const itemId = await seedItem();
    await claimRoute.POST(
      jsonRequest("http://localhost/api/claims", "POST", {
        itemId,
        role: "orchestrator",
        holderType: "agent",
        holderId: "crew",
        sessionId: "orch-1",
        machine: "laptop",
      }),
    );
    const response = await claimRoute.POST(
      jsonRequest("http://localhost/api/claims", "POST", {
        itemId,
        role: "orchestrator",
        holderType: "agent",
        holderId: "crew",
        sessionId: "orch-2",
        rootSessionId: "orch-1",
        machine: "laptop",
      }),
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("conflict");
  });

  it("POST /api/claims returns 422 (guard_rejected) for role=custom with no name", async () => {
    const itemId = await seedItem();
    const response = await claimRoute.POST(
      jsonRequest("http://localhost/api/claims", "POST", {
        itemId,
        role: "custom",
        holderType: "agent",
        holderId: "crew",
        sessionId: "custom-1",
        machine: "laptop",
      }),
    );
    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error: { code: string; guard: string } };
    expect(payload.error.code).toBe("guard_rejected");
    expect(payload.error.guard).toBe("claims.custom_role_needs_name");
  });

  // -- POST /api/claims/release ---------------------------------------------

  it("POST /api/claims/release releases what claim created and returns 200", async () => {
    const itemId = await seedItem();
    await claimRoute.POST(
      jsonRequest("http://localhost/api/claims", "POST", {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "crew",
        sessionId: "release-s1",
        machine: "laptop",
      }),
    );

    const response = await releaseRoute.POST(
      jsonRequest("http://localhost/api/claims/release", "POST", {
        itemId,
        sessionId: "release-s1",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { assignment: { releasedAt: string | null } };
    expect(payload.assignment.releasedAt).not.toBeNull();
  });

  it("POST /api/claims/release returns 409 for a session holding nothing", async () => {
    const itemId = await seedItem();
    const response = await releaseRoute.POST(
      jsonRequest("http://localhost/api/claims/release", "POST", {
        itemId,
        sessionId: "never-claimed",
      }),
    );
    expect(response.status).toBe(409);
  });

  // -- POST /api/claims/heartbeat --------------------------------------------

  it("POST /api/claims/heartbeat returns 200 for a live session", async () => {
    const itemId = await seedItem();
    await claimRoute.POST(
      jsonRequest("http://localhost/api/claims", "POST", {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "crew",
        sessionId: "beat-s1",
        machine: "laptop",
      }),
    );

    const response = await heartbeatRoute.POST(
      jsonRequest("http://localhost/api/claims/heartbeat", "POST", {
        itemId,
        sessionId: "beat-s1",
      }),
    );
    expect(response.status).toBe(200);
    // Mutation evidence: `NextResponse.json({ assignment })` — a mutant
    // that emptied the response body would still return 200 (caught
    // above) but the `assignment` key would be missing.
    const payload = (await response.json()) as { assignment: { sessionId: string } };
    expect(payload.assignment.sessionId).toBe("beat-s1");
  });

  it("POST /api/claims/heartbeat returns 409 for a session holding nothing", async () => {
    const itemId = await seedItem();
    const response = await heartbeatRoute.POST(
      jsonRequest("http://localhost/api/claims/heartbeat", "POST", {
        itemId,
        sessionId: "never-claimed",
      }),
    );
    expect(response.status).toBe(409);
  });

  // -- POST /api/checkpoints -------------------------------------------------

  it("POST /api/checkpoints records a checkpoint and returns a JSON-safe (string) event id", async () => {
    const itemId = await seedItem();
    await claimRoute.POST(
      jsonRequest("http://localhost/api/claims", "POST", {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "crew",
        sessionId: "cp-s1",
        machine: "laptop",
      }),
    );

    const response = await checkpointRoute.POST(
      jsonRequest("http://localhost/api/checkpoints", "POST", {
        itemId,
        sessionId: "cp-s1",
        body: "checked in via the route",
      }),
    );
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { event: { id: string } };
    // A bigint serialised as a JSON *string*, never a number — see
    // _shared/respond.ts's serializeAppendedEvent. If this were ever
    // returned as a raw bigint, NextResponse.json (JSON.stringify under the
    // hood) would throw and this whole call would 500, not merely mismatch
    // a type — so this assertion also stands in for "the route didn't crash".
    expect(typeof payload.event.id).toBe("string");
  });

  it("POST /api/checkpoints returns 409 for a session with no live claim on this item", async () => {
    const itemId = await seedItem();
    const response = await checkpointRoute.POST(
      jsonRequest("http://localhost/api/checkpoints", "POST", {
        itemId,
        sessionId: "no-claim",
        body: "x",
      }),
    );
    expect(response.status).toBe(409);
  });

  // -- POST /api/items/{id}/notes --------------------------------------------

  it("POST /api/items/{id}/notes leaves a note, needing no claim, and returns 201", async () => {
    const itemId = await seedItem();
    const response = await notesRoute.POST(
      jsonRequest(`http://localhost/api/items/${itemId}/notes`, "POST", {
        body: "a remark from the board",
      }),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { event: { id: string } };
    expect(typeof payload.event.id).toBe("string");
  });

  it("POST /api/items/{id}/notes returns 404 for an item that does not exist", async () => {
    const response = await notesRoute.POST(
      jsonRequest("http://localhost/api/items/no-such-item/notes", "POST", { body: "x" }),
      { params: Promise.resolve({ id: "no-such-item" }) },
    );
    expect(response.status).toBe(404);
  });

  it("POST /api/items/{id}/notes with malformed JSON returns 400, not a 500", async () => {
    const itemId = await seedItem();
    const response = await notesRoute.POST(
      new Request(`http://localhost/api/items/${itemId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(response.status).toBe(400);
  });
});
