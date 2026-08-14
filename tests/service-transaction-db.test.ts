// The transaction boundary against a real Postgres, not a model of one.
//
// `tests/service-runtime.test.ts` proves the runtime's own behaviour — that
// it opens one boundary and lets a throw escape it — against an in-memory
// handle. What that cannot prove is the half the database owns: that the
// throw actually causes a `ROLLBACK`, and that a row written before the
// failure is genuinely not there afterwards. Only Postgres can answer that,
// so the claim is made here too.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
// CI always sets it, so this always runs where it matters.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GuardRejectedError,
  ServiceRuntime,
  defineOperation,
  prismaTransactionRunner,
  type ServiceContext,
} from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/**
 * Writes an area, then optionally refuses.
 *
 * `Area` is used because it exists in the baseline schema, has a unique
 * key, and belongs to no other in-flight row — the point is the boundary,
 * not the table.
 */
const createAreaThenMaybeFail = defineOperation({
  name: "test_create_area_then_maybe_fail",
  kind: "write",
  summary: "Inserts an area row and then optionally refuses, to exercise rollback.",
  input: z.object({ key: z.string(), fail: z.boolean() }).strict(),
  async handler(ctx: ServiceContext, input: { key: string; fail: boolean }) {
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $2)`,
      input.key,
      input.key,
    );
    if (input.fail) {
      // Thrown *after* a successful write, which is the only arrangement
      // that can tell a real rollback from an insert that never happened.
      throw new GuardRejectedError("test.refuses_after_writing", "Refused after writing.", {
        fields: ["fail"],
      });
    }
    return { created: input.key };
  },
});

describeIfDb("the transaction boundary against Postgres", () => {
  const dbName = scratchDatabaseName("service_tx");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let registry: Record<string, unknown>;

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });

    const { OPERATION_REGISTRY } = await import("@/lib/service/registry");
    registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
    registry[createAreaThenMaybeFail.name] = createAreaThenMaybeFail;

    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    delete registry[createAreaThenMaybeFail.name];
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function areaExists(key: string): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM "Area" WHERE "id" = $1`,
      key,
    );
    return (rows[0]?.count ?? 0n) > 0n;
  }

  it("commits the write when the operation succeeds", async () => {
    await runtime.call(createAreaThenMaybeFail.name, { key: "committed", fail: false });
    // The positive control. Without it, the rollback test below would pass
    // just as well against an operation whose insert never worked at all.
    expect(await areaExists("committed")).toBe(true);
  });

  it("rolls the write back when the operation refuses after writing", async () => {
    await expect(
      runtime.call(createAreaThenMaybeFail.name, { key: "rolled-back", fail: true }),
    ).rejects.toBeInstanceOf(GuardRejectedError);
    // Postgres, asked directly on a connection outside that transaction.
    // A runtime that caught the throw, or committed per statement, leaves
    // this row behind.
    expect(await areaExists("rolled-back")).toBe(false);
  });

  it("leaves no trace of a failed call for a key a later call can reuse", async () => {
    await expect(
      runtime.call(createAreaThenMaybeFail.name, { key: "reused", fail: true }),
    ).rejects.toThrow();
    // The practical consequence: `Area.id` is a primary key, so if the
    // failed insert had survived, this second call would fail on a unique
    // violation rather than succeed. That makes the rollback observable as
    // behaviour, not only as a count.
    await runtime.call(createAreaThenMaybeFail.name, { key: "reused", fail: false });
    expect(await areaExists("reused")).toBe(true);
  });

  it("surfaces a database-level failure as an internal error, not a raw driver throw", async () => {
    // A duplicate key: Postgres refuses, and the refusal must arrive
    // through the taxonomy rather than as whatever Prisma threw.
    await runtime.call(createAreaThenMaybeFail.name, { key: "duplicate", fail: false });
    const error = await runtime
      .call(createAreaThenMaybeFail.name, { key: "duplicate", fail: false })
      .catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("internal");
    // And the driver's message, which names the constraint and often the
    // connection, stayed in `cause`.
    expect((error as Error).message).not.toContain("Area_pkey");
  });
});
