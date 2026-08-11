// Exercises the pooling values from db-url.ts under real concurrency against
// a real Postgres — no stubbed client, no fake timers. Needs TEST_DATABASE_URL
// (see tests/boot.test.ts for why that's a separate var from DATABASE_URL);
// skips locally without it, always runs in CI.
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPoolDefaults } from "@/lib/db-url";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("connection pool under pressure — real Postgres, real concurrency", () => {
  const dbName = scratchDatabaseName("pool");
  let scratchUrl: string;

  beforeAll(() => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterAll(() => {
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("serves concurrent queries within pool capacity without any error", async () => {
    const url = withPoolDefaults(scratchUrl, { connectionLimit: 2, poolTimeoutSeconds: 5 });
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      // $executeRaw rather than $queryRaw — pg_sleep() returns `void`, which
      // Prisma can't deserialize as a query *result* column; $executeRaw
      // only needs the affected-row count, so it's unaffected.
      const results = await Promise.all([
        client.$executeRaw`SELECT pg_sleep(0.3)`,
        client.$executeRaw`SELECT pg_sleep(0.3)`,
      ]);
      expect(results).toHaveLength(2);
    } finally {
      await client.$disconnect();
    }
  });

  it("rejects with a typed, catchable P2024 once the pool is starved past its timeout — not a crash, not a silent hang", async () => {
    // connection_limit=1, pool_timeout=1s, three concurrent 1.5s queries: the
    // one holding the single connection finishes fine; anything still queued
    // when 1s of *waiting* has passed is guaranteed to time out, because the
    // query it's waiting behind won't free the connection until 1.5s.
    const url = withPoolDefaults(scratchUrl, { connectionLimit: 1, poolTimeoutSeconds: 1 });
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      const outcomes = await Promise.allSettled([
        client.$executeRaw`SELECT pg_sleep(1.5)`,
        client.$executeRaw`SELECT pg_sleep(1.5)`,
        client.$executeRaw`SELECT pg_sleep(1.5)`,
      ]);

      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");

      // The process didn't crash and this test didn't hang past its own
      // timeout — both are already proven just by reaching this line. What's
      // asserted explicitly: capacity was genuinely exceeded (at least one
      // rejection) without starving every request (at least one success),
      // and every rejection is Prisma's typed pool-timeout error, not some
      // other failure this test would be misrepresenting as "pool pressure".
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.length + rejected.length).toBe(3);

      for (const outcome of rejected) {
        if (outcome.status !== "rejected") continue;
        expect(outcome.reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((outcome.reason as Prisma.PrismaClientKnownRequestError).code).toBe("P2024");
      }
    } finally {
      await client.$disconnect();
    }
  }, 15_000);
});
