// The run-scoring operations against real Postgres — MILESTONES.md #66.
//
// ── Why this file exists, stated as the failure it exists to catch ─────
//
// The pure tests prove the freeze RULE. They cannot prove the write obeys
// it, because the guarantee is not in TypeScript: it is the
// `WHERE "RunScore"."agentScore" IS NULL` clause on the conflict update.
// That clause could be deleted, or the whole `ON CONFLICT` turned into a
// plain overwrite, and every pure test would still pass while the column
// quietly stopped being immutable — destroying the agent/person delta the
// table exists to hold.
//
// So the semantics are pinned here, by executing the real statements
// against real rows. The cases are the ways the write can be wrong in a
// direction nobody would notice from behaviour:
//
//   - **An agent score cannot be overwritten**, including by the same value.
//   - **A user score CAN be written beside it**, leaving the agent score
//     untouched — the disagreement has to survive.
//   - **Accepting copies the agent score across**, so a null user score
//     never means "looked and agreed".
//   - **Accepting a facet with no agent score is refused**, rather than
//     writing a judgement nobody made.
//   - **A person may revise their own score**, which is not the thing being
//     preserved.
//
// Skips without TEST_DATABASE_URL, like every other database-backed file
// here; CI's database job runs it.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ServiceRuntime,
  prismaTransactionRunner,
} from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { AcceptRunScoreOutput } from "@/lib/service/operations/accept-run-score";
import type { GetRunScoresOutput } from "@/lib/service/operations/get-run-scores";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("run scoring operations — against Postgres", () => {
  const dbName = scratchDatabaseName("run_scoring_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.repo.create({ data: { id: "infra", displayName: "infra" } });
    await prisma.person.create({ data: { id: "reviewer-1", displayName: "Reviewer One" } });
    await prisma.person.create({ data: { id: "reviewer-2", displayName: "Reviewer Two" } });
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

  /** A run to hang scores on, with an item and assignment behind it. */
  async function createRun(model = "tier-a"): Promise<string> {
    counter += 1;
    const itemId = `item-${counter}`;
    const assignmentId = `assignment-${counter}`;
    const runId = `run-${counter}`;

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
        sessionId: `session-${counter}`,
        rootSessionId: `session-${counter}`,
        machine: "desktop",
      },
    });
    await prisma.run.create({
      data: { id: runId, itemId, assignmentId, model, effort: "medium" },
    });
    return runId;
  }

  /**
   * A run whose item DECLARES facets, which is the state the undeclared-facet
   * refusal is about. The default `createRun` leaves `difficulty` null, so
   * every test above it exercises the unconstrained branch.
   */
  async function createRunDeclaring(difficulty: Record<string, number>): Promise<string> {
    const runId = await createRun();
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    await prisma.item.update({
      where: { id: run.itemId },
      data: { difficulty },
    });
    return runId;
  }

  /** The stored row, read outside the operation that wrote it. */
  async function storedScore(runId: string, facet: string) {
    const rows = await prisma.$queryRawUnsafe<
      { agentScore: number | null; userScore: number | null; userScoredBy: string | null }[]
    >(
      `SELECT "agentScore", "userScore", "userScoredBy"
         FROM "RunScore" WHERE "runId" = $1 AND "facet" = $2::"Facet"`,
      runId,
      facet,
    );
    return rows[0];
  }

  it("writes an agent score, and it lands in the agent column only", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 4 }],
    });

    const stored = await storedScore(runId, "reasoning");
    // The positive control. Without it, the refusal tests below would pass
    // just as well against an operation whose insert never worked at all.
    expect(stored?.agentScore).toBe(4);
    expect(stored?.userScore).toBeNull();
  });

  it("REFUSES to overwrite an agent score, which is the whole point", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 5 }],
    });

    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "agent",
        scores: [{ facet: "reasoning", score: 2 }],
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Asked of Postgres directly: the original value has to still be there.
    // A handler that caught its own refusal after writing leaves a 2 here.
    expect((await storedScore(runId, "reasoning"))?.agentScore).toBe(5);
  });

  it("refuses a re-write of the SAME value, so a retry cannot become a correction", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "precision", score: 3 }],
    });
    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "agent",
        scores: [{ facet: "precision", score: 3 }],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("keeps a person's disagreement BESIDE the agent score, not on top of it", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 5 }],
    });
    await runtime.call("score_run", {
      runId,
      raterType: "person",
      raterId: "reviewer-1",
      scores: [{ facet: "reasoning", score: 2 }],
    });

    const stored = await storedScore(runId, "reasoning");
    // Both survive. This row — agent 5, person 2 — is the most informative
    // shape the table can hold, and it exists only if neither overwrites.
    expect(stored?.agentScore).toBe(5);
    expect(stored?.userScore).toBe(2);
    expect(stored?.userScoredBy).toBe("reviewer-1");
  });

  it("lets a person revise their own score, which is not what is preserved", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "person",
      raterId: "reviewer-1",
      scores: [{ facet: "breadth", score: 2 }],
    });
    await runtime.call("score_run", {
      runId,
      raterType: "person",
      raterId: "reviewer-2",
      scores: [{ facet: "breadth", score: 4 }],
    });

    const stored = await storedScore(runId, "breadth");
    expect(stored?.userScore).toBe(4);
    expect(stored?.userScoredBy).toBe("reviewer-2");
  });

  it("requires a rater id for a person score", async () => {
    const runId = await createRun();
    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "person",
        scores: [{ facet: "writing", score: 3 }],
      }),
    ).rejects.toThrow(/raterId/);
  });

  it("refuses a score against a run that does not exist", async () => {
    await expect(
      runtime.call("score_run", {
        runId: "no-such-run",
        raterType: "agent",
        scores: [{ facet: "writing", score: 3 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses the same facet twice in one call", async () => {
    const runId = await createRun();
    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "agent",
        scores: [
          { facet: "writing", score: 3 },
          { facet: "writing", score: 4 },
        ],
      }),
    ).rejects.toThrow(/twice/);
  });

  it("scores several facets in one call, each keeping its own value", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      // Different values per facet: equal ones could not catch a handler
      // that wrote the same score to every row.
      scores: [
        { facet: "reasoning", score: 5 },
        { facet: "precision", score: 2 },
        { facet: "autonomy", score: 3 },
      ],
    });

    expect((await storedScore(runId, "reasoning"))?.agentScore).toBe(5);
    expect((await storedScore(runId, "precision"))?.agentScore).toBe(2);
    expect((await storedScore(runId, "autonomy"))?.agentScore).toBe(3);
  });

  it("accepting COPIES the agent score into the user column", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 4 }],
    });
    await runtime.call("accept_run_score", { runId, raterId: "reviewer-1" });

    const stored = await storedScore(runId, "reasoning");
    // The copy is what makes a null user score mean exactly one thing.
    // A no-op accept leaves this null and "agreed" becomes unreadable.
    expect(stored?.userScore).toBe(4);
    expect(stored?.agentScore).toBe(4);
    expect(stored?.userScoredBy).toBe("reviewer-1");
  });

  it("accepts only the facets asked for", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [
        { facet: "reasoning", score: 5 },
        { facet: "precision", score: 2 },
      ],
    });
    await runtime.call("accept_run_score", {
      runId,
      facets: ["reasoning"],
      raterId: "reviewer-1",
    });

    expect((await storedScore(runId, "reasoning"))?.userScore).toBe(5);
    // Untouched: accepting one facet must not sweep the others.
    expect((await storedScore(runId, "precision"))?.userScore).toBeNull();
  });

  it("does not overwrite a user score the person already set", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 5 }],
    });
    await runtime.call("score_run", {
      runId,
      raterType: "person",
      raterId: "reviewer-1",
      scores: [{ facet: "reasoning", score: 2 }],
    });
    // Unfiltered accept: only facets nobody has judged are eligible.
    await runtime.call("accept_run_score", { runId, raterId: "reviewer-2" });

    const stored = await storedScore(runId, "reasoning");
    // The correction stands. An accept that clobbered it would silently
    // convert a disagreement into agreement.
    expect(stored?.userScore).toBe(2);
    expect(stored?.userScoredBy).toBe("reviewer-1");
  });

  it("refuses to accept a facet the agent never scored", async () => {
    const runId = await createRun();
    await expect(
      runtime.call("accept_run_score", {
        runId,
        facets: ["visual"],
        raterId: "reviewer-1",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // No row was invented for a judgement nobody made.
    expect(await storedScore(runId, "visual")).toBeUndefined();
  });

  it("accepting twice is idempotent rather than an error", async () => {
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "breadth", score: 3 }],
    });
    await runtime.call("accept_run_score", { runId, raterId: "reviewer-1" });
    const second = (await runtime.call("accept_run_score", {
      runId,
      raterId: "reviewer-1",
    })) as AcceptRunScoreOutput;

    // The second accept finds nothing outstanding, which is not a failure.
    expect(second.accepted).toEqual([]);
    expect((await storedScore(runId, "breadth"))?.userScore).toBe(3);
  });

  it("reports the aggregate with the distribution intact", async () => {
    const runA = await createRun();
    const runB = await createRun();
    const runC = await createRun();
    // Nine-good-one-bad, compressed: two 4s and a 1 on the same facet.
    await runtime.call("score_run", {
      runId: runA,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 4 }],
    });
    await runtime.call("score_run", {
      runId: runB,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 4 }],
    });
    await runtime.call("score_run", {
      runId: runC,
      raterType: "agent",
      scores: [{ facet: "reasoning", score: 1 }],
    });

    const report = (await runtime.call("get_run_scores", {
      source: "agent",
    })) as GetRunScoresOutput;

    const reasoning = report.facets.find((f) => f.facet === "reasoning");
    expect(reasoning?.count).toBe(3);
    expect(reasoning?.distribution[1]).toBe(1);
    expect(reasoning?.distribution[4]).toBe(2);
    // The single 1 is surfaced despite a mean of 3.
    expect(report.flagged.map((f) => f.facet)).toContain("reasoning");
    expect(report.scoredRuns).toBe(3);
  });

  it("counts runs nobody scored, rather than reporting silence as health", async () => {
    await createRun();
    const scored = await createRun();
    await runtime.call("score_run", {
      runId: scored,
      raterType: "agent",
      scores: [{ facet: "writing", score: 4 }],
    });

    const report = (await runtime.call("get_run_scores", {})) as GetRunScoresOutput;
    expect(report.scoredRuns).toBe(1);
    expect(report.unscoredRuns).toBe(1);
  });

  // ── Scoring a facet the item never declared ──────────────────────────
  //
  // The review card filters its sliders to the declared facets, so a person
  // clicking through the UI cannot score one the item never declared. That
  // is a constraint of the browser only, and it is not where the rule can
  // live: a direct caller reaches the same table, and the row it writes is
  // indistinguishable from an honest one — same columns, same 1-5 value —
  // so nothing downstream can separate them. Hence the refusal below.

  it("refuses a facet the item never declared, naming it", async () => {
    const runId = await createRunDeclaring({ reasoning: 3, precision: 2 });
    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "agent",
        scores: [{ facet: "visual", score: 5 }],
      }),
    ).rejects.toThrow(/visual/);
  });

  it("names the facets that WERE declared, so the caller knows what it could send", async () => {
    const runId = await createRunDeclaring({ reasoning: 3, precision: 2 });
    // Asserted on both declared names, not merely on "it threw": a message
    // that named only the rejected facet would leave the caller guessing.
    const call = runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "visual", score: 5 }],
    });
    await expect(call).rejects.toThrow(/reasoning/);
    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "agent",
        scores: [{ facet: "visual", score: 5 }],
      }),
    ).rejects.toThrow(/precision/);
  });

  it("writes NOTHING when one facet is declared and another is not", async () => {
    // The atomicity claim in the handler's comment, tested rather than
    // asserted in prose. `reasoning` is declared and would otherwise be
    // written before `visual` was reached, leaving a half-applied call.
    const runId = await createRunDeclaring({ reasoning: 3 });
    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "agent",
        scores: [
          { facet: "reasoning", score: 4 },
          { facet: "visual", score: 5 },
        ],
      }),
    ).rejects.toThrow(/visual/);
    expect(await storedScore(runId, "reasoning")).toBeUndefined();
    expect(await storedScore(runId, "visual")).toBeUndefined();
  });

  it("still accepts a declared facet on an item that declares some", async () => {
    // The refusal must not be a blanket one: this is what would break if
    // the check refused whenever any declaration existed.
    const runId = await createRunDeclaring({ reasoning: 3, precision: 2 });
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "precision", score: 4 }],
    });
    expect((await storedScore(runId, "precision"))?.agentScore).toBe(4);
  });

  it("allows any facet when the item declared none, which is most items", async () => {
    // The deliberate permissive branch. `difficulty` is nullable, optional
    // at creation and written by no operation, so refusing here would
    // refuse essentially every call this operation receives.
    const runId = await createRun();
    await runtime.call("score_run", {
      runId,
      raterType: "agent",
      scores: [{ facet: "visual", score: 5 }],
    });
    expect((await storedScore(runId, "visual"))?.agentScore).toBe(5);
  });

  it("refuses an undeclared facet from a person too, not only from an agent", async () => {
    // Both rater types write to the same table; a rule enforced on one
    // would leave the other free to write the meaningless row.
    const runId = await createRunDeclaring({ reasoning: 3 });
    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "person",
        raterId: "person-1",
        scores: [{ facet: "autonomy", score: 2 }],
      }),
    ).rejects.toThrow(/autonomy/);
    expect(await storedScore(runId, "autonomy")).toBeUndefined();
  });

  it("ignores a declared facet whose value is out of the 1-5 scale", async () => {
    // `declaredFacets` drops a key whose value is not a valid score, on the
    // grounds that the map is then not what the reader thinks it is. With
    // `visual: 9` dropped, the item's real declaration is {reasoning}, so
    // visual must still be refused rather than admitted by a malformed key.
    const runId = await createRunDeclaring({ reasoning: 3, visual: 9 });
    await expect(
      runtime.call("score_run", {
        runId,
        raterType: "agent",
        scores: [{ facet: "visual", score: 5 }],
      }),
    ).rejects.toThrow(/visual/);
  });

  it("accept_run_score cannot accept an undeclared facet either", async () => {
    // The sibling operation shares the surface. It needs no explicit check
    // because it copies only where `agentScore IS NOT NULL`, and an
    // undeclared facet has no row to copy — but that is a claim about
    // behaviour, so it is tested rather than assumed.
    const runId = await createRunDeclaring({ reasoning: 3 });
    await expect(
      runtime.call("accept_run_score", {
        runId,
        facets: ["visual"],
        raterId: "person-1",
      }),
    ).rejects.toThrow(/nothing to copy/);
    expect(await storedScore(runId, "visual")).toBeUndefined();
  });
});
