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
  it("gives up loudly against a real closed port, having actually retried more than once", async () => {
    const log = fakeLog();
    const start = Date.now();

    // A refused connection isn't instant here: PrismaClient's own engine
    // does internal retrying inside a single `$queryRaw` call before
    // surfacing failure, so one "attempt" of ours can itself take a couple
    // of real seconds. A short budget is used deliberately so this stays a
    // fast test, but it has to be long enough to actually contain more
    // than one attempt — otherwise it'd only prove the timeout fires, not
    // that the retry loop itself runs.
    let thrown: unknown;
    try {
      await waitForDatabase({
        databaseUrl: "postgresql://nobody:nobody@127.0.0.1:1/nowhere",
        timeoutMs: 6000,
        intervalMs: 250,
        log,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DatabaseUnreachableError);
    const elapsed = Date.now() - start;
    // Didn't hang indefinitely past the timeout either.
    expect(elapsed).toBeLessThan(15_000);

    // The assertion that names the actual behaviour: the attempt count, not
    // the clock. A single attempt against this closed port already costs
    // enough real time (~2s) to satisfy a loose elapsed-time bound even with
    // the retry loop deleted entirely — an elapsed-time bound alone cannot
    // tell "retried" from "took one slow attempt".
    const message = (thrown as InstanceType<typeof DatabaseUnreachableError>).message;
    const attemptMatch = message.match(/across (\d+) attempt/);
    expect(attemptMatch).not.toBeNull();
    expect(Number(attemptMatch![1])).toBeGreaterThanOrEqual(2);

    expect(
      log.calls.filter((line) => line.startsWith("warn:") && line.includes("retrying")).length,
    ).toBeGreaterThanOrEqual(1);
    expect(log.calls.some((line) => line.includes("giving up"))).toBe(true);
  }, 20_000);

  it("rejects immediately, with no retries, when DATABASE_URL is unset", async () => {
    await expect(
      waitForDatabase({ databaseUrl: undefined, timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(DatabaseUnreachableError);
  });

  it("the isFinite guard breaks the loop on a non-finite timeoutMs, rather than retrying forever", async () => {
    // A non-finite timeoutMs cannot reach here through entrypoint.mjs —
    // scripts/lib/boot-env.mjs validates the multiplied millisecond value
    // before this function ever sees it — but waitForDatabase is also
    // called directly (by tests, and by any future caller), which is what
    // the belt-and-braces `!Number.isFinite(remaining)` guard defends.
    // `deadline = Date.now() + Infinity` is `Infinity`, so `remaining` is
    // `Infinity` from the first failed attempt onward; without the guard
    // this genuinely never resolves, so the test's own timeout is itself
    // part of the assertion, not just a safety net.
    const log = fakeLog();
    await expect(
      waitForDatabase({
        databaseUrl: "postgresql://nobody:nobody@127.0.0.1:1/nowhere",
        timeoutMs: Infinity,
        intervalMs: 250,
        log,
      }),
    ).rejects.toBeInstanceOf(DatabaseUnreachableError);
  }, 8_000);
});

describeIfDb("waitForDatabase / runMigrations — against a real Postgres", () => {
  const dbName = scratchDatabaseName("boot");
  let scratchUrl: string;

  beforeAll(async () => {
    scratchUrl = await createScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterAll(async () => {
    await dropScratchDatabase(testDatabaseUrl!, dbName);
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
