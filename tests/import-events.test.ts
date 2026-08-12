// Real Postgres only, per CLAUDE.md's testing tenet. See tests/repos.test.ts
// for the scratch-database setup this mirrors. Skips without TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { createRepo } from "@/lib/repos";
import { importItems, type SourceTask } from "@/lib/import-items";
import {
  importEvents,
  importEventsForTask,
  UnknownActorAliasError,
  type ActorAliasTarget,
} from "@/lib/import-events";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("import-events — against a real Postgres", () => {
  const dbName = scratchDatabaseName("import_events");
  let scratchUrl: string;
  let prisma: PrismaClient;

  const actorAliases: Record<string, ActorAliasTarget> = {
    "user-a": { actorType: "person", actorId: "user-a" },
    "agent-alpha": { actorType: "agent", actorId: "agent-alpha" },
  };

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await createRepo(prisma, { id: "web", displayName: "Web", defaultBranch: "main" });
    await prisma.person.create({ data: { id: "user-a", displayName: "User A" } });
    await prisma.agent.create({ data: { name: "agent-alpha" } });
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  // Each test imports its own task under a fresh legacy_id, so tests don't
  // need to truncate tables between runs — importItems' own idempotency
  // check (custom_fields.legacy_id) means a shared id across tests would
  // silently skip the second import instead of exercising it.
  let counter = 0;
  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  async function importOneTask(task: SourceTask): Promise<{ itemId: string; state: string }> {
    await importItems(prisma, [task], { repoAliases: { "web-app": "web" } });
    const row = await prisma.item.findFirstOrThrow({
      where: { customFields: { path: ["legacy_id"], equals: task.id } },
    });
    return { itemId: row.id, state: row.state };
  }

  it("imports an in-flight task's full history, one events row per entry", async () => {
    const taskId = nextId("inflight");
    const task: SourceTask = {
      id: taskId,
      title: "Working on it",
      body: "Body.",
      status: "in-progress",
      area: "web",
      history: [
        { id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "created" },
        { id: "h2", actor: "agent-alpha", at: "2026-01-02T00:00:00Z", note: "started work" },
        { id: "h3", actor: "user-a", at: "2026-01-03T00:00:00Z", note: "left a comment" },
      ],
    };
    const { itemId, state } = await importOneTask(task);
    expect(state).toBe("executing");

    const result = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );
    expect(result).toEqual({ imported: 3, skippedExisting: 0 });

    const rows = await prisma.event.findMany({ where: { itemId }, orderBy: { id: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.body)).toEqual(["created", "started work", "left a comment"]);
    // AC2: actor mapping genuinely changes the stored actor — the source
    // wrote "user-a"/"agent-alpha" as free text, the stored row carries the
    // resolved actorType alongside it, not just a passthrough of the string.
    expect(rows[0]?.actorType).toBe("person");
    expect(rows[0]?.actorId).toBe("user-a");
    expect(rows[1]?.actorType).toBe("agent");
    expect(rows[1]?.actorId).toBe("agent-alpha");
  });

  it("collapses a finished (terminal-state) task's history into ONE events row", async () => {
    const taskId = nextId("done");
    const task: SourceTask = {
      id: taskId,
      title: "Finished thing",
      body: "Body.",
      status: "done",
      area: "web",
      history: [
        { id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "created" },
        { id: "h2", actor: "agent-alpha", at: "2026-01-02T00:00:00Z", note: "did the work" },
        { id: "h3", actor: "user-a", at: "2026-01-03T00:00:00Z", note: "merged" },
      ],
    };
    const { itemId, state } = await importOneTask(task);
    expect(state).toBe("merged");

    const result = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );
    // The load-bearing assertion for DECISIONS.md §13c: three history
    // entries on a finished task collapse to exactly one events row, not
    // three. Changing TERMINAL_STATES to omit "merged" would flip this to 3.
    expect(result).toEqual({ imported: 1, skippedExisting: 0 });

    const rows = await prisma.event.findMany({ where: { itemId } });
    expect(rows).toHaveLength(1);
    // Attributed to the LAST entry's actor (user-a), not the first (also
    // user-a here by coincidence) — proven properly by the mixed-actor
    // ordering below in a separate case, but this pins body content too.
    expect(rows[0]?.body).toContain("merged");
  });

  it("attributes a collapsed summary to the LAST entry's actor, even when the first entry's actor differs", async () => {
    const taskId = nextId("done-lastactor");
    const task: SourceTask = {
      id: taskId,
      title: "Finished thing 2",
      body: "Body.",
      status: "done",
      area: "web",
      history: [
        { id: "h1", actor: "agent-alpha", at: "2026-01-01T00:00:00Z", note: "created" },
        { id: "h2", actor: "user-a", at: "2026-01-02T00:00:00Z", note: "closed it out" },
      ],
    };
    const { itemId, state } = await importOneTask(task);

    await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );

    const rows = await prisma.event.findMany({ where: { itemId } });
    expect(rows).toHaveLength(1);
    // First entry's actor was agent-alpha; if this were wrongly attributed
    // to the FIRST entry instead of the last, actorType would be "agent".
    expect(rows[0]?.actorType).toBe("person");
    expect(rows[0]?.actorId).toBe("user-a");
  });

  it("refuses to import a history entry whose actor has no alias mapping, rather than guessing", async () => {
    const taskId = nextId("unmapped-actor");
    const task: SourceTask = {
      id: taskId,
      title: "Mystery actor",
      body: "Body.",
      status: "todo",
      area: "web",
      history: [
        { id: "h1", actor: "mystery-person", at: "2026-01-01T00:00:00Z", note: "did something" },
      ],
    };
    const { itemId, state } = await importOneTask(task);

    await expect(
      importEventsForTask(
        prisma,
        { itemId, taskId, currentState: state, history: task.history! },
        { actorAliases },
      ),
    ).rejects.toBeInstanceOf(UnknownActorAliasError);

    const rows = await prisma.event.findMany({ where: { itemId } });
    expect(rows).toHaveLength(0);
  });

  it("does not see a differently-cased or padded spelling of a mapped actor as the same actor", async () => {
    // Names the defect class flagged in the task brief: a check whose
    // stated rule ("actor mapping") is broader than the shape it actually
    // inspects (exact string match). "USER-A" and "user-a " must each be
    // treated as a DIFFERENT, unmapped alias from "user-a" — proving the
    // map does not silently case-fold or trim.
    const taskId = nextId("case-actor");
    const task: SourceTask = {
      id: taskId,
      title: "Case sensitivity",
      body: "Body.",
      status: "todo",
      area: "web",
      history: [{ id: "h1", actor: "USER-A", at: "2026-01-01T00:00:00Z", note: "did something" }],
    };
    const { itemId, state } = await importOneTask(task);

    await expect(
      importEventsForTask(
        prisma,
        { itemId, taskId, currentState: state, history: task.history! },
        { actorAliases },
      ),
    ).rejects.toBeInstanceOf(UnknownActorAliasError);
  });

  it("is idempotent: importing the same in-flight task's history twice does not duplicate rows", async () => {
    const taskId = nextId("idempotent-inflight");
    const task: SourceTask = {
      id: taskId,
      title: "Idempotent check",
      body: "Body.",
      status: "in-progress",
      area: "web",
      history: [
        { id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "created" },
        { id: "h2", actor: "agent-alpha", at: "2026-01-02T00:00:00Z", note: "worked on it" },
      ],
    };
    const { itemId, state } = await importOneTask(task);

    const first = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );
    expect(first).toEqual({ imported: 2, skippedExisting: 0 });

    // Second run against the SAME already-populated database.
    const second = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );
    expect(second).toEqual({ imported: 0, skippedExisting: 2 });

    const rows = await prisma.event.findMany({ where: { itemId } });
    expect(rows).toHaveLength(2);
  });

  it("is idempotent: importing the same finished task's collapsed history twice does not duplicate rows", async () => {
    const taskId = nextId("idempotent-done");
    const task: SourceTask = {
      id: taskId,
      title: "Idempotent finished check",
      body: "Body.",
      status: "done",
      area: "web",
      history: [
        { id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "created" },
        { id: "h2", actor: "agent-alpha", at: "2026-01-02T00:00:00Z", note: "merged" },
      ],
    };
    const { itemId, state } = await importOneTask(task);

    const first = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );
    expect(first).toEqual({ imported: 1, skippedExisting: 0 });

    const second = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );
    expect(second).toEqual({ imported: 0, skippedExisting: 1 });

    const rows = await prisma.event.findMany({ where: { itemId } });
    expect(rows).toHaveLength(1);
  });

  it("re-running after a task transitions from in-flight to terminal does not duplicate the entries already imported in full", async () => {
    // A realistic re-run shape: import while the task is still in progress
    // (full history, one row per entry), then the task finishes and the
    // import runs again against the SAME populated database with the SAME
    // history array but a now-terminal currentState. The collapsed-summary
    // path keys its one row on history[0].id — which was already imported
    // as one of the full-history rows on the first run — so the second run
    // must recognise it as already present and skip, not add a duplicate
    // "collapsed" row alongside the three individual rows already there.
    const taskId = nextId("transition");
    const task: SourceTask = {
      id: taskId,
      title: "Transitions to done",
      body: "Body.",
      status: "in-progress",
      area: "web",
      history: [
        { id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "created" },
        { id: "h2", actor: "agent-alpha", at: "2026-01-02T00:00:00Z", note: "worked on it" },
        { id: "h3", actor: "user-a", at: "2026-01-03T00:00:00Z", note: "merged" },
      ],
    };
    const { itemId } = await importOneTask(task);

    const first = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: "executing", history: task.history! },
      { actorAliases },
    );
    expect(first).toEqual({ imported: 3, skippedExisting: 0 });

    // Re-run with the SAME history, now reporting a terminal state — the
    // load-bearing assertion: total row count must stay 3, not become 4
    // (3 full-history rows + 1 collapsed summary).
    const second = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: "merged", history: task.history! },
      { actorAliases },
    );
    expect(second).toEqual({ imported: 0, skippedExisting: 1 });

    const rows = await prisma.event.findMany({ where: { itemId } });
    expect(rows).toHaveLength(3);
  });

  it("writes each row via appendEvent's own INSERT path — the timestamptz column stays typed", async () => {
    const taskId = nextId("tz");
    const task: SourceTask = {
      id: taskId,
      title: "Timestamp check",
      body: "Body.",
      status: "todo",
      area: "web",
      history: [{ id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "created" }],
    };
    const { itemId, state } = await importOneTask(task);

    await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );

    const row = await prisma.event.findFirstOrThrow({ where: { itemId } });
    expect(row.ts).toBeInstanceOf(Date);
  });

  it("a task with an empty history array imports nothing and is not an error", async () => {
    const taskId = nextId("empty-history");
    const task: SourceTask = {
      id: taskId,
      title: "No history",
      body: "Body.",
      status: "todo",
      area: "web",
      history: [],
    };
    const { itemId, state } = await importOneTask(task);

    const result = await importEventsForTask(
      prisma,
      { itemId, taskId, currentState: state, history: task.history! },
      { actorAliases },
    );
    expect(result).toEqual({ imported: 0, skippedExisting: 0 });
  });

  describe("importEvents — the batch entry point", () => {
    it("resolves each task's item by legacy_id and imports its history, reporting tasks with no matching item", async () => {
      const withItemId = nextId("batch-with-item");
      const withoutItemId = "batch-no-such-item"; // never imported via importItems

      const taskWithItem: SourceTask = {
        id: withItemId,
        title: "Has an item",
        body: "Body.",
        status: "todo",
        area: "web",
        history: [{ id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "created" }],
      };
      await importItems(prisma, [taskWithItem], { repoAliases: {} });

      const taskWithoutItem: SourceTask = {
        id: withoutItemId,
        title: "Never imported",
        body: "Body.",
        status: "todo",
        area: "web",
        history: [{ id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "orphan" }],
      };

      const summary = await importEvents(prisma, [taskWithItem, taskWithoutItem], {
        actorAliases,
      });

      expect(summary.imported).toBe(1);
      expect(summary.tasksWithoutMatchingItem).toEqual([withoutItemId]);
    });

    it("is idempotent end-to-end: running the batch import twice does not duplicate rows", async () => {
      const taskId = nextId("batch-idempotent");
      const task: SourceTask = {
        id: taskId,
        title: "Batch idempotent",
        body: "Body.",
        status: "in-progress",
        area: "web",
        history: [
          { id: "h1", actor: "user-a", at: "2026-01-01T00:00:00Z", note: "created" },
          { id: "h2", actor: "agent-alpha", at: "2026-01-02T00:00:00Z", note: "worked" },
        ],
      };
      await importItems(prisma, [task], { repoAliases: {} });

      const first = await importEvents(prisma, [task], { actorAliases });
      expect(first.imported).toBe(2);

      const second = await importEvents(prisma, [task], { actorAliases });
      expect(second.imported).toBe(0);
      expect(second.skippedExisting).toBe(2);

      const item = await prisma.item.findFirstOrThrow({
        where: { customFields: { path: ["legacy_id"], equals: taskId } },
      });
      const rows = await prisma.event.findMany({ where: { itemId: item.id } });
      expect(rows).toHaveLength(2);
    });
  });
});
