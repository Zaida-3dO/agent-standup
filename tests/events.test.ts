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
import type { PrismaClient } from "@prisma/client";
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
import { createTestPrismaClient } from "./helpers/test-prisma-client";
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
    prisma = createTestPrismaClient(scratchUrl);

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

  /**
   * Reads until `itemIds` are all visible, or gives up.
   *
   * **Why a wait is correct here rather than a papered-over race.** The
   * horizon is `pg_snapshot_xmin`, which is **server-wide**: it is held back
   * by the oldest transaction open anywhere on the instance, including the
   * other DB-backed test files running in parallel against their own scratch
   * databases. So "this test's writer has committed" does not imply "the
   * horizon has advanced past it" — a foreign transaction can keep a legally
   * committed row withheld for as long as it stays open.
   *
   * That is the documented, deliberate cost of the bound, not a bug, and it
   * is the root cause of this file's known flake (#122): the negative
   * assertions are stable, but the *positive* ones after a release assumed
   * the horizon moved the instant the local transaction ended.
   *
   * Polling keeps the assertion honest — it still fails if the row never
   * arrives — while not failing on an unrelated transaction's timing.
   *
   * The budget is ~20s against this file's 30s per-test timeout. That is
   * deliberately generous: when the whole suite runs, several DB-backed files
   * hold transactions open concurrently, and a horizon held back for a few
   * seconds is normal rather than a symptom. A tighter budget turns ordinary
   * contention into a red test, which is the failure mode being fixed.
   */
  async function readUntilVisible(itemIds: readonly string[], attempts = 200) {
    let last: Awaited<ReturnType<typeof readSinceBounded>> = { events: [], horizon: 0n };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = await prisma.$transaction(async (tx) => readSinceBounded(tx, { since: 0n }));
      const seen = new Set(last.events.map((event) => event.itemId));
      if (itemIds.every((id) => seen.has(id))) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return last;
  }

  describe("readSinceBounded never returns a row from a still-open transaction", () => {
    it("excludes a row written by a transaction that has not yet committed", async () => {
      const itemId = "item-in-flight";
      await seedItem(prisma, itemId);

      // Opens a transaction, appends an event, but does not resolve the
      // promise (does not commit) before the read below runs.
      let releaseHold: (() => void) | undefined;
      let inserted: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      // Signalled by the writer once its INSERT has actually run, rather than
      // waiting a fixed interval and hoping. A sleep here is load-dependent:
      // on a busy server the insert may not have happened by the time the
      // assertion reads, and the test then fails for a reason unrelated to
      // the property it checks (#122).
      const hasInserted = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      const inFlight = prisma.$transaction(async (tx) => {
        await appendEvent(tx, {
          itemId,
          actor: { actorType: "system" },
          type: "note",
          payload: {},
          body: "in flight",
        });
        inserted!();
        await held; // hold the transaction open until the assertion below runs
      });

      await hasInserted;

      const { events } = await prisma.$transaction(async (tx) =>
        readSinceBounded(tx, { since: 0n }),
      );
      const forThisItem = events.filter((e) => e.itemId === itemId);
      // The row exists in the table (uncommitted reads aside — this proves
      // the *bound*, not raw visibility) but must not appear in a
      // horizon-bounded read while its writer is still open.
      //
      // **What this case does NOT prove**, and why the case after it exists:
      // an uncommitted row is invisible under READ COMMITTED regardless of
      // the horizon, so deleting the `"txId" < $2` bound entirely leaves this
      // assertion passing. The bound's real job is the *committed-out-of-
      // order* case below.
      expect(forThisItem.length).toBe(0);

      releaseHold!();
      await inFlight;

      const after = await readUntilVisible([itemId]);
      expect(after.events.filter((e) => e.itemId === itemId).length).toBe(1);
      // 30s, matching the other DB-backed files: `readUntilVisible` may poll
      // for several seconds when a foreign transaction is holding the
      // server-wide horizon back, which the 5s default does not allow for.
    }, 30_000);

    it("withholds a later row that committed while an earlier writer is still open", async () => {
      // **The case the horizon bound actually exists for**, and the one
      // nothing covered — `WHERE "id" > $1 AND "txId" < $2` could be replaced
      // with `$2::bigint IS NOT NULL`, deleting the guarantee outright, and
      // the whole suite still passed (#122).
      //
      // The invariant from SCHEMA.md §3 is that this read "never skips a
      // row": a caller that reads up to `id = N` and next calls with
      // `since = N` must not have missed anything below N. That is violated
      // only when a row with a LOWER id commits AFTER one with a higher id
      // was already returned. So the scenario has to be:
      //
      //   writer A  ── inserts id=N   ───────────(still open)──────► commits
      //   writer B  ─────── inserts id=N+1, commits ──┐
      //   reader                                      └─ must NOT see N+1
      //
      // If the reader took N+1 here, it would advance `since` past N, and A's
      // row would never be returned by any later call. Bounding by the
      // horizon holds N+1 back until A finishes, which is exactly the cost
      // the function's header describes as real and deliberate.
      const earlyItem = "item-early-writer";
      const lateItem = "item-late-writer";
      await seedItem(prisma, earlyItem);
      await seedItem(prisma, lateItem);

      let releaseEarly: (() => void) | undefined;
      let earlyInserted: (() => void) | undefined;
      const earlyHeld = new Promise<void>((resolve) => {
        releaseEarly = resolve;
      });
      const earlyHasInserted = new Promise<void>((resolve) => {
        earlyInserted = resolve;
      });

      // A: inserts first (so it takes the lower id) and stays open.
      const early = prisma.$transaction(async (tx) => {
        await appendEvent(tx, {
          itemId: earlyItem,
          actor: { actorType: "system" },
          type: "note",
          payload: {},
          body: "early writer, still open",
        });
        earlyInserted!();
        await earlyHeld;
      });

      await earlyHasInserted;

      // B: inserts second and commits immediately, while A is still open.
      await prisma.$transaction(async (tx) => {
        await appendEvent(tx, {
          itemId: lateItem,
          actor: { actorType: "system" },
          type: "note",
          payload: {},
          body: "late writer, committed",
        });
      });

      const { events } = await prisma.$transaction(async (tx) =>
        readSinceBounded(tx, { since: 0n }),
      );

      // B's row is committed and fully visible to an ordinary SELECT — this
      // is not a visibility effect, it is the horizon holding it back.
      const rawlyVisible = await prisma.event.count({ where: { itemId: lateItem } });
      expect(rawlyVisible).toBe(1);
      expect(events.filter((e) => e.itemId === lateItem).length).toBe(0);
      expect(events.filter((e) => e.itemId === earlyItem).length).toBe(0);

      // And once A finishes, both become readable — fail-closed must not mean
      // withheld forever, or the ledger would stall behind one long writer.
      releaseEarly!();
      await early;

      const after = await readUntilVisible([earlyItem, lateItem]);
      expect(after.events.filter((e) => e.itemId === earlyItem).length).toBe(1);
      expect(after.events.filter((e) => e.itemId === lateItem).length).toBe(1);
    }, 30_000);
  });
});
