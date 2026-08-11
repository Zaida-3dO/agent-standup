// Real infrastructure only, per CLAUDE.md's testing tenet: "a failure path
// 'tested' only by stubbing the client does not satisfy this criterion." No
// part of the database or the `prisma migrate deploy` subprocess is mocked
// here — a real PrismaClient makes a real connection attempt against a real
// closed port, and a real, deliberately-broken migration is really applied
// against a real Postgres to force a real failure.
//
// The DB-backed tests need a real Postgres reachable at TEST_DATABASE_URL —
// deliberately NOT `DATABASE_URL`, which vitest.config.ts pins to a fake
// value for the tests that don't need a real connection. CI sets
// TEST_DATABASE_URL to the same disposable service DATABASE_URL points at.
// Locally: `npm run db:up`, then export TEST_DATABASE_URL the same as your
// `.env`'s DATABASE_URL. Without it, the DB-backed suite skips rather than
// fails, so the rest of the suite stays runnable with no local Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { DatabaseUnreachableError, waitForDatabase } from "../scripts/lib/wait-for-db.mjs";
import { createBrokenMigrationSchema } from "./helpers/broken-migration";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

function fakeLog() {
  const calls: string[] = [];
  return {
    calls,
    info: (msg: string) => calls.push(`info: ${msg}`),
    warn: (msg: string) => calls.push(`warn: ${msg}`),
    error: (msg: string) => calls.push(`error: ${msg}`),
  };
}

describe("waitForDatabase — unreachable database (no Postgres needed)", () => {
  it("gives up loudly against a real closed port, having actually retried", async () => {
    const log = fakeLog();
    const start = Date.now();

    // A refused connection isn't instant here: PrismaClient's own engine
    // does internal retrying inside a single `$queryRaw` call before
    // surfacing failure, so one "attempt" of ours can itself take a couple
    // of real seconds. A short budget is used deliberately so this stays a
    // fast test, but it has to be long enough to actually contain more
    // than one attempt — otherwise it'd only prove the timeout fires, not
    // that the retry loop itself runs.
    await expect(
      waitForDatabase({
        databaseUrl: "postgresql://nobody:nobody@127.0.0.1:1/nowhere",
        timeoutMs: 6000,
        intervalMs: 250,
        log,
      }),
    ).rejects.toBeInstanceOf(DatabaseUnreachableError);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    // Didn't hang indefinitely past the timeout either.
    expect(elapsed).toBeLessThan(15_000);
    expect(log.calls.some((line) => line.startsWith("warn:"))).toBe(true);
  }, 20_000);

  it("rejects immediately, with no retries, when DATABASE_URL is unset", async () => {
    await expect(
      waitForDatabase({ databaseUrl: undefined, timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(DatabaseUnreachableError);
  });
});

describeIfDb("waitForDatabase / runMigrations — against a real Postgres", () => {
  const dbName = scratchDatabaseName("boot");
  let scratchUrl: string;

  beforeAll(() => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterAll(() => {
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("resolves once a real, empty database accepts a query", async () => {
    const log = fakeLog();
    await expect(
      waitForDatabase({ databaseUrl: scratchUrl, timeoutMs: 5000, intervalMs: 200, log }),
    ).resolves.toBeUndefined();
  });

  it("applies the baseline migration for real on a clean database", async () => {
    const log = fakeLog();
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl }, log });
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect(log.calls.some((line) => line.includes("Migrations applied successfully"))).toBe(true);
  });

  it("fails loudly, and says so, when a real migration genuinely fails to apply", async () => {
    const { schemaPath, cleanup } = createBrokenMigrationSchema();
    try {
      const log = fakeLog();
      const result = await runMigrations({
        env: { ...process.env, DATABASE_URL: scratchUrl },
        log,
        schemaPath,
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(log.calls.some((line) => line.startsWith("error:") && line.includes("FATAL"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });
});
