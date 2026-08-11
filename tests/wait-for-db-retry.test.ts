// Deterministic proof of the retry loop's own timing, using a mocked
// @prisma/client that fails instantly. tests/boot.test.ts already proves the
// failure path is real against a genuinely closed port; that real path is
// unsuitable for a precise timing assertion on its own, because a single
// real Prisma connection attempt against a closed port costs ~2s on its own
// — enough to swamp any `intervalMs` this file wants to measure. The seam
// mocked here is the Postgres client, not the retry loop under test; the
// loop, the sleep, and the deadline arithmetic all run for real.
import { afterEach, describe, expect, it, vi } from "vitest";

function fakeLog() {
  const calls: string[] = [];
  return {
    calls,
    info: (msg: string) => calls.push(`info: ${msg}`),
    warn: (msg: string) => calls.push(`warn: ${msg}`),
    error: (msg: string) => calls.push(`error: ${msg}`),
  };
}

function mockInstantlyFailingPrismaClient() {
  // A plain `function`, not an arrow function: wait-for-db.mjs calls
  // `new PrismaClient(...)`, and an arrow function cannot be used as a
  // constructor (`new (() => {})()` throws `TypeError: … is not a
  // constructor`). Returning an object from a regular function invoked with
  // `new` substitutes that object for `this`, which is exactly what's
  // wanted here.
  const PrismaClientMock = vi.fn().mockImplementation(function () {
    return {
      $queryRaw: () => Promise.reject(new Error("connection refused (mock)")),
      $disconnect: () => Promise.resolve(),
    };
  });
  vi.doMock("@prisma/client", () => ({ PrismaClient: PrismaClientMock }));
  return PrismaClientMock;
}

describe("waitForDatabase — retry-loop timing (mocked client, no real DB or network needed)", () => {
  afterEach(() => {
    vi.doUnmock("@prisma/client");
    vi.resetModules();
  });

  it("makes more than one attempt within a budget that comfortably fits several", async () => {
    mockInstantlyFailingPrismaClient();
    vi.resetModules();
    const { waitForDatabase, DatabaseUnreachableError } =
      await import("../scripts/lib/wait-for-db.mjs");

    const log = fakeLog();
    let thrown: unknown;
    try {
      await waitForDatabase({
        databaseUrl: "postgresql://u:p@h:5432/db",
        timeoutMs: 250,
        intervalMs: 50,
        log,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DatabaseUnreachableError);
    const attemptMatch = (thrown as Error).message.match(/across (\d+) attempt/);
    expect(attemptMatch).not.toBeNull();
    expect(Number(attemptMatch![1])).toBeGreaterThanOrEqual(3);
  });

  it("bounds the attempt count to roughly timeoutMs/intervalMs, proving intervalMs actually elapses between attempts", async () => {
    // Not an elapsed-time assertion: the loop's total wall-clock duration is
    // governed by the deadline either way, so a correct sleep(intervalMs)
    // and a broken sleep(0) both run for close to the full timeoutMs budget
    // — that comparison doesn't distinguish them. The ATTEMPT COUNT does:
    // with a near-instant mock client, each attempt is otherwise dominated
    // by the sleep between attempts, so a 300ms/100ms budget should produce
    // only a handful of attempts. sleep(0) in place of
    // sleep(Math.min(intervalMs, remaining)) produces dozens within the same
    // window, bound only by event-loop overhead rather than by intervalMs.
    mockInstantlyFailingPrismaClient();
    vi.resetModules();
    const { waitForDatabase } = await import("../scripts/lib/wait-for-db.mjs");

    const log = fakeLog();
    await waitForDatabase({
      databaseUrl: "postgresql://u:p@h:5432/db",
      timeoutMs: 300,
      intervalMs: 100,
      log,
    }).catch(() => {});

    const retryWarnings = log.calls.filter((line) => line.includes("retrying")).length;
    expect(retryWarnings).toBeGreaterThanOrEqual(2);
    expect(retryWarnings).toBeLessThanOrEqual(6);
  });

  it("logs a distinct 'giving up' warning on the final attempt, not just retry warnings", async () => {
    mockInstantlyFailingPrismaClient();
    vi.resetModules();
    const { waitForDatabase } = await import("../scripts/lib/wait-for-db.mjs");

    const log = fakeLog();
    await waitForDatabase({
      databaseUrl: "postgresql://u:p@h:5432/db",
      timeoutMs: 120,
      intervalMs: 50,
      log,
    }).catch(() => {});

    expect(log.calls.some((line) => line.includes("giving up"))).toBe(true);
    expect(log.calls.filter((line) => line.includes("retrying")).length).toBeGreaterThanOrEqual(1);
  });
});
