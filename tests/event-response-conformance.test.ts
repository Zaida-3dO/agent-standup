// The event-returning operations, compared across bindings against the
// **real** service rather than a fake.
//
// Why this file exists rather than an assertion added to the existing parity
// test. That test mocks the service, which is right for proving the routing:
// it needs no database and it drives both bindings through real route
// handlers. But a fake's return shape is written by hand, and a fake that
// returns a field the real operation does not creates a divergence that only
// exists in the test — which is exactly what happened. A parity suite whose
// two sides both read from the same fake can prove the transports agree with
// each other, and cannot prove either agrees with the service.
//
// So this asserts the contract at its source: what the operation actually
// returns, and what the adapter actually carries, are the same set of fields.
// `insertEventRow` runs `INSERT ... RETURNING "id", "txId", "ts"` — `body` is
// written to the row and never read back — so the honest claim is that both
// bindings expose those three fields and nothing else.
//
// Runs against a real Postgres, because "what does the operation return" is
// settled by the RETURNING clause and nothing shorter. Skips without
// TEST_DATABASE_URL, the same convention as every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { serializeAppendedEvent } from "@/app/api/_shared/respond";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** The fields an `AppendedEvent` carries, named once so both sides compare to the same list. */
const APPENDED_EVENT_FIELDS = ["id", "ts", "txId"] as const;

describeIfDb("event responses conform across bindings, against Postgres", () => {
  const dbName = scratchDatabaseName("event_response_conformance");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const url = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(url);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  let counter = 0;
  async function seedItem(): Promise<string> {
    counter += 1;
    const id = `conformance-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${counter}`,
        body: "body",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

  async function claimFor(itemId: string, sessionId: string): Promise<void> {
    await prisma.assignment.create({
      data: {
        itemId,
        holderType: "agent",
        holderId: "agent-a",
        sessionId,
        rootSessionId: sessionId,
        machine: "laptop",
        role: "builder",
      },
    });
  }

  const cases = [
    {
      name: "note",
      run: async () => {
        const itemId = await seedItem();
        return runtime.call("note", { itemId, body: "a remark" });
      },
    },
    {
      name: "checkpoint",
      run: async () => {
        const itemId = await seedItem();
        await claimFor(itemId, "session-1");
        return runtime.call("checkpoint", { itemId, sessionId: "session-1", body: "checked in" });
      },
    },
  ] as const;

  for (const { name, run } of cases) {
    describe(name, () => {
      it("returns exactly the AppendedEvent fields from the service", async () => {
        // Through `unknown`: the point is to inspect the key set at run time,
        // which means deliberately setting aside what the static type claims
        // it is — the static type is the thing under test here.
        const result = (await run()) as unknown as Record<string, unknown>;
        // The claim the adapter's shaping depends on. If a later change made
        // the RETURNING clause carry `body`, this fails and the adapter's
        // own assertion below stops being the whole story.
        expect(Object.keys(result).sort()).toEqual([...APPENDED_EVENT_FIELDS]);
        expect(typeof result.id).toBe("bigint");
        expect(typeof result.txId).toBe("bigint");
        expect(result.ts).toBeInstanceOf(Date);
      });

      it("carries every one of those fields over the HTTP encoding, dropping none", async () => {
        const result = (await run()) as { id: bigint; txId: bigint; ts: Date };
        const serialized = serializeAppendedEvent(result);

        // The divergence question, asked directly: the transport must expose
        // the same field set the service returned. Removing `ts` from
        // `serializeAppendedEvent`'s returned object makes this fail.
        expect(Object.keys(serialized).sort()).toEqual([...APPENDED_EVENT_FIELDS]);
        // And the values must survive the encoding rather than merely the
        // keys — `bigint` as a string, so a JS client parsing the JSON does
        // not silently round it to an imprecise `number`.
        expect(serialized.id).toBe(String(result.id));
        expect(serialized.txId).toBe(String(result.txId));
        expect(serialized.ts).toBe(result.ts.toISOString());
      });

      it("writes the body to the row even though it returns none", async () => {
        const result = (await run()) as { id: bigint };
        const rows = await prisma.$queryRawUnsafe<{ body: string | null }[]>(
          `SELECT "body" FROM "Event" WHERE "id" = $1`,
          result.id,
        );
        // The reason "no `body` in the response" is a contract rather than a
        // loss: the prose is stored and readable, it is simply not echoed
        // back by the write. Asserting it here stops a future reader
        // concluding from the two tests above that `body` goes nowhere.
        expect(rows[0]?.body).not.toBeNull();
      });
    });
  }
});
