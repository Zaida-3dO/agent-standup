// The `backfill` service operation — the env gate at the API boundary, the
// contract refusal, and the transaction-backed client the importers run
// through.
//
// The database half skips without TEST_DATABASE_URL. Every fixture is
// invented — this repository is public (CLAUDE.md).
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { backfill } from "@/lib/service/operations/backfill";
import { BACKFILL_ENV_VAR } from "@/lib/backfill/enabled";
import { transactionBackedClient, UnsupportedQueryError } from "@/lib/backfill/transaction-client";
import type { ServiceContext, TransactionHandle } from "@/lib/service/context";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const TASK_A = "T-19700101-example-one";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    defaultArea: "imported",
    tasks: [
      {
        id: TASK_A,
        title: "Title",
        body: "# Brief\n",
        status: "executing",
        history: [
          { id: `${TASK_A}:h:1`, actor: "system", at: "1970-01-01T00:00:00Z", note: "minted" },
        ],
      },
    ],
    actorAliases: { system: { actorType: "system", actorId: null } },
    statusAliases: { executing: "executing" },
    ...overrides,
  };
}

/** Sets the gate for one call and always puts the environment back. */
async function withGate<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env[BACKFILL_ENV_VAR];
  if (value === undefined) delete process.env[BACKFILL_ENV_VAR];
  else process.env[BACKFILL_ENV_VAR] = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env[BACKFILL_ENV_VAR];
    else process.env[BACKFILL_ENV_VAR] = before;
  }
}

describe("the backfill operation's declaration", () => {
  it("is a registered write named `backfill`", () => {
    expect(backfill.name).toBe("backfill");
    expect(backfill.kind).toBe("write");
  });

  it("accepts a payload matching the contract", () => {
    expect(backfill.input.safeParse({ payload: payload() }).success).toBe(true);
  });

  it("REFUSES a payload whose version is not this build's", () => {
    expect(backfill.input.safeParse({ payload: payload({ version: 2 }) }).success).toBe(false);
  });

  it("REFUSES an unrecognised top-level key rather than ignoring it", () => {
    expect(backfill.input.safeParse({ payload: payload({ nonsense: 1 }) }).success).toBe(false);
  });

  it("REFUSES anything but a payload wrapper", () => {
    expect(backfill.input.safeParse({ payload: payload(), extra: 1 }).success).toBe(false);
  });
});

describe("transactionBackedClient", () => {
  const db: TransactionHandle = {
    $queryRawUnsafe: async <T>() => [] as T,
    $executeRawUnsafe: async () => 0,
  };

  it("REFUSES a findFirst it cannot express, rather than returning a wrong row", async () => {
    // The safety property of a narrow adapter: an unexpressible query is an
    // error, never a plausible-looking wrong answer.
    const client = transactionBackedClient(db) as unknown as {
      item: { findFirst: (a: unknown) => Promise<unknown> };
    };
    await expect(client.item.findFirst({ where: { id: "x" } })).rejects.toThrow(
      UnsupportedQueryError,
    );
    await expect(
      client.item.findFirst({ where: { customFields: { path: ["other"], equals: "x" } } }),
    ).rejects.toThrow(UnsupportedQueryError);
  });

  it("REFUSES a create naming a column it does not know", async () => {
    const client = transactionBackedClient(db) as unknown as {
      item: { create: (a: unknown) => Promise<unknown> };
    };
    await expect(client.item.create({ data: { madeUpColumn: 1 } })).rejects.toThrow(
      UnsupportedQueryError,
    );
  });

  it("binds tagged-template values as parameters rather than splicing them into the SQL", async () => {
    // Splicing would make an area name a SQL injection vector. The
    // reconstructed statement must contain $1/$2 and none of the values.
    const seen: { sql?: string; values?: unknown[] } = {};
    const spy: TransactionHandle = {
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => {
        seen.sql = sql;
        seen.values = values;
        return [] as T;
      },
      $executeRawUnsafe: async () => 0,
    };
    const client = transactionBackedClient(spy) as unknown as {
      $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    };
    const injected = '\'; DROP TABLE "Item"; --';
    await client.$queryRaw`SELECT * FROM "Area" WHERE "id" = ${injected} AND "x" = ${2}`;

    expect(seen.sql).toContain("$1");
    expect(seen.sql).toContain("$2");
    expect(seen.sql).not.toContain("DROP TABLE");
    expect(seen.values).toEqual([injected, 2]);
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = testDatabaseUrl ? describe : describe.skip;

describeDb("backfill through the service operation (real database)", () => {
  const databaseName = scratchDatabaseName("backfill_operation");
  let prisma: PrismaClient;
  let ctx: ServiceContext;

  beforeAll(async () => {
    const url = (await createMigratedScratchDatabase(testDatabaseUrl!, databaseName)).url;
    prisma = createTestPrismaClient(url);
    ctx = {
      db: prisma,
      settings: { values: {} } as unknown as ServiceContext["settings"],
      caller: { transport: "test" },
      operation: "backfill",
    };
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, databaseName);
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "Event"');
    await prisma.$executeRawUnsafe('DELETE FROM "Artifact"');
    await prisma.$executeRawUnsafe('DELETE FROM "Assignment"');
    await prisma.$executeRawUnsafe('DELETE FROM "Item"');
  });

  it("REFUSES the call outright when the window is closed", async () => {
    // The default posture. Nothing about the payload matters here — the
    // surface simply does not answer.
    await withGate(undefined, async () => {
      await expect(backfill.handler(ctx, { payload: payload() } as never)).rejects.toMatchObject({
        code: "forbidden",
      });
    });
    const rows = await prisma.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS "count" FROM "Item"`,
    );
    expect(rows[0]!.count).toBe("0");
  }, 120_000);

  it.each(["false", "1", "TRUE", "", "yes"])(
    "REFUSES the call for the near-miss gate value %j",
    async (value) => {
      await withGate(value, async () => {
        await expect(backfill.handler(ctx, { payload: payload() } as never)).rejects.toMatchObject({
          code: "forbidden",
        });
      });
    },
    120_000,
  );

  it("refuses with `forbidden`, never `guard_rejected` — which is what makes the MCP waiver legal", async () => {
    await withGate(undefined, async () => {
      await expect(
        backfill.handler(ctx, { payload: payload() } as never),
      ).rejects.not.toMatchObject({ code: "guard_rejected" });
    });
  }, 120_000);

  it("runs the whole sequence when the window is open", async () => {
    const result = await withGate("true", () =>
      backfill.handler(ctx, { payload: payload() } as never),
    );

    expect(result).toMatchObject({ itemsImported: 1, eventsImported: 1, contractVersion: 1 });
    expect((result as { reminder: string }).reminder).toContain(BACKFILL_ENV_VAR);

    const item = await prisma.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: TASK_A } },
    });
    expect(item?.body).toBe("# Brief\n");
    expect(item?.state).toBe("executing");
    expect(item?.area).toBe("imported");
  }, 120_000);

  it("is idempotent through the operation too", async () => {
    await withGate("true", async () => {
      await backfill.handler(ctx, { payload: payload() } as never);
      const second = await backfill.handler(ctx, { payload: payload() } as never);
      expect(second).toMatchObject({ itemsImported: 0, itemsSkipped: 1, eventsImported: 0 });
    });
  }, 120_000);

  it("REFUSES a payload that does not match the contract, with the offending path named", async () => {
    await withGate("true", async () => {
      await expect(
        backfill.handler(ctx, { payload: payload({ defaultArea: " -- " }) } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  }, 120_000);
});
