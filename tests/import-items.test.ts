// Real Postgres only, per CLAUDE.md's testing tenet. See tests/repos.test.ts
// for the scratch-database setup this mirrors. Skips without TEST_DATABASE_URL.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRepo } from "@/lib/repos";
import {
  importItems,
  mapSourceStatus,
  readSourceTasks,
  STATUS_REMAP,
  UnknownRepoAliasError,
  UnknownSourceStatusError,
  type SourceTask,
} from "@/lib/import-items";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

describe("mapSourceStatus", () => {
  it("maps a source status that passes through to a differently-named state", () => {
    // "done" in the source vocabulary is a completed state, but not the
    // SAME word as the items.state value it lands on — proves this is a
    // real remap table, not an identity function, and the two most
    // differently-shaped states in the vocabulary are covered.
    expect(mapSourceStatus("done", "t1")).toBe("merged");
  });

  it("maps a source status that has no direct equivalent onto the closest items.state", () => {
    // The source's single waiting status has no "blocked" equivalent — it
    // remaps to "paused", not "blocked". Changing STATUS_REMAP.waiting to
    // "blocked" would flip this assertion, which is exactly the case this
    // test exists to pin.
    expect(mapSourceStatus("waiting", "t1")).toBe("paused");
  });

  it("maps every other source status to its documented items.state", () => {
    expect(mapSourceStatus("todo", "t1")).toBe("on_deck");
    expect(mapSourceStatus("in-progress", "t1")).toBe("executing");
    expect(mapSourceStatus("review", "t1")).toBe("in_review");
  });

  it("rejects a status outside the source vocabulary rather than defaulting silently", () => {
    expect(() => mapSourceStatus("archived", "t1")).toThrow(UnknownSourceStatusError);
  });

  it("lets a CALLER-SUPPLIED alias resolve a status this application has never heard of", () => {
    // The property that makes the importer generic: a source's own state
    // machine is translated by the caller, not by a table inside the app.
    expect(mapSourceStatus("awaiting-sign-off", "t1", { "awaiting-sign-off": "paused" })).toBe(
      "paused",
    );
  });

  it("lets a caller-supplied alias OVERRIDE this application's own vocabulary", () => {
    // Deliberate precedence: the caller knows both vocabularies, the app
    // knows only its own. Swapping the `??` operands in mapSourceStatus
    // would flip this.
    expect(mapSourceStatus("done", "t1", { done: "wont_do" })).toBe("wont_do");
    expect(mapSourceStatus("done", "t1")).toBe("merged");
  });

  it("still REFUSES a status in neither the caller's map nor the app's", () => {
    expect(() => mapSourceStatus("archived", "t1", { other: "paused" })).toThrow(
      UnknownSourceStatusError,
    );
  });
});

describe("the application's own status vocabulary", () => {
  it("stays exactly five words — it defines a surface vocabulary, not just a mapping", () => {
    // task-shim/contract.ts's SHIM_STATUSES is asserted equal to these
    // keys. Growing this table to cover a particular source's state machine
    // would widen a command-line surface as a side effect, and would put
    // one external system's private vocabulary in a public application.
    expect(Object.keys(STATUS_REMAP)).toHaveLength(5);
    expect(Object.keys(STATUS_REMAP).sort()).toEqual([
      "done",
      "in-progress",
      "review",
      "todo",
      "waiting",
    ]);
  });
});

