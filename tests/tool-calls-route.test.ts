// The HTTP adapter's tool-call ingest route, driven directly as a route
// handler (SCHEMA.md §22 — "call the route handler directly"), against a
// real Postgres. MILESTONES.md #50.
//
// Same import-ordering constraint as tests/board-routes.test.ts:
// DATABASE_URL must point at the scratch database before the route module
// (which reaches `service/live.ts`'s process-global singleton) is imported.
//
// What this file adds over tests/record-tool-calls.test.ts, which already
// exercises the operation: that the *adapter* is wired at all, and that it
// maps the service layer's outcomes onto HTTP the way every other route
// here does — a 201 for a write, an `invalid_json` for a body that is not
// JSON, and the operation's own `invalid_input` rather than a 500. None of
// those are reachable through the runtime, because the runtime has no
// notion of a status code.
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

describeIfDb("POST /api/tool-calls against Postgres", () => {
  const dbName = scratchDatabaseName("tool_calls_route");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let route: typeof import("@/app/api/tool-calls/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    route = await import("@/app/api/tool-calls/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function post(body: unknown, raw = false): Request {
    return new Request("http://localhost/api/tool-calls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    });
  }

  it("records a batch and answers 201 with what it was attributed to", async () => {
    const response = await route.POST(
      post({
        sessionId: "route-session-1",
        calls: [{ tool: "Bash", ts: "2026-01-02T03:04:05.000Z", command: "npm test" }],
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { recorded: number; itemId: string | null };
    expect(body.recorded).toBe(1);
    // No claim was made, so this is a ghost session — recorded, not refused.
    expect(body.itemId).toBeNull();

    const rows = await prisma.toolCall.findMany({ where: { sessionId: "route-session-1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.command).toBe("npm test");
  });

  it("answers 400 invalid_json for a body that is not JSON", async () => {
    const response = await route.POST(post("{not json", true));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string; error?: { code?: string } };
    expect(body.code ?? body.error?.code).toBe("invalid_json");
  });

  it("passes the operation's own invalid_input through rather than failing with a 500", async () => {
    // The adapter holds no validation of its own — a thin shell means the
    // schema's rejection is the one a client sees, with the same code the
    // MCP and CLI adapters produce for the same input (§22's "identical
    // rejections").
    const response = await route.POST(
      post({ sessionId: "route-session-2", calls: [{ tool: "Bash", ts: "x", inputTokens: -1 }] }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string; error?: { code?: string } };
    expect(body.code ?? body.error?.code).toBe("invalid_input");
  });
});
