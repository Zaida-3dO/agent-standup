// `get_session_detail` — the record of what one agent did, against a real
// Postgres. T19: "One session: its assignments, tool calls, cost, timeline."
//
// A real database because every claim here is a claim about the SQL: that
// each section is filtered to the one session, that the counts describe the
// whole corpus while the lists are capped, that an unknown session is
// refused rather than answered with an empty record, and — the one worth the
// most — that the cost figure agrees with `get_costs`.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import type { GetCostsOutput } from "@/lib/service";
import { defaultSnapshot, type SettingsSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { registerSessions } from "./helpers/register-sessions";
import type { GetSessionDetailOutput } from "@/lib/service/operations/get-session-detail";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const AT = new Date("2026-02-03T04:05:06.000Z");

/** Two deliberately distinct rates, so a total attributed to the wrong model is visible. */
const CHEAP = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
const DEAR = { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 };

describeIfDb("get_session_detail — one session end to end, against Postgres", () => {
  const dbName = scratchDatabaseName("session_detail");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let seq = 0;
  let tick = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => withPrices(defaultSnapshot()),
    });
    await prisma.area.create({ data: { id: "sd-area", displayName: "Session detail" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function withPrices(base: SettingsSnapshot): SettingsSnapshot {
    return {
      ...base,
      values: {
        ...base.values,
        "pricing.model_prices": { "vendor-cheap": CHEAP, "vendor-dear": DEAR },
      },
    } as SettingsSnapshot;
  }

  async function seedItem(): Promise<string> {
    seq += 1;
    const id = `sd-item-${seq}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: `item ${seq}`,
        body: "b",
        state: "executing",
        originType: "auto",
        area: "sd-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /** A held item and the session holding it — what a run needs to exist at all. */
  async function heldSession(): Promise<{ sessionId: string; itemId: string }> {
    seq += 1;
    const sessionId = `sd-session-${seq}`;
    const itemId = await seedItem();
    await registerSessions(prisma, [sessionId]);
    await runtime.call("claim", {
      itemId,
      role: "builder",
      holderType: "agent",
      holderId: "crew-member",
      sessionId,
      machine: "laptop",
    });
    return { sessionId, itemId };
  }

  /** One call, one millisecond after the last — so runs cut by it get distinct timestamps. */
  function call(overrides: Record<string, unknown> = {}) {
    tick += 1;
    return {
      tool: "Bash",
      ts: new Date(AT.getTime() + tick).toISOString(),
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      model: "vendor-cheap",
      ...overrides,
    };
  }

  async function record(sessionId: string, calls: unknown[]) {
    return runtime.call("record_tool_calls", { sessionId, calls });
  }

  async function detail(input: Record<string, unknown>): Promise<GetSessionDetailOutput> {
    return (await runtime.call("get_session_detail", input)) as GetSessionDetailOutput;
  }

  it("refuses an unknown session rather than reporting one that did nothing", async () => {
    // The failure this prevents is a quiet one: every other read here is
    // keyed on `sessionId`, so without the explicit check a typo returns a
    // complete-looking record of a session that made no calls — which is
    // indistinguishable from a real session that has not started.
    await expect(detail({ sessionId: "no-such-session" })).rejects.toThrow(/no such session/i);
  });

  it("returns the session's registration facts", async () => {
    const { sessionId } = await heldSession();
    const result = await detail({ sessionId });
    expect(result.session.id).toBe(sessionId);
    expect(result.session.machine).toBeTruthy();
  });

  it("lists the assignments this session holds, with each item's title resolved", async () => {
    const { sessionId, itemId } = await heldSession();
    const result = await detail({ sessionId });
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.itemId).toBe(itemId);
    // Resolved rather than left as an id — the point of the join.
    expect(result.assignments[0]!.itemTitle).toBeTruthy();
    expect(result.assignments[0]!.role).toBe("builder");
  });

  it("does not report another session's assignments", async () => {
    // The `WHERE` clause, asserted directly. A missing filter would pass
    // every single-session case above.
    const mine = await heldSession();
    const theirs = await heldSession();
    const result = await detail({ sessionId: mine.sessionId });
    expect(result.assignments.map((a) => a.itemId)).toEqual([mine.itemId]);
    expect(result.assignments.map((a) => a.itemId)).not.toContain(theirs.itemId);
  });

  it("agrees exactly with get_costs on what the session cost", async () => {
    // The claim the module header rests on: this is `get_costs`' arithmetic,
    // not a second computation. Two models on one session, so the figure is
    // a sum across rates rather than a single multiplication that a wrong
    // implementation might reproduce by luck.
    const { sessionId } = await heldSession();
    await record(sessionId, [call({ model: "vendor-cheap", inputTokens: 1_000_000 })]);
    await record(sessionId, [call({ model: "vendor-dear", inputTokens: 1_000_000 })]);

    const mine = await detail({ sessionId });
    const canonical = (await runtime.call("get_costs", {
      groupBy: "session",
    })) as GetCostsOutput;
    const theirs = canonical.groups.find((g) => g.key === sessionId);

    expect(theirs).toBeDefined();
    expect(mine.cost).not.toBeNull();
    // 1M at rate 1 plus 1M at rate 10 = 11, and both reads must say so.
    expect(mine.cost!.cost).toBeCloseTo(11, 6);
    expect(mine.cost!.cost).toBeCloseTo(theirs!.cost!, 6);
    expect(mine.cost!.inputTokens).toBe(theirs!.inputTokens);
    expect(mine.cost!.runs).toBe(theirs!.runs);
  });

  it("reports no cost record for a session with no runs, rather than a zero total", async () => {
    // "Cost nothing" and "has no cost record" are different facts, and a
    // defaulted zero would present the second as the first.
    const { sessionId } = await heldSession();
    const result = await detail({ sessionId });
    expect(result.cost).toBeNull();
  });

  it("names a model with no configured rate rather than costing it at zero", async () => {
    const { sessionId } = await heldSession();
    await record(sessionId, [call({ model: "vendor-unconfigured" })]);
    const result = await detail({ sessionId });
    expect(result.cost!.cost).toBeNull();
    expect(result.cost!.unpricedRuns).toBe(1);
    expect(result.unpricedModels).toContain("vendor-unconfigured");
  });

  it("returns the newest tool calls and reports the true total beside them", async () => {
    // The cap and the count are separate facts: a list of 2 with a total of
    // 4 is honestly truncated, whereas a total derived from the list length
    // would report 2 and look complete.
    const { sessionId } = await heldSession();
    await record(sessionId, [call(), call(), call(), call()]);

    const result = await detail({ sessionId, callLimit: 2 });
    expect(result.recentCalls).toHaveLength(2);
    expect(result.totalCalls).toBe(4);
    // Newest first: the last call recorded has the highest `ts`.
    const timestamps = result.recentCalls.map((c) => c.ts);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  it("does not report another session's tool calls", async () => {
    const mine = await heldSession();
    const theirs = await heldSession();
    await record(mine.sessionId, [call()]);
    await record(theirs.sessionId, [call(), call()]);

    const result = await detail({ sessionId: mine.sessionId });
    expect(result.totalCalls).toBe(1);
  });

  it("omits each call's command and paths by default and returns them on request", async () => {
    const { sessionId } = await heldSession();
    await record(sessionId, [call({ command: "npm test", paths: ["src/a.ts"] })]);

    const slim = await detail({ sessionId });
    expect(slim.recentCalls[0]).not.toHaveProperty("command");
    expect(slim.recentCalls[0]).not.toHaveProperty("paths");

    const full = await detail({ sessionId, full: true });
    expect(full.recentCalls[0]).toMatchObject({
      command: "npm test",
      paths: ["src/a.ts"],
    });
  });

  it("returns the newest ledger entries this session wrote, with the true total", async () => {
    const { sessionId, itemId } = await heldSession();
    await runtime.call("note", { itemId, body: "first", sessionId });
    await runtime.call("note", { itemId, body: "second", sessionId });

    const result = await detail({ sessionId, eventLimit: 1 });
    expect(result.recentEvents).toHaveLength(1);
    // The claim ALSO wrote an event, so the total exceeds the two notes —
    // asserting a floor rather than an exact figure keeps this about the
    // count being of the corpus rather than of the returned page.
    expect(result.totalEvents).toBeGreaterThan(1);
    expect(result.recentEvents[0]!.itemTitle).toBeTruthy();
  });

  it("does not report another session's ledger entries", async () => {
    const mine = await heldSession();
    const theirs = await heldSession();
    await runtime.call("note", {
      itemId: theirs.itemId,
      body: "theirs",
      sessionId: theirs.sessionId,
    });

    const before = await detail({ sessionId: mine.sessionId });
    await runtime.call("note", { itemId: mine.itemId, body: "mine", sessionId: mine.sessionId });
    const after = await detail({ sessionId: mine.sessionId });

    expect(after.totalEvents).toBe(before.totalEvents + 1);
    expect(after.recentEvents.map((e) => e.itemId)).not.toContain(theirs.itemId);
  });
});
