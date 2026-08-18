// The HTTP adapter's `POST /hook` route, driven directly as a route handler
// (SCHEMA.md §22: "run in-process wherever the process boundary is not the
// thing being tested") against a real Postgres. Same shape as
// tests/claims-routes.test.ts and tests/settings-routes.test.ts.
//
// **What a database proves here, now that the decision reads no table.**
// `hook_decision` is a dumb pipe by design (MILESTONES.md #125): it touches
// nothing and answers from the event alone, which `tests/hook-decision-
// operation.test.ts` covers as values. What only a real process can show is
// the *transport* around it — that the route is reachable and composes with
// the live runtime that `service/live.ts` builds against an actual
// connection, that malformed input is a 400 rather than a 500, and that the
// phase contract survives serialisation both ways.
//
// That is a narrower claim than this file used to make, and deliberately so:
// a route whose operation reads no settings has no settings behaviour to
// prove, and a test that wrote one anyway would be asserting the plumbing of
// a value nothing consumes.
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

describeIfDb("POST /hook route against Postgres", () => {
  // Every route these cases call authenticates; this configures the
  // token the request helper presents.
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("hook_route");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let hookRoute: typeof import("@/app/api/hook/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // Same ordering constraint every other route test documents: point
    // DATABASE_URL at the scratch database before importing anything that
    // reaches service/live.ts's process-global singleton.
    process.env.DATABASE_URL = scratchUrl;
    hookRoute = await import("@/app/api/hook/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
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

  it("allows a pre-tool call and says the phase could have blocked", async () => {
    // Nothing gates yet (#128 is where it returns), so the decision is an
    // allow — but `canBlock` must still distinguish the phase, because it is
    // what a later gating row will hang a refusal off.
    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "PreToolUse",
        sessionId: "route-hook-s1",
        tool: "Bash",
        command: "curl https://example.invalid",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { decision: string; canBlock: boolean };
    expect(payload.decision).toBe("allow");
    expect(payload.canBlock).toBe(true);
  });

  it("reports a post-tool call as one that could not have blocked", async () => {
    // The server's half of "a post entry cannot block", proven over the
    // wire. The hook enforces the same rule independently, so the invariant
    // survives either side being wrong — but not both.
    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "PostToolUse",
        sessionId: "route-hook-s2",
        tool: "Bash",
        command: "git status",
        toolResult: "nothing to commit",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { decision: string; canBlock: boolean };
    expect(payload.decision).toBe("allow");
    expect(payload.canBlock).toBe(false);
  });

  it("rejects an unknown field rather than dropping it", async () => {
    // `.strict()`, over the wire. The hook is the caller most likely to
    // drift, and a field it starts sending that is silently discarded is a
    // change nobody sees until the behaviour it drives never arrives.
    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "PreToolUse",
        sessionId: "route-hook-s3",
        matchedList: "ask",
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_input");
  });

  it("rejects a tool result past the operation's ceiling with a 400, not a 500", async () => {
    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "PostToolUse",
        sessionId: "route-hook-s5",
        toolResult: "x".repeat(8001),
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; fields: string[] } };
    expect(payload.error.code).toBe("invalid_input");
    expect(payload.error.fields).toContain("toolResult");
  });

  it("POST /hook with malformed JSON returns 400, not a 500", async () => {
    const response = await hookRoute.POST(
      authenticatedRequest("http://localhost/api/hook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_input");
  });

  it("POST /hook with a missing sessionId returns 400 (invalid_input), not a 500", async () => {
    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "PreToolUse",
        tool: "Bash",
        command: "ls",
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; fields: string[] } };
    expect(payload.error.code).toBe("invalid_input");
    expect(payload.error.fields).toContain("sessionId");
  });

  it("a Stop event with no command allows, over the route exactly as through the operation", async () => {
    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "Stop",
        sessionId: "route-hook-s4",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { decision: string };
    expect(payload.decision).toBe("allow");
  });
});
