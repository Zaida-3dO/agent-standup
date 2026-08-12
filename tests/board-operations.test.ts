// `get_board` against a real Postgres — SCHEMA.md §19 (`GET /board`), §1.1
// (columns), DECISIONS.md §13c (projects derive their column from
// children). Same shape as tests/items-operations.test.ts: a real database
// is needed because the column derivation runs a recursive query that an
// in-memory model of Postgres cannot prove.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { BoardOutput } from "@/lib/service/operations/get-board";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_board against Postgres", () => {
  const dbName = scratchDatabaseName("board_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(
    overrides: Record<string, unknown>,
  ): Promise<{ id: string; state: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "board-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string; state: string }>;
  }

  async function setState(id: string, state: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = $1::"ItemState" WHERE "id" = $2`,
      state,
      id,
    );
  }

  describe("column grouping — tasks and subtasks (real, stored state)", () => {
    it("places a task in backlog when its state is on_deck (default at creation)", async () => {
      const project = await createItem({ area: "board-grouping" });
      const task = await createItem({ area: "board-grouping", parentId: project.id });
      expect(task.state).toBe("on_deck");

      const board = (await runtime.call("get_board", { area: "board-grouping" })) as BoardOutput;
      expect(board.backlog.some((entry) => entry.item.id === task.id)).toBe(true);
    });

    it("places a task in in_progress when executing, and NOT in any other column", async () => {
      const project = await createItem({ area: "board-in-progress" });
      const task = await createItem({ area: "board-in-progress", parentId: project.id });
      await setState(task.id, "executing");

      const board = (await runtime.call("get_board", {
        area: "board-in-progress",
      })) as BoardOutput;
      expect(board.in_progress.some((entry) => entry.item.id === task.id)).toBe(true);
      // Genuine exclusion, not just "also present": a task must appear in
      // exactly one column, never leak into the others.
      expect(board.backlog.some((entry) => entry.item.id === task.id)).toBe(false);
      expect(board.waiting.some((entry) => entry.item.id === task.id)).toBe(false);
      expect(board.completed.some((entry) => entry.item.id === task.id)).toBe(false);
    });

    it("places paused AND blocked tasks in the same waiting column (SCHEMA.md §1.1)", async () => {
      const project = await createItem({ area: "board-waiting" });
      const pausedTask = await createItem({ area: "board-waiting", parentId: project.id });
      await setState(pausedTask.id, "paused");
      const blockedTask = await createItem({ area: "board-waiting", parentId: project.id });
      await setState(blockedTask.id, "blocked");

      const board = (await runtime.call("get_board", { area: "board-waiting" })) as BoardOutput;
      const waitingIds = board.waiting.map((entry) => entry.item.id);
      expect(waitingIds).toContain(pausedTask.id);
      expect(waitingIds).toContain(blockedTask.id);
    });

    it("places a merged task in completed", async () => {
      const project = await createItem({ area: "board-completed" });
      const task = await createItem({ area: "board-completed", parentId: project.id });
      await setState(task.id, "merged");

      const board = (await runtime.call("get_board", { area: "board-completed" })) as BoardOutput;
      expect(board.completed.some((entry) => entry.item.id === task.id)).toBe(true);
    });
  });

  describe("projects — DECISIONS.md §13c: derived from children, never items.state", () => {
    it("an empty project (no children) reads as backlog", async () => {
      const project = await createItem({ area: "board-project-empty" });
      const board = (await runtime.call("get_board", {
        area: "board-project-empty",
      })) as BoardOutput;
      expect(board.backlog.some((entry) => entry.item.id === project.id)).toBe(true);
    });

    it("a project with one executing task reads as in_progress, not the stored on_deck default", async () => {
      const project = await createItem({ area: "board-project-live" });
      expect(project.state).toBe("on_deck"); // the stored default — must NOT be what the board reads
      const task = await createItem({ area: "board-project-live", parentId: project.id });
      await setState(task.id, "executing");

      const board = (await runtime.call("get_board", {
        area: "board-project-live",
      })) as BoardOutput;
      expect(board.in_progress.some((entry) => entry.item.id === project.id)).toBe(true);
      // The genuine-exclusion half: reading items.state directly (on_deck)
      // would wrongly place it in backlog instead — prove it is NOT there.
      expect(board.backlog.some((entry) => entry.item.id === project.id)).toBe(false);
    });

    it("a project reads as completed only once EVERY child is completed — one live child keeps it off completed", async () => {
      const project = await createItem({ area: "board-project-mixed" });
      const done = await createItem({ area: "board-project-mixed", parentId: project.id });
      await setState(done.id, "merged");
      const live = await createItem({ area: "board-project-mixed", parentId: project.id });
      await setState(live.id, "planning");

      const board = (await runtime.call("get_board", {
        area: "board-project-mixed",
      })) as BoardOutput;
      expect(board.completed.some((entry) => entry.item.id === project.id)).toBe(false);
      expect(board.in_progress.some((entry) => entry.item.id === project.id)).toBe(true);
    });

    it("a project reads as completed once all children finish", async () => {
      const project = await createItem({ area: "board-project-done" });
      const a = await createItem({ area: "board-project-done", parentId: project.id });
      await setState(a.id, "merged");
      const b = await createItem({ area: "board-project-done", parentId: project.id });
      await setState(b.id, "wont_do");

      const board = (await runtime.call("get_board", {
        area: "board-project-done",
      })) as BoardOutput;
      expect(board.completed.some((entry) => entry.item.id === project.id)).toBe(true);
    });

    it("a live GRANDCHILD (subtask, two levels down) still pulls the project out of completed — the whole subtree, not one level", async () => {
      const project = await createItem({ area: "board-project-grandchild" });
      const task = await createItem({ area: "board-project-grandchild", parentId: project.id });
      await setState(task.id, "merged");
      const subtask = await createItem({
        area: "board-project-grandchild",
        parentId: task.id,
      });
      await setState(subtask.id, "executing");

      const board = (await runtime.call("get_board", {
        area: "board-project-grandchild",
      })) as BoardOutput;
      // If the query only looked one level down (direct children of the
      // project), it would see only the merged task and misreport
      // completed — this is the exact off-by-one this test guards against.
      expect(board.completed.some((entry) => entry.item.id === project.id)).toBe(false);
      expect(board.in_progress.some((entry) => entry.item.id === project.id)).toBe(true);
    });

    it("a project's column is unaffected by a filter that would otherwise exclude its live child from the item list", async () => {
      // Filtering the board by priority=P0 must not blind the project's
      // OWN column derivation to a P2 live child that the filter hid from
      // the returned item list — the descendant-state query is
      // deliberately unfiltered so a project's column reflects real work
      // regardless of which filter the caller applied.
      const project = await createItem({ area: "board-project-filtered", priority: "P0" });
      const child = await createItem({
        area: "board-project-filtered",
        parentId: project.id,
        priority: "P2",
      });
      await setState(child.id, "executing");

      const board = (await runtime.call("get_board", {
        area: "board-project-filtered",
        priority: "P0",
      })) as BoardOutput;
      // The child (P2) is excluded from every column's item list...
      const anyColumnHasChild = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].some((entry) => entry.item.id === child.id);
      expect(anyColumnHasChild).toBe(false);
      // ...but the project (P0, kept by the filter) still derives its
      // column from that live child, landing in in_progress rather than
      // the empty-project default of backlog.
      expect(board.in_progress.some((entry) => entry.item.id === project.id)).toBe(true);
      expect(board.backlog.some((entry) => entry.item.id === project.id)).toBe(false);
    });
  });

  describe("filters", () => {
    it("a filter genuinely EXCLUDES: priority=P0 excludes a P3 item that would otherwise appear", async () => {
      const p0 = await createItem({ area: "board-filter-priority", priority: "P0" });
      await createItem({ area: "board-filter-priority", priority: "P3" });

      const board = (await runtime.call("get_board", {
        area: "board-filter-priority",
        priority: "P0",
      })) as BoardOutput;
      const allIds = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].map((entry) => entry.item.id);
      expect(allIds).toEqual([p0.id]);
    });

    it("area filter excludes items in a different area", async () => {
      const inArea = await createItem({ area: "board-filter-area-a" });
      await createItem({ area: "board-filter-area-b" });

      const board = (await runtime.call("get_board", {
        area: "board-filter-area-a",
      })) as BoardOutput;
      const allIds = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].map((entry) => entry.item.id);
      expect(allIds).toEqual([inArea.id]);
    });

    it("kind=project excludes tasks and subtasks", async () => {
      const project = await createItem({ area: "board-filter-kind" });
      await createItem({ area: "board-filter-kind", parentId: project.id });

      const board = (await runtime.call("get_board", {
        area: "board-filter-kind",
        kind: "project",
      })) as BoardOutput;
      const allIds = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].map((entry) => entry.item.id);
      expect(allIds).toEqual([project.id]);
    });

    it("empty result when the filter matches nothing — every column present but empty", async () => {
      const board = (await runtime.call("get_board", {
        area: "an-area-nothing-uses",
      })) as BoardOutput;
      expect(board.backlog).toEqual([]);
      expect(board.in_progress).toEqual([]);
      expect(board.waiting).toEqual([]);
      expect(board.completed).toEqual([]);
    });
  });
});
