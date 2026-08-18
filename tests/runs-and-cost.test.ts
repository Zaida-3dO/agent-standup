// `runs` as the ingest cuts them, and the cost stored beside their counts —
// MILESTONES.md #51 and #52, against a real Postgres. SCHEMA.md §11.
//
// Why these need a real database rather than a modelled handle: the
// properties under test are about rows persisting *between* calls. That a
// second batch finds the run the first opened; that a cut closes exactly one
// row and opens exactly one; that a `BIGINT` accumulates across batches; that
// `selectionReason` may be null at all, which is a column constraint rather
// than an application rule. A double would decide each of those by whatever
// it happened to implement.
//
// The boundary rule itself and the cost arithmetic are unit-tested without a
// database, in `telemetry-run-boundary.test.ts` and `telemetry-pricing.test.ts`.
// What this file adds is that the operation actually *applies* them — a
// property no unit test of a pure function can reach, and the one a mutation
// deleting the `attribute` call at the ingest site would survive.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
// ⚠️ That means a run with no database reports these as *skipped* and exits
// 0 — a green local run is not evidence any of this passed.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import type { GetCostsOutput, RecordToolCallsOutput } from "@/lib/service";
import { defaultSnapshot, type SettingsSnapshot } from "@/lib/settings";
import { UNREPORTED } from "@/lib/service/telemetry/runs";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { registerSessions } from "./helpers/register-sessions";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const AT = new Date("2026-01-02T03:04:05.000Z");

/**
 * A price table with two deliberately distinct models.
 *
 * Distinct rather than realistic, for the same reason the pricing unit test
 * uses distinct rates: a table where two models cost the same would let a
 * run attributed to the wrong model still produce the right total.
 */
const CHEAP = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
const DEAR = { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 };
const PRICES = { "vendor-cheap": CHEAP, "vendor-dear": DEAR };

