// The HTTP adapter's `POST /hook` route, driven directly as a route handler
// (SCHEMA.md §22: "run in-process wherever the process boundary is not the
// thing being tested") against a real Postgres. Same shape as
// tests/claims-routes.test.ts and tests/settings-routes.test.ts.
//
// This is the end-to-end proof for MILESTONES.md #41's "The route is one
// caller": a setting override, once stored, is read back by the hook
// route's own decision through the real settings snapshot the running
// process resolves — not a shortcut that hands the operation a value
// directly.
//
// Overrides are written with a direct SQL insert plus a revision bump
// (`putSettingRow` below — the same two statements `put_setting`'s handler
// issues, src/lib/service/operations/put-setting.ts) rather than through
// the live `PUT /settings/{key}` HTTP route, and `settingsCache.invalidate()`
// is called immediately afterward. That combination is deliberate:
// `service/live.ts` composes `hookRoute`'s runtime with a `SettingsCache`
// that serves a held snapshot from memory for up to `revalidateAfterMs`
// (SCHEMA.md §17.3) — real, and correct: a hook decision made on every tool
// call must not cost a database read each time. `invalidate()` is the
// documented escape hatch for "a process that has just written a setting"
// (`src/lib/settings/cache.ts`), which is exactly this test's position.
// Nothing in the application's own write routes calls it yet — a
// pre-existing gap in the settings write path (rows #78/#83), not something
// #41 introduces or is scoped to fix — so this test reaches the same
// process-global `settingsCache` `service/live.ts` exports and calls it
// directly, rather than waiting out the interval or masking the gap by
// constructing a fresh, uncached runtime that would prove nothing about the
// real one.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMigratedScratchDatabase,
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
  let settingsCache: typeof import("@/lib/service/live").settingsCache;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // Same ordering constraint every other route test documents: point
    // DATABASE_URL at the scratch database before importing anything that
    // reaches service/live.ts's process-global singleton.
    process.env.DATABASE_URL = scratchUrl;
    hookRoute = await import("@/app/api/hook/route");
    ({ settingsCache } = await import("@/lib/service/live"));
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function jsonRequest(url: string, method: string, body?: unknown): Request {
    return new Request(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /** Writes one settings override row and bumps the revision — see header. */
  async function putSettingRow(key: string, value: unknown): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "settings" ("key", "value", "updatedByType", "updatedById")
       VALUES ($1, $2::jsonb, 'system'::"ActorType", NULL)
       ON CONFLICT ("key") DO UPDATE
         SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP`,
      key,
      JSON.stringify(value),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "settings_revision" SET "revision" = "revision" + 1 WHERE "id" = 1`,
    );
    // The documented "immediate in the process that made the change" path
    // (src/lib/settings/cache.ts) — see this file's header for why the
    // test calls it directly rather than the write route doing so.
    settingsCache.invalidate();
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
    await putSettingRow("hook.allow_patterns", ["^git status$"]);

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
    await putSettingRow("hook.ask_patterns", ["^rm "]);

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
