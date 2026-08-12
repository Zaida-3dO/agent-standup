// The HTTP adapter's `POST /hook` route, driven directly as a route handler
// (SCHEMA.md §22: "run in-process wherever the process boundary is not the
// thing being tested") against a real Postgres. Same shape as
// tests/claims-routes.test.ts and tests/settings-routes.test.ts.
//
// This is the end-to-end proof for MILESTONES.md #41's "The route is one
// caller": a setting written through the real settings HTTP route is read
// back by the hook route's own decision, with no shortcut between them.
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

describeIfDb("POST /hook route against Postgres", () => {
  const dbName = scratchDatabaseName("hook_route");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let hookRoute: typeof import("@/app/api/hook/route");
  let settingsKeyRoute: typeof import("@/app/api/settings/[key]/route");

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    // Same ordering constraint every other route test documents: point
    // DATABASE_URL at the scratch database before importing anything that
    // reaches service/live.ts's process-global singleton.
    process.env.DATABASE_URL = scratchUrl;
    hookRoute = await import("@/app/api/hook/route");
    settingsKeyRoute = await import("@/app/api/settings/[key]/route");
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

  async function putSetting(key: string, value: unknown): Promise<void> {
    const response = await settingsKeyRoute.PUT(
      jsonRequest(`http://localhost/api/settings/${key}`, "PUT", { value }),
      { params: Promise.resolve({ key }) },
    );
    if (response.status !== 200) {
      throw new Error(
        `PUT /settings/${key} failed with ${response.status}: ${await response.text()}`,
      );
    }
  }

  it("denies a command matching neither list by default — nothing configured yet", async () => {
    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "PreToolUse",
        sessionId: "route-hook-s1",
        tool: "Bash",
        command: "curl https://example.invalid",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { decision: string };
    expect(payload.decision).toBe("deny");
  });

  it("allows silently once the command matches a written allow-list override", async () => {
    await putSetting("hook.allow_patterns", ["^git status$"]);

    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "PostToolUse",
        sessionId: "route-hook-s2",
        tool: "Bash",
        command: "git status",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      decision: string;
      matchedList: string;
      matchedPattern: string;
    };
    expect(payload.decision).toBe("allow");
    expect(payload.matchedList).toBe("allow");
    expect(payload.matchedPattern).toBe("^git status$");
  });

  it("asks once the command matches a written ask-list override, and is not allowed", async () => {
    await putSetting("hook.ask_patterns", ["^rm "]);

    const response = await hookRoute.POST(
      jsonRequest("http://localhost/api/hook", "POST", {
        eventType: "PreToolUse",
        sessionId: "route-hook-s3",
        tool: "Bash",
        command: "rm -rf build",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { decision: string };
    expect(payload.decision).toBe("ask");
  });

  it("POST /hook with malformed JSON returns 400, not a 500", async () => {
    const response = await hookRoute.POST(
      new Request("http://localhost/api/hook", {
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
