// `list_runs` against real Postgres — the route from an item id to a runId.
//
// ── What this file is defending ────────────────────────────────────────
//
// Every run-scoring operation requires a `runId`, and before this operation
// existed nothing an orchestrator could call ever returned one. So the
// behaviour under test is not "a list comes back" — it is the specific
// shape that makes the list USABLE as a route:
//
//   - **The filter is mandatory.** Refusing an unfiltered read is a
//     deliberate contract, not an oversight, and a regression that started
//     serving the whole table would look like a feature.
//   - **The `"(unreported)"` sentinel comes back VERBATIM.** `openRun` in
//     `telemetry/runs.ts` maps the same sentinel BACK to null for the run
//     boundary rule, so the two directions are deliberately opposite and
//     the wrong one is one copied helper away. Mapping it to null here
//     would make "telemetry reported no model" indistinguishable from
//     "this field is unpopulated", which is exactly the distinction the
//     next chain item exists to act on.
//   - **An open run is RETURNED, not hidden.** Hiding it would make a
//     just-finished item look as though it had no runs at all.
//   - **`scoredFacets` names only AGENT-scored facets**, because that is
//     the set the write-once freeze applies to. Reporting a person-only
//     facet as frozen would send a caller around a conflict that would not
//     have happened.
//
// Skips without TEST_DATABASE_URL, like every other database-backed file
// here; CI's database job runs it.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  InvalidInputError,
  NotFoundError,
  ServiceRuntime,
  prismaTransactionRunner,
} from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { listOperations } from "@/lib/service/registry";
import { exposedOperations } from "@/lib/adapters/waivers";
import type { ListRunsOutput } from "@/lib/service/operations/list-runs";
import { UNREPORTED } from "@/lib/service/telemetry/runs";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// ── Exposure, asserted rather than assumed ─────────────────────────────
//
// Needs no database, so it sits outside the gated describe: a suite that
// skipped would otherwise report nothing about the single mistake that
// would silently defeat this whole operation. Exposure is opt-OUT
// (`exposedOperations` SUBTRACTS `ADAPTER_WAIVERS`), so `list_runs` is
// reachable by default and the failure mode is somebody "helpfully" adding
// a waiver by analogy with `list_repos` / `list_areas` — which are waived
// for a reference-entity-administration reason that does not apply to a
// telemetry read about the agent's own work.
describe("list_runs exposure", () => {
  it("is registered and exposed on every adapter, with no waiver", () => {
    const all = listOperations();
    expect(all.map((operation) => operation.name)).toContain("list_runs");

    for (const adapter of ["mcp_http", "mcp_stdio", "http", "cli"] as const) {
      const names = exposedOperations(adapter, all).map((operation) => operation.name);
      expect(names, `list_runs must stay reachable from ${adapter}`).toContain("list_runs");
    }
  });
});