describe("readSourceTasks", () => {
  let sourceDir: string;

  afterEach(async () => {
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
  });

  it("reads one task.json per task directory", async () => {
    sourceDir = await mkdtemp(path.join(tmpdir(), "standup-import-"));
    await mkdir(path.join(sourceDir, "task-a"));
    await writeFile(
      path.join(sourceDir, "task-a", "task.json"),
      JSON.stringify({ id: "task-a", title: "A", body: "body a", status: "todo", area: "web" }),
    );
    await mkdir(path.join(sourceDir, "task-b"));
    await writeFile(
      path.join(sourceDir, "task-b", "task.json"),
      JSON.stringify({ id: "task-b", title: "B", body: "body b", status: "done", area: "infra" }),
    );

    const tasks = await readSourceTasks(sourceDir);
    expect(tasks.map((t) => t.id).sort()).toEqual(["task-a", "task-b"]);
  });

  it("skips a subdirectory with no task.json rather than throwing", async () => {
    sourceDir = await mkdtemp(path.join(tmpdir(), "standup-import-"));
    await mkdir(path.join(sourceDir, "not-a-task"));
    await writeFile(path.join(sourceDir, "not-a-task", "notes.txt"), "stray file");
    await mkdir(path.join(sourceDir, "task-a"));
    await writeFile(
      path.join(sourceDir, "task-a", "task.json"),
      JSON.stringify({ id: "task-a", title: "A", body: "body a", status: "todo", area: "web" }),
    );

    const tasks = await readSourceTasks(sourceDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("task-a");
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("importItems — against a real Postgres", () => {
  const dbName = scratchDatabaseName("import_items");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await createRepo(prisma, { id: "web", displayName: "Web", defaultBranch: "main" });
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  const baseTask: SourceTask = {
    id: "src-1",
    title: "Fix the thing",
    body: "Details here.",
    status: "todo",
    area: "Web",
    repo: "web-app",
  };

  it("imports a task, remapping status, preserving the source id, and resolving area via ensureArea", async () => {
    const result = await importItems(prisma, [baseTask], { repoAliases: { "web-app": "web" } });
    expect(result).toEqual({ imported: 1, skippedExisting: 0 });

    const row = await prisma.item.findFirstOrThrow({
      where: { customFields: { path: ["legacy_id"], equals: "src-1" } },
    });
    expect(row.state).toBe("on_deck");
    expect(row.originType).toBe("source");
    expect(row.mergeAuthority).toBe("needs_approval");
    expect(row.area).toBe("web");
    expect(row.repo).toBe("web");
    // The source id must be readable back out of custom_fields exactly —
    // this is the field idempotency and any future events/assignments
    // importer (#11/#12) key their own lookups against.
    expect(row.customFields).toEqual({ legacy_id: "src-1" });
  });

  it("resolves two different source repo aliases of the SAME repository onto one row, never inserting them as distinct repos", async () => {
    const tasks: SourceTask[] = [
      { ...baseTask, id: "alias-1", repo: "web-app" },
      { ...baseTask, id: "alias-2", repo: "webapp-legacy" },
    ];

    const before = await prisma.repo.count();

    await importItems(prisma, tasks, {
      repoAliases: { "web-app": "web", "webapp-legacy": "web" },
    });

    const after = await prisma.repo.count();
    // The load-bearing assertion: two DIFFERENT source spellings imported
    // one repo row apiece would grow this count by 2 (or by 1 if the second
    // alias were wrongly treated as new). It must not grow at all — both
    // resolve onto the pre-existing "web" row.
    expect(after).toBe(before);

    const item1 = await prisma.item.findFirstOrThrow({
      where: { customFields: { path: ["legacy_id"], equals: "alias-1" } },
    });
    const item2 = await prisma.item.findFirstOrThrow({
      where: { customFields: { path: ["legacy_id"], equals: "alias-2" } },
    });
    expect(item1.repo).toBe("web");
    expect(item2.repo).toBe("web");
  });

  it("refuses to import a task whose repo has no alias mapping, rather than inventing a repo or dropping the field", async () => {
    const task: SourceTask = { ...baseTask, id: "unmapped-repo", repo: "mystery-repo" };

    await expect(importItems(prisma, [task], { repoAliases: {} })).rejects.toBeInstanceOf(
      UnknownRepoAliasError,
    );

    expect(await prisma.repo.findUnique({ where: { id: "mystery-repo" } })).toBeNull();
    const item = await prisma.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: "unmapped-repo" } },
    });
    expect(item).toBeNull();
  });

  it("imports a task with no repo at all (non-code work) leaving items.repo null", async () => {
    const task: SourceTask = {
      id: "no-repo",
      title: "Research something",
      body: "Not code.",
      status: "todo",
      area: "research",
    };

    await importItems(prisma, [task], { repoAliases: {} });

    const row = await prisma.item.findFirstOrThrow({
      where: { customFields: { path: ["legacy_id"], equals: "no-repo" } },
    });
    expect(row.repo).toBeNull();
    expect(row.area).toBe("research");
  });

  it("is idempotent: running the same import twice against the same populated database does not duplicate rows", async () => {
    const task: SourceTask = { ...baseTask, id: "idempotent-1" };

    const first = await importItems(prisma, [task], { repoAliases: { "web-app": "web" } });
    expect(first).toEqual({ imported: 1, skippedExisting: 0 });

    // Second run against the SAME already-populated database, not a fresh
    // one — this is the run that actually exercises the dedup check.
    const second = await importItems(prisma, [task], { repoAliases: { "web-app": "web" } });
    expect(second).toEqual({ imported: 0, skippedExisting: 1 });

    const rows = await prisma.item.findMany({
      where: { customFields: { path: ["legacy_id"], equals: "idempotent-1" } },
    });
    expect(rows).toHaveLength(1);
  });

  // The MEDIUM-1 regression: `importItems` writes `Item.area` directly (it
  // must — the column is NOT NULL and no `ItemArea` row can reference an
  // item that doesn't exist yet), and used to stop there. An item with
  // `Item.area` set but zero `ItemArea` rows reads back with the right
  // `area` on the item record itself (the `COALESCE`/`?? [row.area]`
  // fallbacks paper over exactly that gap) while being genuinely invisible
  // to `areaFilterCondition`, which deliberately reads ONLY `ItemArea`. So
  // asserting `row.area` alone — as the tests above already do — would NOT
  // have caught this; the assertion has to go through the filter.
  it("writes an ItemArea row for an imported task, so it is findable by area filter — not just readable on the row", async () => {
    const task: SourceTask = { ...baseTask, id: "area-join-1", area: "imported-area" };

    await importItems(prisma, [task], { repoAliases: { "web-app": "web" } });

    const item = await prisma.item.findFirstOrThrow({
      where: { customFields: { path: ["legacy_id"], equals: "area-join-1" } },
    });

    // Fails if the `$executeRawUnsafe` INSERT into "ItemArea" is removed
    // from `importItems`: the row would exist with no linked area at all.
    const linked = await prisma.$queryRawUnsafe<{ areaId: string }[]>(
      `SELECT "areaId" FROM "ItemArea" WHERE "itemId" = $1`,
      item.id,
    );
    expect(linked.map((row) => row.areaId)).toEqual(["imported-area"]);

    // The load-bearing assertion. `areaFilterCondition` (area-filter.ts)
    // reads only "ItemArea", so this is the check that actually exercises
    // the drift the one-writer invariant exists to prevent — a row missing
    // from "ItemArea" fails HERE even though `item.area` above is correct.
    const matches = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "i"."id" FROM "Item" "i"
       WHERE EXISTS (
         SELECT 1 FROM "ItemArea" "ia"
         WHERE "ia"."itemId" = "i"."id" AND "ia"."areaId" = $1
       )`,
      "imported-area",
    );
    expect(matches.map((row) => row.id)).toContain(item.id);
  });
});
