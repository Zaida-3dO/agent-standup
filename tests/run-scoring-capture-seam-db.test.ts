// The capture seam — MILESTONES.md #67, against real Postgres.
//
// ── Why this file exists, stated as the failure it exists to catch ─────
//
// A scoring system with no writer is the failure this project has already
// hit once: `score_intervention` has no caller anywhere outside its own
// definition, so its tables hold zero rows and would still hold zero the
// day after a deploy. Everything about that design is sound except that
// nothing ever calls it.
//
// So the claim under test here is not "the derivation is correct" — the
// pure tests settle that — but "something actually invokes it on real
// work". These cases drive `complete_item` end to end, through the real
// guards, and then ask Postgres whether a score appeared. A seam that was
// wired but never reached fails here; a seam deleted entirely fails here.
//
// The other half of the claim is that it ships SWITCHED OFF, so the default
// case asserts that nothing is written, and the enabled case asserts that
// something is.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ServiceRuntime, guardRegistry, prismaTransactionRunner } from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { defaultSnapshot, type SettingsSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

function validSummary(overrides: Record<string, unknown> = {}) {
  return {
    shipped: ["Delivered the thing."],
    not_done: [],
    user_facing: false,
    how_verified: "Ran it locally and watched it work end to end.",
    watch_for: [],
    ...overrides,
  };
}

/** A snapshot with run-score derivation switched on. */
function snapshotWithDerivation(): SettingsSnapshot {
  const base = defaultSnapshot();
  return {
    ...base,
    values: { ...base.values, "scoring.auto_derive": true },
  } as SettingsSnapshot;
}

