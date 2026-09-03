// `get_crew_name` against a real Postgres — SCHEMA.md §9, §18, MILESTONES.md
// #82. Same shape as tests/claim-release-heartbeat-checkpoint-note.test.ts:
// a real ServiceRuntime against a scratch database, driven through
// `runtime.call`, which is what proves this operation is actually reachable
// through the one door every adapter uses (`callOperation` → the registry)
// rather than merely a function that compiles.
//
// **What this file does NOT re-prove.** The atomicity claim — that
// `handOutName` never gives two concurrent callers the same name — is
// `agent-names.ts`'s own property, and it is proven under real concurrency,
// many rounds, in tests/agent-names.test.ts. Re-running that race through
// the operation layer here would prove nothing new about *this* operation;
// what this operation adds on top of `handOutName` is input validation and
// the empty-pool-to-`ConflictError` mapping, so that is what these cases
// target — the same "what's actually new here" scoping
// tests/claim-release-heartbeat-checkpoint-note.test.ts's own header states
// for its four operations wrapping `claims.ts`.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_crew_name against Postgres", () => {
  const dbName = scratchDatabaseName("get_crew_name_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let nameCounter = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** Seeds one fresh, unheld, unretired agent name and returns it. */
  async function seedName(prefix = "agent"): Promise<string> {
    nameCounter += 1;
    const name = `${prefix}-${nameCounter}`;
    await prisma.agent.create({ data: { name } });
    return name;
  }

  it("hands out an available name through the operation, end to end", async () => {
    const name = await seedName();
    const result = (await runtime.call("get_crew_name", { sessionId: "s1" })) as {
      name: string;
      heldBySessionId: string | null;
    };
    expect(result.name).toBe(name);
    expect(result.heldBySessionId).toBe("s1");

    const row = await prisma.agent.findUniqueOrThrow({ where: { name } });
    expect(row.heldBySessionId).toBe("s1");
  });

  it("refuses a missing sessionId with invalid_input, before it ever reaches handOutName", async () => {
    const error = await runtime.call("get_crew_name", {}).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("invalid_input");
    expect((error as { fields: string[] }).fields).toEqual(["sessionId"]);
  });

  it("refuses an unrecognised field, honouring the schema's own .strict()", async () => {
    const error = await runtime
      .call("get_crew_name", { sessionId: "s1", bogus: "x" })
      .catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("invalid_input");
  });

  it("refuses with conflict, not a silent empty success, when the pool is exhausted", async () => {
    // No names seeded in this scratch DB at this point in the file.
    let thrown: unknown;
    try {
      await runtime.call("get_crew_name", { sessionId: "s-empty" });
    } catch (error) {
      thrown = error;
    }
    // Mutation evidence: deleting the `if (!name) throw ...` guard in
    // get-crew-name.ts's handler would make this call resolve with
    // `undefined` instead of throwing — this assertion is what catches
    // that, not merely "the call didn't crash".
    expect(thrown).toBeDefined();
    expect((thrown as { code: string }).code).toBe("conflict");
  });

  it("does not hand out a name already held by a different session", async () => {
    await seedName("held");
    const first = await runtime.call("get_crew_name", { sessionId: "s1" });
    expect(first).toBeDefined();

    // No other unheld, unretired names exist at this point in this file's
    // own scratch DB, so a second call must be refused rather than handing
    // out the same row twice.
    const error = await runtime.call("get_crew_name", { sessionId: "s2" }).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("conflict");
  });
});
