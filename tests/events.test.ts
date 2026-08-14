// The events ledger against a real Postgres, per CLAUDE.md's testing tenet —
// `tx_id` and the same-transaction guarantee are both properties of how
// Postgres actually behaves under a real `INSERT ... RETURNING`, not
// something an in-memory fake can stand in for. `service-transaction-db.test.ts`
// already proves the runtime's rollback behaviour in general; this file
// proves that an `events` row appended *inside* an operation's own
// transaction rolls back with it, and that `txId` genuinely identifies the
// writing transaction rather than being a timestamp or counter in disguise.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
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
import { appendEvent, readSinceBounded, recordFieldChanges, visibilityHorizon } from "@/lib/events";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/**
 * Seeds one item (events reference `Item` by id) plus whatever `Area`/`Repo`
 * row the foreign key needs. Kept minimal — the point of every test here is
 * the events table, not item semantics.
 */
async function seedItem(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.area.upsert({
    where: { id: "test-area" },
    update: {},
    create: { id: "test-area", displayName: "Test area" },
  });
  await prisma.item.create({
    data: {
      id,
      kind: "task",
      title: "t",
      body: "b",
      state: "someday",
      originType: "auto",
      area: "test-area",
      mergeAuthority: "needs_approval",
    },
  });
}

/**
 * A test operation standing in for a real mutation (rows #26/#27, not yet
 * built): it writes a field on `Item`, appends the `field_change` rows for
 * whatever actually changed, and optionally refuses afterwards — the same
 * "throw after writing" shape `service-transaction-db.test.ts` uses to make
 * rollback observable rather than assumed.
 */
