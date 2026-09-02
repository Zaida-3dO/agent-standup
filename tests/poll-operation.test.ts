// The poll — MILESTONES.md #58, SCHEMA.md §19 `POST /poll`, §15, §17.7.
//
// Against a real Postgres, because what the poll does is almost entirely
// database work: an upsert that must create a machine row on first contact
// without clobbering an operator's override on later ones, a NULL-preserving
// read of that override, and a join to the accounts a machine may dispatch
// against.
//
// The property the milestone actually asks for is that the machine side stays
// dumb — so the assertions below are mostly about what the SERVER decided,
// not about what the caller sent.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot, type SettingsSnapshot } from "@/lib/settings";
import type { BandDecision } from "@/lib/budget/bands";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface PollResult {
  machine: string;
  overrodeMachine: string | null;
  intervalSeconds: number;
  sourceGlobs: readonly string[];
  pendingSourceCount: number;
  usage: { status: string; accountIds?: readonly string[] };
  bands: Readonly<Record<string, BandDecision>>;
  dispatches: readonly unknown[];
}

/** A window whose boundaries are constants, for banding assertions. */
function constantWindow(selective: number, windDown: number, stop: number) {
  return {
    enabled: true,
    lengthHours: 5,
    boundaries: {
      selective: { kind: "constant", value: selective },
      windDown: { kind: "constant", value: windDown },
      stop: { kind: "constant", value: stop },
    },
  };
}

