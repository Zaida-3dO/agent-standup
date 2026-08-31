// Promoting a usage snapshot onto an account — MILESTONES.md #56, SCHEMA.md §15.
//
// A real database, because the properties under test are database
// properties: the machine-to-account join, a COALESCE that must leave an
// unreported figure alone, and above all the WHERE clause that makes the
// write last-taken-wins rather than last-written-wins. An in-memory model
// would prove none of them, and the ordering rule in particular is the one
// a plausible refactor drops.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promoteUsage } from "@/lib/budget/promote";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** Two clearly different instants. Never the same value on both sides. */
const EARLIER = new Date("2026-08-31T10:00:00.000Z");
const LATER = new Date("2026-08-31T12:00:00.000Z");

describeIfDb("promoteUsage", () => {
  const dbName = scratchDatabaseName("budget_promote");
  let prisma: PrismaClient;

  beforeAll(async () => {
    const scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** A machine wired to the named accounts, all freshly created. */
  async function wire(machine: string, accountIds: string[]): Promise<void> {
    await prisma.machine.create({ data: { name: machine, sourceGlobs: [] } });
    for (const id of accountIds) {
      await prisma.account.create({
        data: { id, vendor: "anthropic", displayName: id, planType: "subscription" },
      });
      await prisma.machineAccount.create({ data: { machineName: machine, accountId: id } });
    }
  }

  async function readAccount(id: string) {
    const row = await prisma.account.findUniqueOrThrow({ where: { id } });
    return {
      usage5h: row.usage5h === null ? null : Number(row.usage5h),
      usageWeekly: row.usageWeekly === null ? null : Number(row.usageWeekly),
      usageAt: row.usageAt,
    };
  }

  it("writes both figures and the time they were taken", async () => {
    await wire("machine-both", ["acct-both"]);

    const outcome = await promoteUsage(prisma, "machine-both", {
      usage5h: 40,
      usageWeekly: 55,
      takenAt: EARLIER,
    });

    expect(outcome).toEqual({ status: "written", accountIds: ["acct-both"] });
    const stored = await readAccount("acct-both");
    expect(stored.usage5h).toBe(40);
    expect(stored.usageWeekly).toBe(55);
    // The timestamp is the reporter's, not the server's clock at write
    // time — the whole staleness question is asked of this value.
    expect(stored.usageAt?.toISOString()).toBe(EARLIER.toISOString());
  });

  it("leaves a figure the reporter did not measure alone", async () => {
    await wire("machine-partial", ["acct-partial"]);
    await promoteUsage(prisma, "machine-partial", {
      usage5h: 10,
      usageWeekly: 20,
      takenAt: EARLIER,
    });

    // A later snapshot carrying only the 5-hour figure.
    await promoteUsage(prisma, "machine-partial", { usage5h: 30, takenAt: LATER });

    const stored = await readAccount("acct-partial");
    expect(stored.usage5h).toBe(30);
    // Not blanked: nothing claimed to have measured it this time.
    expect(stored.usageWeekly).toBe(20);
  });

  it("does nothing at all when the snapshot carries neither figure", async () => {
    await wire("machine-empty", ["acct-empty"]);
    await promoteUsage(prisma, "machine-empty", { usage5h: 60, takenAt: EARLIER });

    const outcome = await promoteUsage(prisma, "machine-empty", { takenAt: LATER });

    expect(outcome).toEqual({ status: "empty" });
    const stored = await readAccount("acct-empty");
    // The critical half: usageAt must NOT have advanced. A timestamp that
    // moved here would claim a measurement that never happened, and would
    // make a stale reading look fresh — the exact failure §15 warns about.
    expect(stored.usageAt?.toISOString()).toBe(EARLIER.toISOString());
    expect(stored.usage5h).toBe(60);
  });

  it("reports no-account for a machine wired to none, without failing", async () => {
    await prisma.machine.create({ data: { name: "machine-orphan", sourceGlobs: [] } });

    const outcome = await promoteUsage(prisma, "machine-orphan", {
      usage5h: 50,
      takenAt: EARLIER,
    });

    expect(outcome).toEqual({ status: "no-account" });
  });

  it("reports no-account for a machine the server has never heard of", async () => {
    const outcome = await promoteUsage(prisma, "machine-unknown", {
      usage5h: 50,
      takenAt: EARLIER,
    });

    expect(outcome).toEqual({ status: "no-account" });
  });

  it("writes to every account the machine is wired to, not just one", async () => {
    await wire("machine-multi", ["acct-multi-a", "acct-multi-b"]);

    const outcome = await promoteUsage(prisma, "machine-multi", {
      usage5h: 44,
      takenAt: EARLIER,
    });

    expect(outcome).toEqual({
      status: "written",
      accountIds: ["acct-multi-a", "acct-multi-b"],
    });
    expect((await readAccount("acct-multi-a")).usage5h).toBe(44);
    expect((await readAccount("acct-multi-b")).usage5h).toBe(44);
  });
  describe("the ordering rule: last taken wins, not last written", () => {
    it("refuses an older snapshot that arrives after a newer one", async () => {
      await wire("machine-order", ["acct-order"]);
      // The newer snapshot lands first, which is exactly the interleaving
      // two machines on one account produce.
      await promoteUsage(prisma, "machine-order", { usage5h: 90, takenAt: LATER });

      const outcome = await promoteUsage(prisma, "machine-order", {
        usage5h: 10,
        takenAt: EARLIER,
      });

      expect(outcome).toEqual({ status: "superseded" });
      const stored = await readAccount("acct-order");
      // Without the WHERE clause this reads 10 — a fresh 90% overwritten by
      // a two-hour-old 10%, and nothing in the row to say it happened.
      expect(stored.usage5h).toBe(90);
      expect(stored.usageAt?.toISOString()).toBe(LATER.toISOString());
    });

    it("accepts a snapshot taken after the one already stored", async () => {
      await wire("machine-order-ok", ["acct-order-ok"]);
      await promoteUsage(prisma, "machine-order-ok", { usage5h: 10, takenAt: EARLIER });

      const outcome = await promoteUsage(prisma, "machine-order-ok", {
        usage5h: 90,
        takenAt: LATER,
      });

      expect(outcome).toEqual({ status: "written", accountIds: ["acct-order-ok"] });
      expect((await readAccount("acct-order-ok")).usage5h).toBe(90);
    });

    it("refuses a snapshot taken at exactly the time already stored", async () => {
      // Re-delivery of the same snapshot, which a retrying reporter does.
      // Strictly-newer is the rule, so the second write is declined and the
      // outcome says so rather than reporting a write that changed nothing.
      await wire("machine-order-eq", ["acct-order-eq"]);
      await promoteUsage(prisma, "machine-order-eq", { usage5h: 70, takenAt: LATER });

      const outcome = await promoteUsage(prisma, "machine-order-eq", {
        usage5h: 71,
        takenAt: LATER,
      });

      expect(outcome).toEqual({ status: "superseded" });
      expect((await readAccount("acct-order-eq")).usage5h).toBe(70);
    });

    it("writes to an account with no reading at all, where there is nothing to be newer than", async () => {
      // The IS NULL half of the guard. An implementation testing only
      // `usageAt < $4` writes nothing here, and the very first reading an
      // installation ever takes would be silently dropped.
      await wire("machine-first", ["acct-first"]);

      const outcome = await promoteUsage(prisma, "machine-first", {
        usage5h: 5,
        takenAt: EARLIER,
      });

      expect(outcome).toEqual({ status: "written", accountIds: ["acct-first"] });
      expect((await readAccount("acct-first")).usage5h).toBe(5);
    });

    it("writes only to the accounts that are behind, when they disagree", async () => {
      // One account already knows something newer; its sibling does not.
      // The outcome names the ones that actually moved.
      await wire("machine-split", ["acct-split-ahead", "acct-split-behind"]);
      await prisma.account.update({
        where: { id: "acct-split-ahead" },
        data: { usage5h: 99, usageAt: LATER },
      });

      const between = new Date("2026-08-31T11:00:00.000Z");
      const outcome = await promoteUsage(prisma, "machine-split", {
        usage5h: 33,
        takenAt: between,
      });

      expect(outcome).toEqual({ status: "written", accountIds: ["acct-split-behind"] });
      expect((await readAccount("acct-split-ahead")).usage5h).toBe(99);
      expect((await readAccount("acct-split-behind")).usage5h).toBe(33);
    });
  });
});