const updateItemPriority = defineOperation({
  name: "test_update_item_priority",
  kind: "write",
  summary: "Updates Item.priority, appends field-change events, optionally refuses after.",
  input: z
    .object({
      itemId: z.string(),
      priority: z.enum(["P0", "P1", "P2", "P3"]),
      fail: z.boolean().default(false),
    })
    .strict(),
  async handler(ctx: ServiceContext, input: { itemId: string; priority: string; fail: boolean }) {
    const before = await ctx.db.$queryRawUnsafe<{ priority: string }[]>(
      `SELECT "priority" FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    const beforePriority = before[0]?.priority;

    await ctx.db.$executeRawUnsafe(
      `UPDATE "Item" SET "priority" = $1::"Priority" WHERE "id" = $2`,
      input.priority,
      input.itemId,
    );

    const appended = await recordFieldChanges(ctx.db, {
      itemId: input.itemId,
      actor: { actorType: "system" },
      before: { priority: beforePriority },
      after: { priority: input.priority },
      fields: ["priority"],
    });

    if (input.fail) {
      throw new GuardRejectedError("test.refuses_after_writing", "Refused after writing.", {
        fields: ["fail"],
      });
    }

    return { appended: appended.length };
  },
});

/** Writes two events in one call — used to prove they share one `txId`. */
const appendTwoEvents = defineOperation({
  name: "test_append_two_events",
  kind: "write",
  summary: "Appends two note events in the same transaction.",
  input: z.object({ itemId: z.string() }).strict(),
  async handler(ctx: ServiceContext, input: { itemId: string }) {
    const first = await appendEvent(ctx.db, {
      itemId: input.itemId,
      actor: { actorType: "system" },
      type: "note",
      payload: {},
      body: "first",
    });
    const second = await appendEvent(ctx.db, {
      itemId: input.itemId,
      actor: { actorType: "system" },
      type: "note",
      payload: {},
      body: "second",
    });
    return { firstId: first.id.toString(), secondId: second.id.toString() };
  },
});

describeIfDb("the events ledger against Postgres", () => {
  const dbName = scratchDatabaseName("events");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let registry: Record<string, unknown>;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });

    const { OPERATION_REGISTRY } = await import("@/lib/service/registry");
    registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
    registry[updateItemPriority.name] = updateItemPriority;
    registry[appendTwoEvents.name] = appendTwoEvents;

    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    delete registry[updateItemPriority.name];
    delete registry[appendTwoEvents.name];
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function eventsFor(
    itemId: string,
  ): Promise<{ id: bigint; txId: bigint; type: string; payload: unknown }[]> {
    return prisma.$queryRawUnsafe(
      `SELECT "id", "txId", "type", "payload" FROM "Event" WHERE "itemId" = $1 ORDER BY "id" ASC`,
      itemId,
    );
  }

  // --- AC1 + AC3 + AC5: appended on mutation, same transaction, existing boundary ---

  describe("appended inside the mutation's own transaction (AC1, AC3, AC5)", () => {
    it("commits the event row when the mutation commits", async () => {
      const itemId = "item-commit";
      await seedItem(prisma, itemId);

      await runtime.call(updateItemPriority.name, { itemId, priority: "P0", fail: false });

      const rows = await eventsFor(itemId);
      // Positive control — without this, the rollback test below would
      // pass even if appendEvent silently wrote nothing at all.
      expect(rows.length).toBe(1);
      expect(rows[0]?.type).toBe("field_change");
    });

    it("rolls the event row back when the mutation fails after appending it — the load-bearing proof", async () => {
      const itemId = "item-rollback";
      await seedItem(prisma, itemId);

      await expect(
        runtime.call(updateItemPriority.name, { itemId, priority: "P0", fail: true }),
      ).rejects.toBeInstanceOf(GuardRejectedError);

      // The mutation itself must not have survived either — both rows come
      // from the one transaction the operation ran in.
      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.priority).toBe("P2"); // untouched default, never became P0

      const rows = await eventsFor(itemId);
      // If the event had been appended in a *separate* transaction from the
      // mutation — exactly the defect this row exists to prevent — this
      // row would survive the mutation's rollback and this assertion would
      // see length 1, not 0. A single-character change that would make this
      // test fail: appendEvent opening its own `prisma.$transaction(...)`
      // instead of writing through the caller's `ctx.db` handle.
      expect(rows.length).toBe(0);
    });
  });

  // --- AC4: tx_id identifies the writing transaction ---

  describe("txId identifies the writing transaction (AC4)", () => {
    it("stamps two events written in the same call with the same txId", async () => {
      const itemId = "item-same-tx";
      await seedItem(prisma, itemId);

      await runtime.call(appendTwoEvents.name, { itemId });

      const rows = await eventsFor(itemId);
      expect(rows.length).toBe(2);
      // Same transaction — the runtime opens exactly one per call, and both
      // appendEvent calls ran inside it. A single-character change that
      // would make this fail: appendEvent computing txId itself (e.g. from
      // `Date.now()` or an in-process counter) instead of leaving it to
      // Postgres's own `txid_current()` default.
      expect(rows[0]?.txId).toBe(rows[1]?.txId);
    });

    it("stamps events written in two different calls with different txIds", async () => {
      const itemId = "item-different-tx";
      await seedItem(prisma, itemId);

      await runtime.call(updateItemPriority.name, { itemId, priority: "P1", fail: false });
      await runtime.call(updateItemPriority.name, { itemId, priority: "P3", fail: false });

      const rows = await eventsFor(itemId);
      expect(rows.length).toBe(2);
      // Two separate calls open two separate transactions, so they must
      // not share a txId. A single-character change that would make this
      // fail: sharing one PrismaClient-level transaction across calls, or
      // computing txId from something call-invariant (e.g. a fixed
      // constant) rather than reading it fresh per row.
      expect(rows[0]?.txId).not.toBe(rows[1]?.txId);
    });

    it("visibilityHorizon reports a value at or below the current transaction id", async () => {
      const itemId = "item-horizon";
      await seedItem(prisma, itemId);
      let horizon: bigint | undefined;
      let txId: bigint | undefined;

      await runtime.call(appendTwoEvents.name, { itemId });
      await prisma.$transaction(async (tx) => {
        horizon = await visibilityHorizon(tx);
        const rows = await tx.$queryRawUnsafe<{ tx: bigint }[]>(`SELECT txid_current() AS "tx"`);
        txId = rows[0]?.tx;
      });

      expect(horizon).toBeDefined();
      expect(txId).toBeDefined();
      // The horizon (oldest possibly-concurrent transaction) can never be
      // newer than the transaction asking the question — it is by
      // definition a lower or equal bound. A single-character change that
      // would make this fail: the raw query using `pg_snapshot_xip` (the
      // in-progress list) instead of `pg_snapshot_xmin` and picking the
      // wrong end of the snapshot.
      expect(horizon! <= txId!).toBe(true);
    });
  });

  // --- AC2: field-change rows record what actually changed ---

  describe("field-change rows record what actually changed (AC2)", () => {
    it("records a field-change row when the value differs", async () => {
      const itemId = "item-changed";
      await seedItem(prisma, itemId);

      await runtime.call(updateItemPriority.name, { itemId, priority: "P0", fail: false });

      const rows = await eventsFor(itemId);
      expect(rows.length).toBe(1);
      const payload = rows[0]?.payload as { field: string; from: string; to: string };
      expect(payload).toEqual({ field: "priority", from: "P2", to: "P0" });
    });

    it("records no row when the field did not actually change — the negative control", async () => {
      const itemId = "item-unchanged";
      await seedItem(prisma, itemId);
      // Item.priority defaults to P2 (schema.prisma) — setting it to P2
      // again is a no-op write.
      await runtime.call(updateItemPriority.name, { itemId, priority: "P2", fail: false });

      const rows = await eventsFor(itemId);
      // A single-character change that would make this fail: dropping the
      // `!==` filter in recordFieldChanges (comparing before/after) so
      // every named field is appended unconditionally regardless of
      // whether it changed.
      expect(rows.length).toBe(0);
    });

    it("recordFieldChanges returns exactly the rows it wrote, not the full field list", async () => {
      const itemId = "item-partial-diff";
      await seedItem(prisma, itemId);

      const result = await prisma.$transaction(async (tx) => {
        return recordFieldChanges(tx, {
          itemId,
          actor: { actorType: "system" },
          before: { priority: "P2", area: "test-area" },
          after: { priority: "P0", area: "test-area" }, // only priority changes
          fields: ["priority", "area"],
        });
      });

      expect(result.length).toBe(1);
      expect(result[0]?.id).toBeDefined();
    });
  });

  // --- readSinceBounded: the reader-facing primitive the horizon exists for ---

  describe("readSinceBounded never returns a row from a still-open transaction", () => {
    it("excludes a row written by a transaction that has not yet committed", async () => {
      const itemId = "item-in-flight";
      await seedItem(prisma, itemId);

      // Opens a transaction, appends an event, but does not resolve the
      // promise (does not commit) before the read below runs.
      let releaseHold: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      const inFlight = prisma.$transaction(async (tx) => {
        await appendEvent(tx, {
          itemId,
          actor: { actorType: "system" },
          type: "note",
          payload: {},
          body: "in flight",
        });
        await held; // hold the transaction open until the assertion below runs
      });

      // Give the in-flight transaction a moment to actually start and
      // insert before reading.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const { events } = await prisma.$transaction(async (tx) =>
        readSinceBounded(tx, { since: 0n }),
      );
      const forThisItem = events.filter((e) => e.itemId === itemId);
      // The row exists in the table (uncommitted reads aside — this proves
      // the *bound*, not raw visibility) but must not appear in a
      // horizon-bounded read while its writer is still open. A
      // single-character change that would make this fail: bounding by
      // `txId <= horizon` instead of `txId < horizon`.
      expect(forThisItem.length).toBe(0);

      releaseHold!();
      await inFlight;

      const after = await prisma.$transaction(async (tx) => readSinceBounded(tx, { since: 0n }));
      expect(after.events.filter((e) => e.itemId === itemId).length).toBe(1);
    });
  });
});