describeIfDb("the run-scoring capture seam — against Postgres", () => {
  const dbName = scratchDatabaseName("run_scoring_seam");
  let scratchUrl: string;
  let prisma: PrismaClient;
  /** Derivation off — the shipped default. */
  let runtime: ServiceRuntime;
  /** Derivation on, as an operator would enable it. */
  let enabledRuntime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });

    for (const guard of ALL_GUARDS) {
      if (!guardRegistry.has(guard.id)) guardRegistry.register(guard);
    }

    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    enabledRuntime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => snapshotWithDerivation(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.runScore.deleteMany({});
    await prisma.run.deleteMany({});
    await prisma.artifact.deleteMany({});
    await prisma.summary.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let counter = 0;

  /**
   * An item in `in_review` with a run behind it, ready to be completed.
   *
   * `difficulty` is what declares which facets the work exercised, and the
   * two values differ so a test cannot pass by reading the wrong key.
   */
  async function seedItem(
    difficulty: Record<string, number> | null = { reasoning: 4, precision: 2 },
  ): Promise<{ itemId: string; runId: string }> {
    counter += 1;
    const itemId = `item-${counter}`;
    const assignmentId = `assignment-${counter}`;
    const runId = `run-${counter}`;

    await prisma.item.create({
      data: {
        id: itemId,
        kind: "task",
        title: `Item ${counter}`,
        body: "body",
        state: "in_review" as never,
        originType: "person",
        area: "web",
        mergeAuthority: "needs_approval",
        difficulty: difficulty === null ? undefined : difficulty,
      },
    });
    await prisma.assignment.create({
      data: {
        id: assignmentId,
        itemId,
        role: "builder" as never,
        holderType: "agent" as never,
        holderId: `agent-${counter}`,
        sessionId: `session-${counter}`,
        rootSessionId: `session-${counter}`,
        machine: "desktop",
      },
    });
    await prisma.run.create({
      data: { id: runId, itemId, assignmentId, model: "tier-a", effort: "medium" },
    });
    return { itemId, runId };
  }

  /** The real evidence the merge guards demand, plus the review rounds. */
  async function satisfyMergeGuards(
    itemId: string,
    rounds: { round: number; verdict: string }[] = [{ round: 1, verdict: "approved" }],
    commitSha = "commit-a",
  ): Promise<void> {
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        itemId,
        kind: "commit",
        commitSha,
        createdByType: "agent",
        createdById: "test-actor",
      },
    });
    for (const entry of rounds) {
      await prisma.artifact.create({
        data: {
          id: randomUUID(),
          itemId,
          kind: "code_review",
          verdict: entry.verdict as never,
          commitSha,
          reviewRound: entry.round,
          createdByType: "agent",
          createdById: "test-reviewer",
        },
      });
    }
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        itemId,
        kind: "merge_approval",
        commitSha,
        reviewRound: rounds.at(-1)!.round,
        createdByType: "person",
        createdById: "test-approver",
      },
    });
  }

  async function scoresFor(runId: string) {
    return prisma.$queryRawUnsafe<{ facet: string; agentScore: number | null }[]>(
      `SELECT "facet"::text AS "facet", "agentScore"
         FROM "RunScore" WHERE "runId" = $1 ORDER BY "facet"`,
      runId,
    );
  }

  async function complete(rt: ServiceRuntime, itemId: string): Promise<void> {
    await rt.call("complete_item", { id: itemId, to: "merged", summary: validSummary() });
  }

  it("writes NOTHING by default — the mechanism ships switched off", async () => {
    const { itemId, runId } = await seedItem();
    await satisfyMergeGuards(itemId);

    await complete(runtime, itemId);

    // The item really did complete; it is the scoring that stayed dormant.
    expect((await prisma.item.findUniqueOrThrow({ where: { id: itemId } })).state).toBe("merged");
    expect(await scoresFor(runId)).toEqual([]);
  });

  it("RECORDS a score through a real complete_item once enabled", async () => {
    const { itemId, runId } = await seedItem();
    await satisfyMergeGuards(itemId);

    await complete(enabledRuntime, itemId);

    // The claim this whole file exists for: a row appeared because ordinary
    // work finished, with nothing in the test calling a scoring operation.
    const scores = await scoresFor(runId);
    expect(scores.map((s) => s.facet)).toEqual(["precision", "reasoning"]);
    // One clean round at the top of the scale.
    expect(scores.every((s) => s.agentScore === 5)).toBe(true);
  });

  it("derives a WORSE score from a troubled review history", async () => {
    const { itemId, runId } = await seedItem();
    // Three rounds, the first two blocking — the same completion path, but
    // the recorded history says the work went badly.
    await satisfyMergeGuards(itemId, [
      { round: 1, verdict: "changes_required" },
      { round: 2, verdict: "changes_required" },
      { round: 3, verdict: "approved" },
    ]);

    await complete(enabledRuntime, itemId);

    const scores = await scoresFor(runId);
    // 5 - 2 blocking - 2 extra rounds = 2, on the default weights. The
    // point is that it is strictly worse than the clean case above, from
    // the same code path and the same call.
    expect(scores[0]!.agentScore).toBe(2);
  });

  it("scores nothing when the item declared no facets", async () => {
    const { itemId, runId } = await seedItem(null);
    await satisfyMergeGuards(itemId);

    await complete(enabledRuntime, itemId);

    // No facet was claimed, so no dimension can honestly be scored.
    expect(await scoresFor(runId)).toEqual([]);
  });

  it("does not overwrite a score the agent already froze", async () => {
    const { itemId, runId } = await seedItem();
    await satisfyMergeGuards(itemId);
    await enabledRuntime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 1 }],
    });

    await complete(enabledRuntime, itemId);

    const scores = await scoresFor(runId);
    const reasoning = scores.find((s) => s.facet === "reasoning");
    const precision = scores.find((s) => s.facet === "precision");
    // The frozen 1 survives a derivation that would have written 5...
    expect(reasoning?.agentScore).toBe(1);
    // ...while the facet nobody had scored still gets one.
    expect(precision?.agentScore).toBe(5);
  });

  it("completes the item even when scoring cannot run", async () => {
    // A run whose item declares a facet the enum does not have. The
    // derivation drops it, so nothing is written — and the completion, which
    // is the caller's actual work, still succeeds.
    const { itemId, runId } = await seedItem({ telepathy: 5 } as Record<string, number>);
    await satisfyMergeGuards(itemId);

    await complete(enabledRuntime, itemId);

    expect((await prisma.item.findUniqueOrThrow({ where: { id: itemId } })).state).toBe("merged");
    expect(await scoresFor(runId)).toEqual([]);
  });
});
