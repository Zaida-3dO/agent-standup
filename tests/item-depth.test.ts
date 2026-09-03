// Depth as a stored column, and the two board filters that read it —
// `level` (tree depth) and `project` (one subtree).
//
// A real Postgres, because every claim here is about SQL: a recursive
// backfill, a recursive subtree walk, and a `depth = ANY(...)` narrowing.
// None of them can be proved against an in-memory model.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { BoardEntry, BoardOutput } from "@/lib/service/operations/get-board";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("item depth, and the board filters that read it", () => {
  const dbName = scratchDatabaseName("item_depth");
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
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(overrides: Record<string, unknown>): Promise<{ id: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "depth-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string }>;
  }

  /** The stored depth and kind of one row, read straight from the table. */
  async function rowOf(id: string): Promise<{ depth: number; kind: string }> {
    const rows = await prisma.$queryRawUnsafe<{ depth: number; kind: string }[]>(
      `SELECT "depth"::int AS "depth", "kind"::text AS "kind" FROM "Item" WHERE "id" = $1`,
      id,
    );
    return rows[0]!;
  }

  /** Every column of a board read, flattened — these cases assert membership. */
  async function boardIds(input: Record<string, unknown> = {}): Promise<Set<string>> {
    const columns = ["backlog", "in_progress", "waiting", "completed"] as const;
    const results = await Promise.all(
      columns.map(
        (column) =>
          runtime.call("get_board", { ...input, column, limit: 200 }) as Promise<BoardOutput>,
      ),
    );
    const ids = new Set<string>();
    for (const [index, column] of columns.entries()) {
      for (const entry of results[index]!.columns[column].entries as readonly BoardEntry[]) {
        ids.add(entry.item.id);
      }
    }
    return ids;
  }

  describe("depth is written on every create path", () => {
    it("gives a root project depth 0, a task 1, and nested subtasks 2 and 3", () => {
      return (async () => {
        const project = await createItem({ area: "depth-create" });
        const task = await createItem({ area: "depth-create", parentId: project.id });
        const subtask = await createItem({ area: "depth-create", parentId: task.id });
        const deeper = await createItem({ area: "depth-create", parentId: subtask.id });

        expect(await rowOf(project.id)).toEqual({ depth: 0, kind: "project" });
        expect(await rowOf(task.id)).toEqual({ depth: 1, kind: "task" });
        // **The whole reason the column exists.** These two rows sit one
        // level apart and carry the SAME `kind`, because `kindForDepth`
        // saturates at `subtask`. Depth is the only field that can tell
        // them apart, so a filter for "level 2 but not level 3" is
        // answerable from this column and from nothing else.
        expect(await rowOf(subtask.id)).toEqual({ depth: 2, kind: "subtask" });
        expect(await rowOf(deeper.id)).toEqual({ depth: 3, kind: "subtask" });
      })();
    });

    it("writes the depth the item lands at, not its parent depth", async () => {
      // The off-by-one this codebase keeps two differently-named helpers to
      // avoid: `ancestorDepthOf` returns an ancestor ROW COUNT and `depthOf`
      // returns an ABSOLUTE depth. Taking the wrong one types every created
      // item one level too shallow while `kind` stays right — which no test
      // of `kind` would catch.
      const project = await createItem({ area: "depth-offset" });
      const task = await createItem({ area: "depth-offset", parentId: project.id });
      const parentDepth = (await rowOf(project.id)).depth;
      expect((await rowOf(task.id)).depth).toBe(parentDepth + 1);
    });
  });

  describe("the backfill", () => {
    it("walks existing rows from their roots rather than defaulting them to 0", async () => {
      // The migration is the only writer that ever sees pre-existing rows,
      // so it is re-run here against a tree inserted with the column left at
      // its `DEFAULT 0` — exactly the state the ALTER TABLE leaves behind.
      //
      // Why this matters more than a normal backfill: the level filter's
      // DEFAULT is `exclude(0)`, so rows left at 0 are the ones the default
      // board HIDES. An unbackfilled store renders an empty board, not an
      // obviously broken one.
      const project = await createItem({ area: "depth-backfill" });
      const task = await createItem({ area: "depth-backfill", parentId: project.id });
      const subtask = await createItem({ area: "depth-backfill", parentId: task.id });

      await prisma.$executeRawUnsafe(`UPDATE "Item" SET "depth" = 0 WHERE "id" = ANY($1::text[])`, [
        project.id,
        task.id,
        subtask.id,
      ]);
      expect((await rowOf(subtask.id)).depth).toBe(0);

      await prisma.$executeRawUnsafe(`WITH RECURSIVE tree AS (
           SELECT "id", 0 AS "depth" FROM "Item" WHERE "parentId" IS NULL
           UNION ALL
           SELECT i."id", t."depth" + 1 FROM "Item" i JOIN tree t ON i."parentId" = t."id"
         )
         UPDATE "Item" AS i SET "depth" = t."depth" FROM tree AS t
         WHERE i."id" = t."id" AND i."depth" IS DISTINCT FROM t."depth"`);

      expect((await rowOf(project.id)).depth).toBe(0);
      expect((await rowOf(task.id)).depth).toBe(1);
      expect((await rowOf(subtask.id)).depth).toBe(2);
    });
  });

  describe("a reparent recomputes depth across the whole moved subtree", () => {
    it("re-derives the moved item and every descendant beneath it", async () => {
      const projectA = await createItem({ area: "depth-move" });
      const projectB = await createItem({ area: "depth-move" });
      const task = await createItem({ area: "depth-move", parentId: projectA.id });
      const subtask = await createItem({ area: "depth-move", parentId: task.id });

      // Move the task under a task-level parent, pushing the whole subtree
      // one level deeper.
      const taskB = await createItem({ area: "depth-move", parentId: projectB.id });
      await runtime.call("reparent_item", { id: task.id, parentId: taskB.id });

      expect(await rowOf(task.id)).toEqual({ depth: 2, kind: "subtask" });
      // The descendant is the point: skipping the walk would leave it at
      // depth 2 while it actually sits at 3, and `kind` would agree with
      // itself either way because both readings are `subtask`.
      expect((await rowOf(subtask.id)).depth).toBe(3);
    });

    it("updates a descendant whose DEPTH moves while its KIND does not", async () => {
      // The case a kind-only skip silently drops, and the reason the early
      // `continue` in `applyMove` had to grow a second condition. `kind`
      // saturates at `subtask`, so a subtree moved between two positions
      // that are both at or below level 2 changes every descendant depth and
      // no descendant kind — a kind-only check reads that as nothing to do.
      const project = await createItem({ area: "depth-kind-saturated" });
      const taskOne = await createItem({ area: "depth-kind-saturated", parentId: project.id });
      const taskTwo = await createItem({ area: "depth-kind-saturated", parentId: project.id });
      const mover = await createItem({ area: "depth-kind-saturated", parentId: taskOne.id });
      const child = await createItem({ area: "depth-kind-saturated", parentId: mover.id });

      // Both `mover` and `child` are already `subtask` and stay `subtask`.
      expect((await rowOf(mover.id)).kind).toBe("subtask");
      expect((await rowOf(child.id)).kind).toBe("subtask");
      const childDepthBefore = (await rowOf(child.id)).depth;

      // Move `mover` one level deeper: under a subtask of the other task.
      const otherSubtask = await createItem({
        area: "depth-kind-saturated",
        parentId: taskTwo.id,
      });
      await runtime.call("reparent_item", { id: mover.id, parentId: otherSubtask.id });

      expect((await rowOf(mover.id)).depth).toBe(3);
      expect((await rowOf(child.id)).depth).toBe(4);
      expect((await rowOf(child.id)).depth).not.toBe(childDepthBefore);
      // ...and the kinds genuinely did not move, which is what makes this
      // the case a kind-only check cannot see.
      expect((await rowOf(mover.id)).kind).toBe("subtask");
      expect((await rowOf(child.id)).kind).toBe("subtask");
    });

    it("records a depth field_change on the row it happened to", async () => {
      // The per-item ledger stays honest: asking "why is this at level 3
      // now" of the item it happened to has to get an answer.
      const project = await createItem({ area: "depth-events" });
      const taskOne = await createItem({ area: "depth-events", parentId: project.id });
      const taskTwo = await createItem({ area: "depth-events", parentId: project.id });
      const mover = await createItem({ area: "depth-events", parentId: taskOne.id });

      await runtime.call("reparent_item", { id: mover.id, parentId: taskTwo.id });
      // A sideways move at the same level changes nothing about depth, so
      // `recordFieldChanges` must write NO depth row — a burst of identical
      // rows on a no-op is the defect the diffing exists to prevent.
      const sideways = await prisma.$queryRawUnsafe<{ payload: unknown }[]>(
        `SELECT "payload" FROM "Event"
         WHERE "itemId" = $1 AND "type" = 'field_change' AND "payload"->>'field' = 'depth'`,
        mover.id,
      );
      expect(sideways).toHaveLength(0);

      // Now a move that DOES change depth.
      const deeper = await createItem({ area: "depth-events", parentId: taskTwo.id });
      await runtime.call("reparent_item", { id: mover.id, parentId: deeper.id });
      const rows = await prisma.$queryRawUnsafe<{ from: number; to: number }[]>(
        `SELECT ("payload"->>'from')::int AS "from", ("payload"->>'to')::int AS "to"
         FROM "Event"
         WHERE "itemId" = $1 AND "type" = 'field_change' AND "payload"->>'field' = 'depth'`,
        mover.id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ from: 2, to: 3 });
    });
  });

  describe("the level filter", () => {
    /**
     * A four-level chain in its own area: project → task → subtask →
     * deeper. Every level-filter case below reads this shape, so the
     * assertions are about which levels came back rather than about which
     * fixture was built.
     */
    async function chain(area: string) {
      const project = await createItem({ area });
      const task = await createItem({ area, parentId: project.id });
      const subtask = await createItem({ area, parentId: task.id });
      const deeper = await createItem({ area, parentId: subtask.id });
      return { project: project.id, task: task.id, subtask: subtask.id, deeper: deeper.id };
    }

    it("include(1,2) returns levels 1 and 2 and EXCLUDES the level-3 row under them", async () => {
      // The acceptance criterion, and the fixture that proves it is a real
      // depth filter rather than a subtree one: `deeper` sits directly under
      // a row the filter KEPT. A filter that kept a row because its parent
      // matched would return it, and would still pass a test whose fixture
      // was only two levels deep.
      const ids = await chain("level-include");
      const board = await boardIds({
        area: "level-include",
        level: { mode: "include", levels: [1, 2] },
      });

      expect(board.has(ids.task)).toBe(true);
      expect(board.has(ids.subtask)).toBe(true);
      expect(board.has(ids.deeper)).toBe(false);
      expect(board.has(ids.project)).toBe(false);
    });

    it("exclude(0) returns everything except the project", async () => {
      const ids = await chain("level-exclude");
      const board = await boardIds({
        area: "level-exclude",
        level: { mode: "exclude", levels: [0] },
      });

      expect(board.has(ids.project)).toBe(false);
      expect(board.has(ids.task)).toBe(true);
      expect(board.has(ids.subtask)).toBe(true);
      // The deep row is the one that separates this from `kind != project`:
      // both would keep it, but only a depth filter can then be narrowed to
      // exclude it specifically.
      expect(board.has(ids.deeper)).toBe(true);
    });

    it("include and exclude of the same level are complements, not synonyms", async () => {
      // Reading every selection as one mode would still look like a working
      // filter while showing the opposite board.
      const ids = await chain("level-modes");
      const included = await boardIds({
        area: "level-modes",
        level: { mode: "include", levels: [0] },
      });
      const excluded = await boardIds({
        area: "level-modes",
        level: { mode: "exclude", levels: [0] },
      });

      expect(included.has(ids.project)).toBe(true);
      expect(included.has(ids.task)).toBe(false);
      expect(excluded.has(ids.project)).toBe(false);
      expect(excluded.has(ids.task)).toBe(true);
    });

    it("narrows nothing when no level is named", async () => {
      // The operation has NO default of its own — the `exclude(0)` default
      // is the board UI's, applied in the URL codec. Defaulting in the
      // service would silently change what every existing caller receives
      // from a call it never changed.
      const ids = await chain("level-absent");
      const board = await boardIds({ area: "level-absent" });
      expect(board.has(ids.project)).toBe(true);
      expect(board.has(ids.task)).toBe(true);
      expect(board.has(ids.deeper)).toBe(true);
    });

    it("does NOT leak into the project subtree walk", async () => {
      // The invariant `tests/board-operations.test.ts` pins: a project's
      // derived column comes from its whole subtree regardless of the active
      // filter. Here the level filter hides the live child from the item
      // list — and the project must still derive `in_progress` from it
      // rather than reading as completed and vanishing from the board.
      const project = await createItem({ area: "level-project-walk" });
      const task = await createItem({ area: "level-project-walk", parentId: project.id });
      const subtask = await createItem({ area: "level-project-walk", parentId: task.id });
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "state" = 'merged'::"ItemState" WHERE "id" = $1`,
        task.id,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "state" = 'executing'::"ItemState" WHERE "id" = $1`,
        subtask.id,
      );

      // Levels 0 and 1 only — the EXECUTING level-2 subtask is filtered out
      // of the item list entirely.
      const results = (await runtime.call("get_board", {
        area: "level-project-walk",
        level: { mode: "include", levels: [0, 1] },
        column: "in_progress",
        limit: 200,
      })) as BoardOutput;
      const entries = results.columns.in_progress.entries as readonly BoardEntry[];
      const ids = new Set(entries.map((entry) => entry.item.id));

      expect(ids.has(subtask.id)).toBe(false);
      // ...and yet the project is still in_progress, because the walk that
      // derived its column never saw the filter.
      expect(ids.has(project.id)).toBe(true);
    });
  });

  describe("the project scope filter", () => {
    it("returns the WHOLE subtree, at every depth, not just direct children", async () => {
      // Ope's explicit choice, and the property that makes the two filters
      // compose: scope to a project, then narrow to level 1. A one-level
      // scope would make the second half of that meaningless.
      const project = await createItem({ area: "scope-subtree" });
      const task = await createItem({ area: "scope-subtree", parentId: project.id });
      const subtask = await createItem({ area: "scope-subtree", parentId: task.id });
      const deeper = await createItem({ area: "scope-subtree", parentId: subtask.id });

      const board = await boardIds({ area: "scope-subtree", project: project.id });
      expect(board.has(project.id)).toBe(true);
      expect(board.has(task.id)).toBe(true);
      expect(board.has(subtask.id)).toBe(true);
      // The grandchild is what separates a subtree walk from a `parentId`
      // equality check — the latter would return the task and stop.
      expect(board.has(deeper.id)).toBe(true);
    });

    it("excludes everything outside the named subtree", async () => {
      // Without this, a scope that silently matched everything would look
      // exactly like a working filter on a board with one project.
      const projectA = await createItem({ area: "scope-exclusion" });
      const projectB = await createItem({ area: "scope-exclusion" });
      const taskA = await createItem({ area: "scope-exclusion", parentId: projectA.id });
      const taskB = await createItem({ area: "scope-exclusion", parentId: projectB.id });

      const board = await boardIds({ area: "scope-exclusion", project: projectA.id });
      expect(board.has(taskA.id)).toBe(true);
      expect(board.has(projectB.id)).toBe(false);
      expect(board.has(taskB.id)).toBe(false);
    });

    it("composes with the level filter — one project, level 1 only", async () => {
      // The two filters together are the reader's actual question: what are
      // the tasks under this project, without the subtasks beneath them.
      const project = await createItem({ area: "scope-compose" });
      const task = await createItem({ area: "scope-compose", parentId: project.id });
      const subtask = await createItem({ area: "scope-compose", parentId: task.id });
      const otherProject = await createItem({ area: "scope-compose" });
      const otherTask = await createItem({ area: "scope-compose", parentId: otherProject.id });

      const board = await boardIds({
        area: "scope-compose",
        project: project.id,
        level: { mode: "include", levels: [1] },
      });
      expect(board.has(task.id)).toBe(true);
      expect(board.has(project.id)).toBe(false);
      expect(board.has(subtask.id)).toBe(false);
      // The other project's level-1 task is excluded by the SCOPE, which is
      // what proves the two conditions are ANDed rather than one winning.
      expect(board.has(otherTask.id)).toBe(false);
    });

    it("matches nothing but itself when the id names no subtree", async () => {
      // A stale bookmark renders an empty board the reader can see and
      // correct, never a 400 they cannot.
      const project = await createItem({ area: "scope-missing" });
      await createItem({ area: "scope-missing", parentId: project.id });
      const board = await boardIds({ area: "scope-missing", project: "no-such-item" });
      expect(board.size).toBe(0);
    });

    it("leaves the counts drawn from the same predicate as the page", async () => {
      // The scope is a `shared` condition, so the per-column COUNT(*) and
      // the page are drawn from one predicate. A condition appended AFTER
      // the `statesParam` freeze would bind the wrong parameter and make
      // these disagree.
      const project = await createItem({ area: "scope-counts" });
      await createItem({ area: "scope-counts", parentId: project.id });
      await createItem({ area: "scope-counts", parentId: project.id });
      const outside = await createItem({ area: "scope-counts" });
      await createItem({ area: "scope-counts", parentId: outside.id });

      const scoped = (await runtime.call("get_board", {
        area: "scope-counts",
        project: project.id,
        level: { mode: "exclude", levels: [0] },
        column: "backlog",
        limit: 200,
      })) as BoardOutput;
      const entries = scoped.columns.backlog.entries as readonly BoardEntry[];
      expect(scoped.columns.backlog.total).toBe(entries.length);
      expect(entries).toHaveLength(2);
    });
  });
});
