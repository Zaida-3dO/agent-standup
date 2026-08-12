// Import verification (MILESTONES.md #13, DECISIONS.md §13h). Real Postgres
// only, per CLAUDE.md's testing tenet. Mirrors tests/import-items.test.ts and
// tests/import-assignments-artifacts.test.ts for scratch-database setup.
// Skips without TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { createRepo } from "@/lib/repos";
import { importItems, type SourceTask } from "@/lib/import-items";
import { importEvents } from "@/lib/import-events";
import {
  importAssignmentsAndArtifacts,
  type SourceTaskAssignmentsArtifacts,
} from "@/lib/import-assignments-artifacts";
import {
  sampleTasks,
  spotCheckItems,
  spotCheckTask,
  verifyAssignmentArtifactRowCounts,
  verifyEventRowCounts,
  verifyItemRowCounts,
} from "@/lib/import-verify";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

// ---------------------------------------------------------------------------
// Pure unit — no database needed.
// ---------------------------------------------------------------------------

describe("sampleTasks", () => {
  it("returns every task unchanged when there are fewer than sampleSize", () => {
    const tasks = [{ id: "a" }, { id: "b" }];
    expect(sampleTasks(tasks, 20)).toEqual(tasks);
  });

  it("spreads the sample across the whole list rather than clustering at the start", () => {
    // 100 tasks, sample of 5: a start-clustered sampler would return
    // ids 0-4; this must reach into the back half of the list too.
    const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` }));
    const sample = sampleTasks(tasks, 5);
    expect(sample).toHaveLength(5);
    const indices = sample.map((t) => Number(t.id.slice(1)));
    // At least one sampled index must be in the back half — proves the
    // stride logic, not just "returns N items from the front".
    expect(indices.some((i) => i >= 50)).toBe(true);
    // Deterministic: running it again on the same input returns the same ids.
    expect(sampleTasks(tasks, 5).map((t) => t.id)).toEqual(sample.map((t) => t.id));
  });

  it("returns everything when sampleSize is 0 or negative", () => {
    const tasks = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(sampleTasks(tasks, 0)).toEqual(tasks);
    expect(sampleTasks(tasks, -1)).toEqual(tasks);
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres.
// ---------------------------------------------------------------------------

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("import verification — against a real Postgres", () => {
  const dbName = scratchDatabaseName("import_verify");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await createRepo(prisma, { id: "web", displayName: "Web", defaultBranch: "main" });
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.artifact.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  const repoAliases = { "web-app": "web" };

  function buildSource(): {
    tasks: SourceTask[];
    assignmentTasks: SourceTaskAssignmentsArtifacts[];
  } {
    const tasks: SourceTask[] = [
      {
        id: "verify-open-1",
        title: "Fix the thing",
        body: "Open, in-flight task.",
        status: "in-progress",
        area: "Web",
        repo: "web-app",
        history: [
          { id: "h1", actor: "user-a", at: "2026-08-01T09:00:00.000Z", note: "Started." },
          { id: "h2", actor: "user-a", at: "2026-08-01T10:00:00.000Z", note: "Made progress." },
        ],
      },
      {
        id: "verify-done-1",
        title: "Ship the feature",
        body: "Finished task — history collapses to one summary row.",
        status: "done",
        area: "Web",
        repo: "web-app",
        history: [
          { id: "h3", actor: "user-a", at: "2026-08-01T09:00:00.000Z", note: "Started." },
          { id: "h4", actor: "user-a", at: "2026-08-01T09:30:00.000Z", note: "Reviewed." },
          { id: "h5", actor: "user-a", at: "2026-08-01T10:00:00.000Z", note: "Merged." },
        ],
      },
      {
        id: "verify-no-history-1",
        title: "Research something",
        body: "No history log at all.",
        status: "todo",
        area: "research",
      },
    ];

    const assignmentTasks: SourceTaskAssignmentsArtifacts[] = [
      {
        id: "verify-open-1",
        claims: [
          {
            id: "claim-1",
            sessionId: "session-a",
            role: "builder",
            holderType: "agent",
            holderId: "crew-member",
            machine: "laptop",
            claimedAt: "2026-08-01T09:00:00.000Z",
            releasedAt: "2026-08-01T10:00:00.000Z",
          },
        ],
        reviews: [
          {
            id: "review-1",
            kind: "code_review",
            verdict: "approved",
            createdByType: "agent",
            createdById: "reviewer-crew",
            createdAt: "2026-08-01T10:30:00.000Z",
          },
        ],
      },
    ];

    return { tasks, assignmentTasks };
  }

  const actorAliases = {
    "user-a": { actorType: "person" as const, actorId: "test-person" },
  };

  beforeAll(async () => {
    // A `people` row for actorAliases to resolve against — Event.actorId has
    // no FK, but seeding it keeps the fixture honest about what a real
    // import run would have required.
  });

  /** Runs #10 -> #11 -> #12 in sequence, exactly the order the milestones require. */
  async function runFullImport() {
    const { tasks, assignmentTasks } = buildSource();
    const itemsResult = await importItems(prisma, tasks, { repoAliases });
    const eventsResult = await importEvents(prisma, tasks, { actorAliases });
    const assignmentsResult = await importAssignmentsAndArtifacts(prisma, assignmentTasks);
    return { tasks, assignmentTasks, itemsResult, eventsResult, assignmentsResult };
  }

  // -- Row counts -----------------------------------------------------------

  it("verifyItemRowCounts reports a clean match after a full import", async () => {
    const { tasks } = await runFullImport();

    const report = await verifyItemRowCounts(prisma, tasks);
    expect(report).toEqual({
      sourceTaskCount: 3,
      importedItemCount: 3,
      missingFromDb: [],
      unexpectedInDb: [],
      matches: true,
    });
  });

  it("verifyItemRowCounts catches a task the importer never ran against — the load-bearing failure case", async () => {
    const { tasks } = await runFullImport();

    // A task the SOURCE has but the importer was never handed — proves this
    // isn't just re-deriving "count === count" but actually diffing ids.
    const tasksPlusOne: SourceTask[] = [
      ...tasks,
      {
        id: "never-imported",
        title: "Was never imported",
        body: "x",
        status: "todo",
        area: "web",
      },
    ];

    const report = await verifyItemRowCounts(prisma, tasksPlusOne);
    expect(report.matches).toBe(false);
    expect(report.missingFromDb).toEqual(["never-imported"]);
    expect(report.sourceTaskCount).toBe(4);
    expect(report.importedItemCount).toBe(3);
  });

  it("verifyItemRowCounts reports unexpectedInDb when the db has more legacy_id rows than the source list given", async () => {
    const { tasks } = await runFullImport();

    // Verify against a SUBSET of the source — the row missing from the list
    // (but present in the db) must show up as unexpected, not silently pass.
    const subset = tasks.filter((t) => t.id !== "verify-done-1");
    const report = await verifyItemRowCounts(prisma, subset);
    expect(report.matches).toBe(false);
    expect(report.unexpectedInDb).toEqual(["verify-done-1"]);
  });

  it("verifyEventRowCounts expects 1 collapsed row for a terminal task and N rows for an in-flight task", async () => {
    const { tasks } = await runFullImport();

    const report = await verifyEventRowCounts(prisma, tasks);
    // verify-open-1: 2 history entries, in-flight -> full history -> 2 rows.
    // verify-done-1: 3 history entries, terminal -> collapsed -> 1 row.
    // verify-no-history-1: no history -> 0 rows, skipped entirely.
    expect(report.expectedTotal).toBe(3);
    expect(report.actualTotal).toBe(3);
    expect(report.mismatched).toEqual([]);
    expect(report.matches).toBe(true);
  });

  it("verifyEventRowCounts catches a mismatch — deleting one imported event row breaks the count", async () => {
    const { tasks } = await runFullImport();

    // Corrupt the database directly: delete one of the two full-history rows
    // for verify-open-1, simulating a partial/broken import.
    const item = await prisma.item.findFirstOrThrow({
      where: { customFields: { path: ["legacy_id"], equals: "verify-open-1" } },
    });
    const events = await prisma.event.findMany({ where: { itemId: item.id } });
    expect(events).toHaveLength(2);
    await prisma.event.delete({ where: { id: events[0]!.id } });

    const report = await verifyEventRowCounts(prisma, tasks);
    expect(report.matches).toBe(false);
    expect(report.mismatched).toEqual(["verify-open-1"]);
    expect(report.actualTotal).toBe(2); // 1 (corrupted) + 1 (collapsed done) = 2, expected 3.
  });

  it("verifyAssignmentArtifactRowCounts reports a clean match after a full import", async () => {
    const { assignmentTasks } = await runFullImport();

    const report = await verifyAssignmentArtifactRowCounts(prisma, assignmentTasks);
    expect(report).toEqual({
      expectedClaims: 1,
      actualClaims: 1,
      expectedReviews: 1,
      actualReviews: 1,
      matches: true,
    });
  });

  // -- Spot-check -------------------------------------------------------------

  it("spotCheckTask reports every field matching for a correctly-imported task", async () => {
    const { tasks } = await runFullImport();
    const task = tasks.find((t) => t.id === "verify-open-1")!;

    const result = await spotCheckTask(prisma, task, { repoAliases });
    expect(result.found).toBe(true);
    expect(result.matches).toBe(true);
    const titleField = result.fields.find((f) => f.field === "title");
    expect(titleField).toEqual({
      field: "title",
      expected: "Fix the thing",
      actual: "Fix the thing",
      matches: true,
    });
    const repoField = result.fields.find((f) => f.field === "repo");
    expect(repoField).toEqual({ field: "repo", expected: "web", actual: "web", matches: true });
  });

  it("spotCheckTask reports found: false for a task never imported", async () => {
    await runFullImport();
    const ghost: SourceTask = {
      id: "ghost-task",
      title: "Never imported",
      body: "x",
      status: "todo",
      area: "web",
    };

    const result = await spotCheckTask(prisma, ghost, { repoAliases });
    expect(result).toEqual({ taskId: "ghost-task", found: false, fields: [], matches: false });
  });

  it("spotCheckTask catches a field that drifted from the source — title corrupted after import", async () => {
    const { tasks } = await runFullImport();
    const task = tasks.find((t) => t.id === "verify-open-1")!;

    const item = await prisma.item.findFirstOrThrow({
      where: { customFields: { path: ["legacy_id"], equals: "verify-open-1" } },
    });
    await prisma.item.update({ where: { id: item.id }, data: { title: "Corrupted title" } });

    const result = await spotCheckTask(prisma, task, { repoAliases });
    expect(result.matches).toBe(false);
    const titleField = result.fields.find((f) => f.field === "title");
    expect(titleField?.matches).toBe(false);
    expect(titleField?.expected).toBe("Fix the thing");
    expect(titleField?.actual).toBe("Corrupted title");
  });

  it("spotCheckItems samples across the imported set and reports allMatch", async () => {
    const { tasks } = await runFullImport();

    const report = await spotCheckItems(prisma, tasks, { repoAliases, sampleSize: 10 });
    expect(report.sampled).toBe(3); // fewer tasks than sampleSize -> all of them
    expect(report.allMatch).toBe(true);
  });

  // -- Idempotent re-run: the highest-value assertion in this row -----------

  it("running the FULL import pipeline (#10 -> #11 -> #12) twice against the same database converges: second run imports nothing new and row counts are identical", async () => {
    const first = await runFullImport();
    expect(first.itemsResult).toEqual({ imported: 3, skippedExisting: 0 });
    expect(first.eventsResult.imported).toBe(3); // 2 (open) + 1 (collapsed done) = 3
    expect(first.eventsResult.skippedExisting).toBe(0);
    expect(first.assignmentsResult).toEqual({
      claimsImported: 1,
      claimsSkippedExisting: 0,
      claimsConflicted: 0,
      reviewsImported: 1,
      reviewsSkippedExisting: 0,
    });

    // Snapshot every table's row count and verification report after the
    // first run — this is what "the second run changed nothing" is measured
    // against.
    const itemCountAfterFirst = await prisma.item.count();
    const eventCountAfterFirst = await prisma.event.count();
    const assignmentCountAfterFirst = await prisma.assignment.count();
    const artifactCountAfterFirst = await prisma.artifact.count();
    const rowCountReportAfterFirst = await verifyItemRowCounts(prisma, first.tasks);
    const eventReportAfterFirst = await verifyEventRowCounts(prisma, first.tasks);

    // Second run: same source, same (already-populated) database. Every
    // importer must report zero new rows and 100% "already there".
    const { tasks, assignmentTasks } = buildSource();
    const itemsResult2 = await importItems(prisma, tasks, { repoAliases });
    const eventsResult2 = await importEvents(prisma, tasks, { actorAliases });
    const assignmentsResult2 = await importAssignmentsAndArtifacts(prisma, assignmentTasks);

    // The direct proof: nothing NEW was imported the second time.
    expect(itemsResult2).toEqual({ imported: 0, skippedExisting: 3 });
    expect(eventsResult2.imported).toBe(0);
    expect(eventsResult2.skippedExisting).toBe(3);
    expect(assignmentsResult2).toEqual({
      claimsImported: 0,
      claimsSkippedExisting: 1,
      claimsConflicted: 0,
      reviewsImported: 0,
      reviewsSkippedExisting: 1,
    });

    // The convergence proof: table row counts are BYTE-IDENTICAL to after
    // the first run — not just "the importer said 0", but the database
    // itself did not grow.
    expect(await prisma.item.count()).toBe(itemCountAfterFirst);
    expect(await prisma.event.count()).toBe(eventCountAfterFirst);
    expect(await prisma.assignment.count()).toBe(assignmentCountAfterFirst);
    expect(await prisma.artifact.count()).toBe(artifactCountAfterFirst);

    // And the verification reports themselves are identical before/after —
    // a re-run is invisible to anything reading the database afterward.
    const rowCountReportAfterSecond = await verifyItemRowCounts(prisma, tasks);
    const eventReportAfterSecond = await verifyEventRowCounts(prisma, tasks);
    expect(rowCountReportAfterSecond).toEqual(rowCountReportAfterFirst);
    expect(eventReportAfterSecond).toEqual(eventReportAfterFirst);

    // Finally: spot-check still finds every field intact after the re-run —
    // an idempotent import that silently mutated a field on the second pass
    // (rather than skipping) would be caught here even though the row COUNT
    // never moved.
    const spotReport = await spotCheckItems(prisma, tasks, { repoAliases });
    expect(spotReport.allMatch).toBe(true);
  });

  it("running the import a THIRD time still converges — idempotency isn't a one-shot coincidence", async () => {
    await runFullImport();
    const { tasks, assignmentTasks } = buildSource();
    await importItems(prisma, tasks, { repoAliases });
    await importEvents(prisma, tasks, { actorAliases });
    await importAssignmentsAndArtifacts(prisma, assignmentTasks);

    const itemCount = await prisma.item.count();
    const eventCount = await prisma.event.count();

    const itemsResult3 = await importItems(prisma, tasks, { repoAliases });
    const eventsResult3 = await importEvents(prisma, tasks, { actorAliases });
    const assignmentsResult3 = await importAssignmentsAndArtifacts(prisma, assignmentTasks);

    expect(itemsResult3).toEqual({ imported: 0, skippedExisting: 3 });
    expect(eventsResult3.imported).toBe(0);
    expect(assignmentsResult3.claimsImported).toBe(0);
    expect(assignmentsResult3.reviewsImported).toBe(0);
    expect(await prisma.item.count()).toBe(itemCount);
    expect(await prisma.event.count()).toBe(eventCount);
  });
});
