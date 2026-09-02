// A regression guard on the test-side client factory's wiring.
//
// **Why this file has to exist at all.** 121 test files call
// `createTestPrismaClient`, so it is exercised constantly — but every one of
// them only cares that it gets a working client, and an *unpooled* client
// works perfectly well. Stripping `withPoolDefaults` out of the factory was
// mutation-tested against the DB-backed suites and survived: 48 tests across
// three files passed with the pooling removed. That is exactly the
// silent-green failure this repo has been bitten by before — heavy usage
// mistaken for coverage — so the pooling needs a test that looks at the
// value the constructor actually received, the same way `prisma.test.ts`
// guards the server-side singleton.
import { afterEach, describe, expect, it, vi } from "vitest";

const RAW_URL = "postgresql://test:test@localhost:5432/test";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@prisma/client");
});

/**
 * Imports the factory with `@prisma/client` mocked, calls it, and returns the
 * options object the `PrismaClient` constructor was handed.
 *
 * Inspecting the constructor argument is the point: a raw URL is just as
 * valid a constructor argument as a pooled one, so asserting that the call
 * merely succeeds would pass with the pooling deleted.
 */
async function optionsPassedToConstructor(
  url: string,
  extra?: Record<string, unknown>,
): Promise<{ datasourceUrl?: string }> {
  const PrismaClientMock = vi.fn();
  vi.doMock("@prisma/client", () => ({ PrismaClient: PrismaClientMock }));
  vi.resetModules();

  const { createTestPrismaClient } = await import("./helpers/test-prisma-client");
  createTestPrismaClient(url, extra as never);

  expect(PrismaClientMock).toHaveBeenCalledTimes(1);
  return (PrismaClientMock.mock.calls[0]?.[0] ?? {}) as { datasourceUrl?: string };
}

describe("createTestPrismaClient", () => {
  it("applies a bounded connection_limit rather than passing the URL through unmodified", async () => {
    const { TEST_CONNECTION_LIMIT } = await import("./helpers/test-prisma-client");
    const options = await optionsPassedToConstructor(RAW_URL);

    expect(options.datasourceUrl).toBeDefined();
    const params = new URL(options.datasourceUrl!).searchParams;
    expect(params.get("connection_limit")).toBe(String(TEST_CONNECTION_LIMIT));
    // The whole point of the row this fixes: without an explicit limit,
    // Prisma derives `num_cpus * 2 + 1` per client — 65 on a 32-core
    // machine, against a default `max_connections` of 100.
    expect(options.datasourceUrl).not.toBe(RAW_URL);
  });

  it("applies a pool_timeout so exhaustion fails with a typed error instead of hanging", async () => {
    const { TEST_POOL_TIMEOUT_SECONDS } = await import("./helpers/test-prisma-client");
    const options = await optionsPassedToConstructor(RAW_URL);

    const params = new URL(options.datasourceUrl!).searchParams;
    expect(params.get("pool_timeout")).toBe(String(TEST_POOL_TIMEOUT_SECONDS));
  });

  it("keeps the test limit well under Postgres's default max_connections", async () => {
    const { TEST_CONNECTION_LIMIT } = await import("./helpers/test-prisma-client");
    // Vitest runs one worker per test file, so the bound that matters is the
    // product across live workers — not any single client's appetite. This
    // asserts the number stays in the range that makes that product safe; it
    // fails if someone raises it back toward Prisma's derived default.
    expect(TEST_CONNECTION_LIMIT).toBeGreaterThanOrEqual(2);
    expect(TEST_CONNECTION_LIMIT).toBeLessThanOrEqual(10);
  });

  it("lets an explicit connection_limit already on the URL win", async () => {
    // `withPoolDefaults` only fills in what is absent, which is what allows
    // db-pool.test.ts to drive the pool to a deliberate edge.
    const options = await optionsPassedToConstructor(`${RAW_URL}?connection_limit=1`);

    const params = new URL(options.datasourceUrl!).searchParams;
    expect(params.get("connection_limit")).toBe("1");
  });

  it("preserves caller options such as query logging alongside the pooled URL", async () => {
    const log = [{ emit: "event", level: "query" }];
    const options = (await optionsPassedToConstructor(RAW_URL, { log })) as {
      datasourceUrl?: string;
      log?: unknown;
    };

    expect(options.log).toEqual(log);
    expect(new URL(options.datasourceUrl!).searchParams.get("connection_limit")).toBeTruthy();
  });
});