describeIfDb("list_runs — against Postgres", () => {
  const dbName = scratchDatabaseName("run_listing");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.repo.create({ data: { id: "infra", displayName: "infra" } });
    await prisma.person.create({ data: { id: "reviewer-1", displayName: "Reviewer One" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.runScore.deleteMany({});
    await prisma.run.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let counter = 0;

  /**
   * An item with one assignment behind it.
   *
   * Note this helper deliberately does NOT create runs: the fixtures here
   * place runs explicitly so each test controls `startedAt`, `endedAt` and
   * `model` — the three fields whose handling is the point of the file.
   */
  async function createItem(): Promise<{
    itemId: string;
    assignmentId: string;
    sessionId: string;
  }> {
    counter += 1;
    const itemId = `item-${counter}`;
    const assignmentId = `assignment-${counter}`;
    const sessionId = `session-${counter}`;

    await prisma.item.create({
      data: {
        id: itemId,
        parentId: null,
        kind: "task",
        title: `Item ${counter}`,
        body: "body",
        state: "executing" as never,
        originType: "person",
        area: "web",
        repo: "infra",
        mergeAuthority: "needs_approval",
      },
    });
    await prisma.assignment.create({
      data: {
        id: assignmentId,
        itemId,
        role: "builder" as never,
        holderType: "agent" as never,
        holderId: `agent-${counter}`,
        sessionId,
        rootSessionId: sessionId,
        machine: "desktop",
      },
    });
    return { itemId, assignmentId, sessionId };
  }

  async function addRun(
    where: { itemId: string; assignmentId: string; sessionId: string },
    overrides: {
      id: string;
      startedAt: Date;
      endedAt?: Date | null;
      model?: string;
      effort?: string;
    },
  ): Promise<string> {
    await prisma.run.create({
      data: {
        id: overrides.id,
        itemId: where.itemId,
        assignmentId: where.assignmentId,
        sessionId: where.sessionId,
        startedAt: overrides.startedAt,
        endedAt: overrides.endedAt ?? null,
        model: overrides.model ?? "tier-a",
        effort: overrides.effort ?? "medium",
      },
    });
    return overrides.id;
  }

  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute, 0));

  it("returns an item's runs, newest first", async () => {
    const where = await createItem();
    await addRun(where, { id: "run-oldest", startedAt: at(0), endedAt: at(1) });
    await addRun(where, { id: "run-middle", startedAt: at(5), endedAt: at(6) });
    await addRun(where, { id: "run-newest", startedAt: at(10), endedAt: at(11) });

    const result = (await runtime.call("list_runs", { itemId: where.itemId })) as ListRunsOutput;

    // Order asserted as a whole sequence, not just the first entry: a
    // handler that dropped the ORDER BY would still put *something* first.
    expect(result.runs.map((run) => run.runId)).toEqual(["run-newest", "run-middle", "run-oldest"]);
    expect(result.truncated).toBe(false);
  });

  it("returns a session's runs, and intersects the two filters rather than unioning them", async () => {
    const mine = await createItem();
    const theirs = await createItem();
    await addRun(mine, { id: "run-mine", startedAt: at(0) });
    await addRun(theirs, { id: "run-theirs", startedAt: at(1) });

    const bySession = (await runtime.call("list_runs", {
      sessionId: mine.sessionId,
    })) as ListRunsOutput;
    expect(bySession.runs.map((run) => run.runId)).toEqual(["run-mine"]);

    // The combination must be AND. An OR would return both rows here, and
    // would quietly make every narrowed query broader than it reads.
    const both = (await runtime.call("list_runs", {
      itemId: mine.itemId,
      sessionId: theirs.sessionId,
    })) as ListRunsOutput;
    expect(both.runs).toEqual([]);
  });

  it("REFUSES to list every run in the database when neither filter is given", async () => {
    const where = await createItem();
    await addRun(where, { id: "run-1", startedAt: at(0) });

    // The refusal names both fields, so a caller is told what to supply
    // rather than merely that they were wrong.
    await expect(runtime.call("list_runs", {})).rejects.toBeInstanceOf(InvalidInputError);
    await expect(runtime.call("list_runs", {})).rejects.toMatchObject({
      fields: ["itemId", "sessionId"],
    });
  });

  it("caps at `limit` and says so with `truncated`", async () => {
    const where = await createItem();
    await addRun(where, { id: "run-a", startedAt: at(0) });
    await addRun(where, { id: "run-b", startedAt: at(1) });
    await addRun(where, { id: "run-c", startedAt: at(2) });

    const limited = (await runtime.call("list_runs", {
      itemId: where.itemId,
      limit: 2,
    })) as ListRunsOutput;
    // Newest two, and the flag that says older ones exist.
    expect(limited.runs.map((run) => run.runId)).toEqual(["run-c", "run-b"]);
    expect(limited.truncated).toBe(true);

    const whole = (await runtime.call("list_runs", {
      itemId: where.itemId,
      limit: 3,
    })) as ListRunsOutput;
    // Exactly-at-the-limit must NOT report truncation — the off-by-one that
    // would say "there is more" when there is not.
    expect(whole.runs).toHaveLength(3);
    expect(whole.truncated).toBe(false);
  });

  it("filters on whether a run is already scored, in both directions", async () => {
    const where = await createItem();
    await addRun(where, { id: "run-scored", startedAt: at(0) });
    await addRun(where, { id: "run-unscored", startedAt: at(1) });
    await runtime.call("score_run", {
      runId: "run-scored",
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 4 }],
    });

    const unscored = (await runtime.call("list_runs", {
      itemId: where.itemId,
      scored: "no",
    })) as ListRunsOutput;
    expect(unscored.runs.map((run) => run.runId)).toEqual(["run-unscored"]);

    const scored = (await runtime.call("list_runs", {
      itemId: where.itemId,
      scored: "yes",
    })) as ListRunsOutput;
    expect(scored.runs.map((run) => run.runId)).toEqual(["run-scored"]);
  });

  it("narrows to runs started at or after `since`", async () => {
    const where = await createItem();
    await addRun(where, { id: "run-old", startedAt: at(0) });
    await addRun(where, { id: "run-new", startedAt: at(30) });

    const result = (await runtime.call("list_runs", {
      itemId: where.itemId,
      since: at(10).toISOString(),
    })) as ListRunsOutput;
    expect(result.runs.map((run) => run.runId)).toEqual(["run-new"]);
  });

  it("RETURNS an open run rather than hiding it, with endedAt null", async () => {
    const where = await createItem();
    await addRun(where, { id: "run-open", startedAt: at(0), endedAt: null });

    const result = (await runtime.call("list_runs", { itemId: where.itemId })) as ListRunsOutput;

    // The whole point: a just-started run must not make an item look empty.
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.runId).toBe("run-open");
    expect(result.runs[0]?.endedAt).toBeNull();
  });

  it("returns the (unreported) model sentinel VERBATIM, never mapped to null", async () => {
    const where = await createItem();
    await addRun(where, {
      id: "run-unreported",
      startedAt: at(0),
      model: UNREPORTED,
      effort: UNREPORTED,
    });

    const result = (await runtime.call("list_runs", { itemId: where.itemId })) as ListRunsOutput;

    // `openRun` maps this sentinel BACK to null for the boundary rule. That
    // is correct there and wrong here, and this assertion is what stops the
    // wrong direction being inherited by a copied helper.
    expect(result.runs[0]?.model).toBe("(unreported)");
    expect(result.runs[0]?.model).not.toBeNull();
    expect(result.runs[0]?.effort).toBe("(unreported)");
  });

  it("reports an item with no runs as an empty list, not a NotFoundError", async () => {
    const where = await createItem();

    const result = (await runtime.call("list_runs", { itemId: where.itemId })) as ListRunsOutput;

    // "This item has no runs" is an answer, not a failure. A NotFoundError
    // here would be indistinguishable from "no such item".
    expect(result.runs).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  // ── The unknown-id asymmetry, pinned deliberately ────────────────────
  //
  // These two cases look inconsistent and are not. `resolveItemId` returns
  // a full UUID UNCHANGED without checking it exists — only a SHORT id is
  // looked up, because that is the form that can be ambiguous. So a
  // well-formed but unknown UUID falls through to the query and lists
  // nothing, exactly as `get_run_scores` returns empty aggregates for an
  // unknown `runId` rather than refusing.
  //
  // Both are pinned because the asymmetry is surprising enough that someone
  // will eventually "fix" one of them, and each direction has a caller
  // depending on it: the short-id refusal is what makes a mistyped prefix
  // diagnosable, and the full-UUID empty answer is what keeps this read
  // behaving like a filter rather than a lookup.
  it("returns an empty list for a well-formed but unknown item UUID", async () => {
    const result = (await runtime.call("list_runs", {
      itemId: "d4f1a2b3-0000-4000-8000-000000000000",
    })) as ListRunsOutput;

    expect(result.runs).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("REFUSES a short id prefix that matches no item", async () => {
    // The short-id path does resolve, so a mistyped prefix is a refusal
    // naming the field rather than a silently empty answer.
    //
    // Must be a VALID short-id shape to exercise that path at all: hex-ish
    // and at least SHORT_ID_MIN_LENGTH (8) characters. A non-hex string
    // like "zzzzzz" is not a short id, falls through unresolved, and would
    // make this test pass for the wrong reason.
    await expect(runtime.call("list_runs", { itemId: "deadbeef" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("names only AGENT-scored facets in scoredFacets, so a caller can dodge the freeze by reading", async () => {
    const where = await createItem();
    await addRun(where, { id: "run-partly-frozen", startedAt: at(0) });
    await runtime.call("score_run", {
      runId: "run-partly-frozen",
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 4 }],
    });
    // A person-only facet. NOT frozen — an agent score may still be written
    // to it — so it must not be reported as one.
    await runtime.call("score_run", {
      runId: "run-partly-frozen",
      raterType: "person",
      raterId: "reviewer-1",
      scores: [{ facet: "precision", score: 2 }],
    });

    const result = (await runtime.call("list_runs", { itemId: where.itemId })) as ListRunsOutput;

    expect(result.runs[0]?.scoredFacets).toEqual(["reasoning"]);
    expect(result.runs[0]?.scoredFacets).not.toContain("precision");
    // `scored` is the broader question — any score by any rater — and is
    // deliberately not derived from `scoredFacets`.
    expect(result.runs[0]?.scored).toBe(true);
  });

  it("reports scored: false for a run nobody has judged", async () => {
    const where = await createItem();
    await addRun(where, { id: "run-untouched", startedAt: at(0) });

    const result = (await runtime.call("list_runs", { itemId: where.itemId })) as ListRunsOutput;

    // The negative control for the assertion above: without it, a handler
    // hardcoding `scored: true` would pass every other case in this file.
    expect(result.runs[0]?.scored).toBe(false);
    expect(result.runs[0]?.scoredFacets).toEqual([]);
  });
});