describeIfDb("the poll", () => {
  const dbName = scratchDatabaseName("poll_op");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  /** Mutable so a test can poll under different configuration. */
  let snapshot: SettingsSnapshot;

  beforeAll(async () => {
    const scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    snapshot = defaultSnapshot();
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => snapshot,
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  // Every test starts from the shipped defaults, so no test can pass
  // because of configuration a previous one happened to leave behind — and
  // a test that fails part-way cannot poison the ones after it. Restoring
  // by hand at the end of each test does neither.
  beforeEach(() => {
    snapshot = defaultSnapshot();
  });

  /** Overrides configuration for the rest of THIS test only. */
  function withSettings(values: Partial<SettingsSnapshot["values"]>): void {
    snapshot = { ...snapshot, values: { ...snapshot.values, ...values } } as SettingsSnapshot;
  }

  async function poll(input: Record<string, unknown>, caller?: { machine?: string }) {
    return (await runtime.call("poll", input, { caller: caller ?? {} })) as PollResult;
  }

  describe("a machine the server has never heard of", () => {
    it("creates its row rather than refusing the poll", async () => {
      // §19 gives /machines no creation verb, and update_machine's own
      // header names this as the path a machine row comes into existence
      // on. A first poll that 404d would make a new machine unbootstrappable
      // without an operator editing the database.
      const result = await poll({ machine: "fresh-machine", liveSessions: 3 });

      expect(result.machine).toBe("fresh-machine");
      const row = await prisma.machine.findUniqueOrThrow({
        where: { name: "fresh-machine" },
      });
      expect(row.liveSessions).toBe(3);
      expect(row.lastPollAt).not.toBeNull();
    });

    it("inherits the global source globs, having no override of its own", async () => {
      withSettings({ "minting.source_globs": ["inbox/*.md"] });
      const result = await poll({ machine: "inheriting-machine" });

      expect(result.sourceGlobs).toEqual(["inbox/*.md"]);
      // A machine created by a poll must carry NO override — the column is
      // what distinguishes "inherits" from "deliberately scans nothing".
      const stored = await prisma.$queryRawUnsafe<{ overridden: boolean }[]>(
        `SELECT ("source_globs" IS NOT NULL) AS "overridden" FROM "Machine" WHERE "name" = $1`,
        "inheriting-machine",
      );
      expect(stored[0]!.overridden).toBe(false);
    });

    it("reports no accounts to band, having none wired up", async () => {
      const result = await poll({ machine: "unwired-machine", usage5h: 90 });

      expect(result.bands).toEqual({});
      // Not an error: an installation that has not wired an account yet
      // still polls, and losing the poll over a configuration gap would
      // make the gap harder to notice rather than easier.
      expect(result.usage.status).toBe("no-account");
    });
  });

  describe("the source globs it is told to scan", () => {
    it("scans the machine's own globs where it carries an override", async () => {
      withSettings({ "minting.source_globs": ["global/*.md"] });
      await prisma.machine.create({
        data: { name: "override-machine", sourceGlobs: ["mine/*.md", "also/*.md"] },
      });

      const result = await poll({ machine: "override-machine" });

      expect(result.sourceGlobs).toEqual(["mine/*.md", "also/*.md"]);
    });

    it("honours an EMPTY override as a deliberate scan-nothing", async () => {
      // The distinction the override column exists to carry, and the one a
      // COALESCE would destroy: NULL means inherit, [] means scan nothing.
      // Without it, a machine deliberately scanning nothing would silently
      // be given the global list.
      withSettings({ "minting.source_globs": ["global/*.md"] });
      await prisma.machine.create({ data: { name: "silent-machine", sourceGlobs: [] } });

      const result = await poll({ machine: "silent-machine" });

      expect(result.sourceGlobs).toEqual([]);
    });

    it("does not clobber an override when that machine polls again", async () => {
      await prisma.machine.create({
        data: { name: "keeps-override", sourceGlobs: ["kept/*.md"] },
      });

      await poll({ machine: "keeps-override", liveSessions: 7 });

      const stored = await prisma.machine.findUniqueOrThrow({
        where: { name: "keeps-override" },
      });
      // The poll owns lastPollAt and liveSessions; an operator owns
      // sourceGlobs. A poll writing all three would quietly undo every
      // override on the next tick.
      expect(stored.sourceGlobs).toEqual(["kept/*.md"]);
      expect(stored.liveSessions).toBe(7);
    });
  });
  describe("which machine the poll is recorded against", () => {
    it("takes the declared name when the transport proved none", async () => {
      // The direct binding, which has no token to present. "Not
      // established" is a different fact from "contradicted".
      const result = await poll({ machine: "declared-only" }, {});

      expect(result.machine).toBe("declared-only");
      expect(result.overrodeMachine).toBeNull();
    });

    it("prefers the PROVED machine over a contradicting declaration", async () => {
      // A caller authenticated as one machine cannot poll as another, and
      // the row it updates is the proved one.
      const result = await poll({ machine: "claimed-machine" }, { machine: "proved-machine" });

      expect(result.machine).toBe("proved-machine");
      expect(result.overrodeMachine).toBe("claimed-machine");
      // The claim never lands: the row it named must not have been touched.
      expect(await prisma.machine.findUnique({ where: { name: "claimed-machine" } })).toBeNull();
      expect(await prisma.machine.findUnique({ where: { name: "proved-machine" } })).not.toBeNull();
    });

    it("reports no override when proved and declared agree", async () => {
      const result = await poll({ machine: "agreeing" }, { machine: "agreeing" });

      expect(result.machine).toBe("agreeing");
      expect(result.overrodeMachine).toBeNull();
    });
  });

  describe("the usage snapshot it reports", () => {
    /** A machine wired to one fresh account. */
    async function wire(machine: string, account: string): Promise<void> {
      await prisma.machine.create({ data: { name: machine, sourceGlobs: [] } });
      await prisma.account.create({
        data: { id: account, vendor: "anthropic", displayName: account, planType: "subscription" },
      });
      await prisma.machineAccount.create({
        data: { machineName: machine, accountId: account },
      });
    }

    it("stores the reading against the account, not the machine", async () => {
      // §15: "Usage belongs to the account, not the machine. Machines are
      // compute; limits are billing."
      await wire("reporting-machine", "reported-account");

      const takenAt = new Date("2026-08-31T09:00:00.000Z");
      const result = await poll({
        machine: "reporting-machine",
        usage5h: 41.5,
        usageWeekly: 63,
        usageAt: takenAt.toISOString(),
      });

      expect(result.usage).toEqual({ status: "written", accountIds: ["reported-account"] });
      const account = await prisma.account.findUniqueOrThrow({
        where: { id: "reported-account" },
      });
      expect(Number(account.usage5h)).toBe(41.5);
      expect(Number(account.usageWeekly)).toBe(63);
      expect(account.usageAt?.toISOString()).toBe(takenAt.toISOString());
    });

    it("refuses a snapshot older than the one already stored", async () => {
      await wire("late-machine", "late-account");
      await poll({
        machine: "late-machine",
        usage5h: 80,
        usageAt: "2026-08-31T12:00:00.000Z",
      });

      const result = await poll({
        machine: "late-machine",
        usage5h: 10,
        usageAt: "2026-08-31T10:00:00.000Z",
      });

      expect(result.usage.status).toBe("superseded");
      const account = await prisma.account.findUniqueOrThrow({ where: { id: "late-account" } });
      expect(Number(account.usage5h)).toBe(80);
    });

    it("leaves the stored reading alone when the poll carries no usage", async () => {
      await wire("quiet-machine", "quiet-account");
      await poll({
        machine: "quiet-machine",
        usage5h: 55,
        usageAt: "2026-08-31T09:00:00.000Z",
      });

      const result = await poll({ machine: "quiet-machine", liveSessions: 1 });

      expect(result.usage.status).toBe("empty");
      const account = await prisma.account.findUniqueOrThrow({ where: { id: "quiet-account" } });
      expect(Number(account.usage5h)).toBe(55);
      // The half that matters: a poll with no measurement must not advance
      // the timestamp, or a stale reading would look permanently fresh.
      expect(account.usageAt?.toISOString()).toBe("2026-08-31T09:00:00.000Z");
    });

    it("refuses a figure far outside a percentage, which is a unit error", async () => {
      // Over-spend past a limit is real, so 104 is accepted; a token count
      // in the millions is not a percentage and is refused rather than
      // stored as a number every band comparison reads as stop.
      const error = await poll({ machine: "unit-error", usage5h: 250_000 }).catch(
        (e: unknown) => e,
      );
      expect((error as { code: string }).code).toBe("invalid_input");
    });
  });
  describe("the band it is told each account is in", () => {
    async function wireBanded(machine: string, account: string, windows?: unknown): Promise<void> {
      await prisma.machine.create({ data: { name: machine, sourceGlobs: [] } });
      await prisma.account.create({
        data: {
          id: account,
          vendor: "anthropic",
          displayName: account,
          planType: "subscription",
          ...(windows === undefined ? {} : { budgetWindows: windows as object }),
        },
      });
      await prisma.machineAccount.create({ data: { machineName: machine, accountId: account } });
    }

    it("bands against the reading the SAME poll just reported", async () => {
      // The whole point of deciding server-side: a poller sends a figure and
      // is told what it means, in one round trip, without ever holding a
      // threshold of its own.
      withSettings({
        "budget.enabled": true,
        "budget.windows": { fiveHour: constantWindow(50, 80, 95) } as never,
      });
      await wireBanded("banded-machine", "banded-account");

      const result = await poll({
        machine: "banded-machine",
        usage5h: 85,
        usageAt: new Date().toISOString(),
        elapsedHours: { fiveHour: 1 },
      });

      const decision = result.bands["banded-account"]!;
      expect(decision.status).toBe("banded");
      if (decision.status !== "banded") throw new Error("expected a band");
      expect(decision.band).toBe("wind_down");
    });

    it("bands against the ACCOUNT's own windows where it overrides the setting", async () => {
      // §17.7's per-entity override, end to end. The same usage figure and
      // the same clock as the test above, and a different answer — which is
      // the only thing that shows the override is read rather than ignored.
      withSettings({
        "budget.enabled": true,
        "budget.windows": { fiveHour: constantWindow(50, 80, 95) } as never,
      });
      await wireBanded("override-banded", "override-account", {
        fiveHour: constantWindow(10, 20, 30),
      });

      const result = await poll({
        machine: "override-banded",
        usage5h: 85,
        usageAt: new Date().toISOString(),
        elapsedHours: { fiveHour: 1 },
      });

      const decision = result.bands["override-account"]!;
      if (decision.status !== "banded") throw new Error("expected a band");
      expect(decision.band).toBe("stop");
    });

    it("reports a STALE reading as unbanded rather than acting on it", async () => {
      withSettings({
        "budget.enabled": true,
        "budget.windows": { fiveHour: constantWindow(50, 80, 95) } as never,
        "budget.reading_stale_after_seconds": 60,
      });
      await wireBanded("stale-machine", "stale-account");
      // A reading taken well outside the threshold, arriving on a poll that
      // reports no fresh figure of its own.
      await prisma.account.update({
        where: { id: "stale-account" },
        data: { usage5h: 5, usageAt: new Date(Date.now() - 3600_000) },
      });

      const result = await poll({
        machine: "stale-machine",
        elapsedHours: { fiveHour: 1 },
      });

      // 5% would be `free` — the most permissive answer available, and the
      // windows are configured and enabled, so `reading-stale` is the only
      // reason available. Being unbanded for a stated reason is not the
      // same as being told there is headroom, and #56 exists so the two are
      // distinguishable here.
      expect(result.bands["stale-account"]).toMatchObject({
        status: "unbanded",
        reason: "reading-stale",
      });
    });

    it("reports unbanded when budgets are switched off, whatever the usage", async () => {
      // Windows ARE configured and would band this usage as `stop`; only
      // the master switch is off. Without the windows this test could pass
      // on `no-windows` and would say nothing about the switch at all.
      withSettings({
        "budget.enabled": false,
        "budget.windows": { fiveHour: constantWindow(50, 80, 95) } as never,
      });
      await wireBanded("unbudgeted-machine", "unbudgeted-account");

      const result = await poll({
        machine: "unbudgeted-machine",
        usage5h: 99,
        usageAt: new Date().toISOString(),
        elapsedHours: { fiveHour: 1 },
      });

      // budget.enabled defaults to false, so this is what every fresh
      // installation is told.
      expect(result.bands["unbudgeted-account"]).toMatchObject({
        status: "unbanded",
        reason: "budget-disabled",
      });
    });

    it("bands every account the machine can dispatch against", async () => {
      withSettings({
        "budget.enabled": true,
        "budget.windows": { fiveHour: constantWindow(50, 80, 95) } as never,
      });
      await prisma.machine.create({ data: { name: "two-account-machine", sourceGlobs: [] } });
      for (const id of ["acct-one", "acct-two"]) {
        await prisma.account.create({
          data: { id, vendor: "anthropic", displayName: id, planType: "subscription" },
        });
        await prisma.machineAccount.create({
          data: { machineName: "two-account-machine", accountId: id },
        });
      }

      const result = await poll({
        machine: "two-account-machine",
        usage5h: 60,
        usageAt: new Date().toISOString(),
        elapsedHours: { fiveHour: 1 },
      });

      expect(Object.keys(result.bands).sort()).toEqual(["acct-one", "acct-two"]);
    });
  });

  describe("what the server tells the poller to do next", () => {
    it("hands back the poll interval from configuration, not from the caller", async () => {
      withSettings({ "poll.interval_seconds": 42 });
      const result = await poll({ machine: "interval-machine" });

      expect(result.intervalSeconds).toBe(42);
    });

    it("counts the pending sources it was sent without acting on them", async () => {
      // Minting is #63. The field exists now so a poller's shape does not
      // change when it lands.
      const result = await poll({
        machine: "pending-machine",
        pendingSources: ["hash-a", "hash-b", "hash-c"],
      });

      expect(result.pendingSourceCount).toBe(3);
    });

    it("returns an empty dispatch list rather than omitting the field", async () => {
      // The planner is #59 and prompt composition is #60. An always-present
      // empty list is what lets a poller be written once: it reads
      // dispatches, finds none and sleeps, which is what it will also do on
      // a quiet server once the planner ships.
      const result = await poll({ machine: "dispatch-machine" });

      expect(result.dispatches).toEqual([]);
    });
  });
});