describeIfDb("runs and cost — the ingest's rollup against Postgres", () => {
  const dbName = scratchDatabaseName("runs_cost");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let counter = 0;

  /**
   * The snapshot every call resolves. Mutable so a case can change the price
   * table and re-record — which is how the "a rate change changes the
   * recomputed figure" claim is proved end to end rather than only over the
   * pure function.
   */
  let prices: Record<string, unknown> = { ...PRICES };

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => withPrices(defaultSnapshot(), prices),
    });
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** A snapshot with the price table replaced, leaving every other value at its default. */
  function withPrices(base: SettingsSnapshot, table: Record<string, unknown>): SettingsSnapshot {
    return {
      ...base,
      values: { ...base.values, "pricing.model_prices": table },
    } as SettingsSnapshot;
  }

  async function seedItem(state: "executing" | "in_review" = "executing") {
    counter += 1;
    const id = `item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state,
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function claim(itemId: string, sessionId: string) {
    await registerSessions(prisma, [sessionId]);
    return runtime.call("claim", {
      itemId,
      role: "builder",
      holderType: "agent",
      holderId: "crew-member",
      sessionId,
      machine: "laptop",
    });
  }

  /** A held item and the session holding it, which is what a run needs to exist. */
  async function heldSession(state: "executing" | "in_review" = "executing") {
    counter += 1;
    const sessionId = `session-${counter}`;
    const itemId = await seedItem(state);
    await claim(itemId, sessionId);
    return { sessionId, itemId };
  }

  /**
   * One call, one millisecond after the last.
   *
   * **The advancing clock is load-bearing, not decoration.** A run's
   * `startedAt` is the timestamp of the call that opened it, so calls
   * sharing one instant give the runs they cut identical timestamps — and
   * `ORDER BY "startedAt"` then leaves those runs in whatever order the
   * database returns, making any assertion that indexes into the list a coin
   * flip. That is not hypothetical: it reported working behaviour as broken
   * once, by reading the first run's stage where the second's was meant.
   *
   * Every case still starts from the same fixed `AT`, so the time-window
   * assertions stay deterministic — the clock advances *within* a case, it
   * is not a wall clock.
   */
  let tick = 0;
  function call(overrides: Record<string, unknown> = {}) {
    tick += 1;
    return {
      tool: "Bash",
      ts: new Date(AT.getTime() + tick).toISOString(),
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      ...overrides,
    };
  }

  async function record(sessionId: string, calls: unknown[]): Promise<RecordToolCallsOutput> {
    return (await runtime.call("record_tool_calls", { sessionId, calls })) as RecordToolCallsOutput;
  }

  /**
   * One item's runs, oldest first.
   *
   * The order is a real chronology rather than a tie broken arbitrarily,
   * because `call()` advances the clock — see the note there for what went
   * wrong when every call shared one instant.
   */
  async function runsFor(itemId: string) {
    return prisma.run.findMany({ where: { itemId }, orderBy: { startedAt: "asc" } });
  }

  describe("a run is opened for work that has an item", () => {
    it("opens one run for a batch reporting one model", async () => {
      const { sessionId, itemId } = await heldSession();
      const result = await record(sessionId, [
        call({ model: "vendor-cheap", effort: "high" }),
        call({ model: "vendor-cheap", effort: "high" }),
      ]);

      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.model).toBe("vendor-cheap");
      expect(runs[0]!.effort).toBe("high");
      expect(runs[0]!.toolCallCount).toBe(2);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]!.opened).toBe(true);
      expect(result.runs[0]!.calls).toBe(2);
    });

    it("attributes the run to the item and session the calls were recorded under", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap" })]);
      const [run] = await runsFor(itemId);
      expect(run!.itemId).toBe(itemId);
      expect(run!.sessionId).toBe(sessionId);
    });

    it("carries the item's stage onto the run, for the per-stage rollup", async () => {
      // #53 aggregates per stage from this column. Deriving it instead would
      // mean joining every run to its calls, which is the scan §11 exists as
      // a rollup to avoid.
      const { sessionId, itemId } = await heldSession("in_review");
      await record(sessionId, [call({ model: "vendor-cheap" })]);
      const [run] = await runsFor(itemId);
      expect(run!.stateAt).toBe("in_review");
    });

    it("leaves selectionReason null rather than inventing a dispatch decision", async () => {
      // Every value of that enum states why a *dispatch* chose a model, and
      // a telemetry report carries none. Defaulting to `recommended` would
      // put runs nobody recommended anything about into the comparison group
      // the model picker grades recommendations against.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap" })]);
      const [run] = await runsFor(itemId);
      expect(run!.selectionReason).toBeNull();
    });

    it("records no run for a ghost session, but still records its calls", async () => {
      // §10: work with no minted task is measured. §11: a run is one turn on
      // one item. Both hold — the calls land, the rollup does not.
      await registerSessions(prisma, ["ghost-session"]);
      const result = await record("ghost-session", [call({ model: "vendor-cheap" })]);
      expect(result.runs).toEqual([]);
      expect(result.recorded).toBe(1);
      expect(await prisma.toolCall.count({ where: { sessionId: "ghost-session" } })).toBe(1);
      expect(await prisma.run.count({ where: { sessionId: "ghost-session" } })).toBe(0);
    });
  });

  describe("a model or effort change cuts the run", () => {
    it("cuts a new run mid-batch when the model changes", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [
        call({ model: "vendor-cheap", effort: "high" }),
        call({ model: "vendor-dear", effort: "high" }),
      ]);

      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.model)).toEqual(["vendor-cheap", "vendor-dear"]);
      // The first is closed, the second is not: the invariant is at most one
      // open run per assignment, and it must hold between calls rather than
      // only at the end of a batch.
      expect(runs[0]!.endedAt).not.toBeNull();
      expect(runs[1]!.endedAt).toBeNull();
    });

    it("cuts on an effort change with the model unchanged", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [
        call({ model: "vendor-cheap", effort: "high" }),
        call({ model: "vendor-cheap", effort: "low" }),
      ]);
      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.effort)).toEqual(["high", "low"]);
    });

    it("splits the token counts across the two runs at the boundary", async () => {
      // The whole point of cutting: a run spanning two models attributes its
      // score and its cost to a blend.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [
        call({ model: "vendor-cheap", inputTokens: 3_000_000 }),
        call({ model: "vendor-dear", inputTokens: 5_000_000 }),
      ]);
      const runs = await runsFor(itemId);
      expect(runs[0]!.inputTokens).toBe(3_000_000n);
      expect(runs[1]!.inputTokens).toBe(5_000_000n);
    });

    it("does not cut when calls report no model at all", async () => {
      // The common case: no agent tool is obliged to report usage. Cutting on
      // each silent call would shatter one turn into a run per call.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call(), call(), call()]);
      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.toolCallCount).toBe(3);
    });

    it("adopts the first reported model into a run opened by silent calls", async () => {
      // Without adoption every turn would split into an unattributed head and
      // an attributed tail, and the head would be permanently unpriceable.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call(), call({ model: "vendor-cheap" })]);
      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.model).toBe("vendor-cheap");
      expect(runs[0]!.toolCallCount).toBe(2);
    });

    it("stores a recognisable sentinel for a run nothing ever reported", async () => {
      // `Run.model` is NOT NULL, so a run opened by silent calls needs a
      // value. A sentinel is visible in a query result and cannot collide
      // with a vendor ID; an empty string would be indistinguishable from a
      // malformed report and would group alongside real values.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call()]);
      const [run] = await runsFor(itemId);
      expect(run!.model).toBe(UNREPORTED);
      expect(run!.cost).toBeNull();
    });
  });

  describe("a run spans batches", () => {
    it("continues the open run on a second batch rather than opening another", async () => {
      // The property that makes a run a *run*: the hook flushes in batches,
      // and a run that restarted on every flush would be a run per flush.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap" })]);
      const second = await record(sessionId, [call({ model: "vendor-cheap" })]);

      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.toolCallCount).toBe(2);
      expect(second.runs[0]!.opened).toBe(false);
    });

    it("accumulates token counts across batches rather than overwriting them", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 2_000_000 })]);
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 3_000_000 })]);
      const [run] = await runsFor(itemId);
      expect(run!.inputTokens).toBe(5_000_000n);
    });

    it("cuts across a batch boundary when the model changed between flushes", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap" })]);
      await record(sessionId, [call({ model: "vendor-dear" })]);
      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(2);
      expect(runs[0]!.endedAt).not.toBeNull();
      expect(runs[1]!.endedAt).toBeNull();
    });

    it("keeps at most one open run per assignment", async () => {
      // Asserted directly rather than inferred: two open runs would make the
      // next flush attribute to whichever the ordering happened to surface.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap" })]);
      await record(sessionId, [call({ model: "vendor-dear" })]);
      await record(sessionId, [call({ model: "vendor-cheap" })]);
      const open = await prisma.run.count({ where: { itemId, endedAt: null } });
      expect(open).toBe(1);
      expect(await runsFor(itemId)).toHaveLength(3);
    });
  });

  describe("cost is stored beside the counts and recomputed from them", () => {
    it("stores a cost computed from the run's counts at the configured rate", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [
        call({ model: "vendor-cheap", inputTokens: 2_000_000, outputTokens: 1_000_000 }),
      ]);
      const [run] = await runsFor(itemId);
      // 2 × 1 + 1 × 5
      expect(Number(run!.cost)).toBeCloseTo(7, 6);
    });

    it("prices each run at its own model's rate after a cut", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [
        call({ model: "vendor-cheap", inputTokens: 1_000_000 }),
        call({ model: "vendor-dear", inputTokens: 1_000_000 }),
      ]);
      const runs = await runsFor(itemId);
      expect(Number(runs[0]!.cost)).toBeCloseTo(1, 6);
      expect(Number(runs[1]!.cost)).toBeCloseTo(10, 6);
    });

    it("leaves cost null for a model with no configured rate", async () => {
      // Null, not zero: a total over a mix of priced and unpriced runs would
      // otherwise read as complete while being short by an unknown amount.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-unconfigured" })]);
      const [run] = await runsFor(itemId);
      expect(run!.cost).toBeNull();
      expect(run!.inputTokens).toBe(1_000_000n);
    });

    it("recomputes the whole run's cost on a later batch rather than incrementing it", async () => {
      // The observable difference between recomputing and incrementing. With
      // an incremented cost the stored figure would be 1 + 1 = 2 under both
      // rate tables, because each addend was computed under whichever rates
      // were live at that flush — a number corresponding to no price table
      // that ever existed.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 1_000_000 })]);

      prices = { "vendor-cheap": { ...CHEAP, input: 2 } };
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 1_000_000 })]);
      prices = { ...PRICES };

      const [run] = await runsFor(itemId);
      // Both million-token calls, priced together at the rate live when the
      // figure was last computed: 2 × 2 = 4, not 1 + 2 = 3.
      expect(run!.inputTokens).toBe(2_000_000n);
      expect(Number(run!.cost)).toBeCloseTo(4, 6);
    });

    it("writes the closed run's final counts before closing it", async () => {
      // A cut must persist the run it closes. Closing without writing would
      // leave the first run's counts at whatever the previous batch stored —
      // permanently short by the calls made since.
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [
        call({ model: "vendor-cheap", inputTokens: 1_000_000 }),
        call({ model: "vendor-cheap", inputTokens: 1_000_000 }),
        call({ model: "vendor-dear", inputTokens: 1_000_000 }),
      ]);
      const runs = await runsFor(itemId);
      expect(runs[0]!.inputTokens).toBe(2_000_000n);
      expect(runs[0]!.toolCallCount).toBe(2);
      expect(Number(runs[0]!.cost)).toBeCloseTo(2, 6);
    });
  });

  describe("get_costs — the aggregation over what the ingest wrote", () => {
    it("totals cost per item", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 1_000_000 })]);

      const result = (await runtime.call("get_costs", {
        groupBy: "item",
        itemId,
      })) as GetCostsOutput;
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]!.key).toBe(itemId);
      expect(result.groups[0]!.cost).toBeCloseTo(1, 6);
    });

    it("totals cost per session", async () => {
      const { sessionId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-dear", inputTokens: 1_000_000 })]);

      const result = (await runtime.call("get_costs", { groupBy: "session" })) as GetCostsOutput;
      const mine = result.groups.find((g) => g.key === sessionId);
      expect(mine?.cost).toBeCloseTo(10, 6);
    });

    it("totals cost per stage, which is the grouping the row calls out", async () => {
      const { sessionId, itemId } = await heldSession("in_review");
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 1_000_000 })]);

      const result = (await runtime.call("get_costs", {
        groupBy: "stage",
        itemId,
      })) as GetCostsOutput;
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]!.key).toBe("in_review");
    });

    it("splits one item's cost across the stages its runs were attributed to", async () => {
      // The question per-stage aggregation exists to answer: what did each
      // stage of this piece of work cost.
      const { sessionId, itemId } = await heldSession("executing");
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 1_000_000 })]);

      // Moving the item puts the later calls in a different stage. A model
      // change happens to coincide here, so this case would pass even if a
      // stage alone did not cut — which is why the case below drives a
      // transition with no model change at all.
      await prisma.item.update({ where: { id: itemId }, data: { state: "in_review" } });
      await record(sessionId, [call({ model: "vendor-dear", inputTokens: 1_000_000 })]);

      const result = (await runtime.call("get_costs", {
        groupBy: "stage",
        itemId,
      })) as GetCostsOutput;
      const byStage = Object.fromEntries(result.groups.map((g) => [g.key, g.cost]));
      expect(byStage["executing"]).toBeCloseTo(1, 6);
      expect(byStage["in_review"]).toBeCloseTo(10, 6);
    });

    it("cuts a run when the stage moves, even with no model change", async () => {
      // The case that decides whether per-stage cost means anything. A run
      // is the unit cost is attributed by, so a run spanning a transition
      // reports all of its cost against the stage it opened in — and that
      // error is not bounded by a flush interval like §10's, it lasts as
      // long as the run does. Here the model is identical across the
      // transition, so nothing but the stage can cut the run.
      const { sessionId, itemId } = await heldSession("executing");
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 1_000_000 })]);

      await prisma.item.update({ where: { id: itemId }, data: { state: "in_review" } });
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 3_000_000 })]);

      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.stateAt)).toEqual(["executing", "in_review"]);
      // Both runs keep the model in force: the stage moved, nothing said the
      // model had.
      expect(runs.map((r) => r.model)).toEqual(["vendor-cheap", "vendor-cheap"]);
      expect(runs[0]!.endedAt).not.toBeNull();
      expect(runs[1]!.endedAt).toBeNull();

      const result = (await runtime.call("get_costs", {
        groupBy: "stage",
        itemId,
      })) as GetCostsOutput;
      const byStage = Object.fromEntries(result.groups.map((g) => [g.key, g.cost]));
      expect(byStage["executing"]).toBeCloseTo(1, 6);
      expect(byStage["in_review"]).toBeCloseTo(3, 6);
    });

    it("keeps a run open across batches while the stage holds", async () => {
      // The other half of the same rule, and the one that stops it becoming
      // a run per flush: an unchanged stage is not a reason to cut.
      const { sessionId, itemId } = await heldSession("executing");
      await record(sessionId, [call({ model: "vendor-cheap" })]);
      await record(sessionId, [call({ model: "vendor-cheap" })]);

      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.toolCallCount).toBe(2);
    });

    it("records a facet first reported on the call that crosses a stage", async () => {
      // A stage change and an adoption can land on the same call. The stage
      // opens a new run; the adopted model must travel onto it rather than
      // being discarded by the stage taking that branch first — otherwise
      // the new run is unattributed and unpriceable despite the call having
      // said exactly what served it.
      const { sessionId, itemId } = await heldSession("executing");
      await record(sessionId, [call()]);

      await prisma.item.update({ where: { id: itemId }, data: { state: "in_review" } });
      await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 1_000_000 })]);

      const runs = await runsFor(itemId);
      expect(runs).toHaveLength(2);
      expect(runs[1]!.stateAt).toBe("in_review");
      expect(runs[1]!.model).toBe("vendor-cheap");
      expect(Number(runs[1]!.cost)).toBeCloseTo(1, 6);
    });

    it("reports unpriced runs rather than counting them as free", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-unconfigured" })]);

      const result = (await runtime.call("get_costs", {
        groupBy: "item",
        itemId,
      })) as GetCostsOutput;
      expect(result.groups[0]!.cost).toBeNull();
      expect(result.groups[0]!.unpricedRuns).toBe(1);
      expect(result.unpricedModels).toContain("vendor-unconfigured");
    });

    it("bounds a time window on startedAt", async () => {
      const { sessionId, itemId } = await heldSession();
      await record(sessionId, [call({ model: "vendor-cheap" })]);

      const before = (await runtime.call("get_costs", {
        groupBy: "item",
        itemId,
        until: new Date(AT.getTime() - 1000).toISOString(),
      })) as GetCostsOutput;
      expect(before.groups).toEqual([]);

      const after = (await runtime.call("get_costs", {
        groupBy: "item",
        itemId,
        since: new Date(AT.getTime() - 1000).toISOString(),
      })) as GetCostsOutput;
      expect(after.groups).toHaveLength(1);
    });
  });
});
