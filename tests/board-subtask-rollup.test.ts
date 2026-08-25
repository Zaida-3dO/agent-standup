// `BoardEntry.subtasks` against a real Postgres — the count a card shows
// for the work it holds instead of showing that work as peer cards.
//
// A real database rather than a model of one, for the same reason
// tests/board-operations.test.ts gives: the rollup is a `WITH RECURSIVE`
// statement, and the defects it can have are defects in how Postgres walks
// a tree. An in-memory stand-in would be asserting against a second
// implementation of the thing under test.
//
// ── Why every archive case here is THREE levels deep ────────────────────
//
// The archive predicate sits on both arms of the recursion, and each arm is
// the only one that can reach a different row:
//
//   - The **seed** arm (`"parentId" = ANY($1)`) is the only thing that
//     reaches an archived **direct child**.
//   - The **recursive** arm (the `UNION ALL` half) is the only thing that
//     reaches an archived **grandchild under a live child** — the seed
//     never sees that row at all.
//
// A two-level fixture cannot tell the two apart. `get_projects` learned
// this the expensive way one level up: its "both arms" claim was true in
// code but only half-tested, and deleting the recursive arm's predicate
// survived all thirty-seven of that file's archive tests, because the
// fixture never went deeper than a direct child. So each arm below gets its
// own named case, and the fixtures reach three levels — the depth at which
// the recursion has to actually run through a LIVE parent for its filter to
// be the thing doing the work.
//
// The two cases are named so a failure says which arm broke:
//
//   - "does not count an archived direct child"      → the SEED arm
//   - "does not count an archived grandchild under a live child"
//                                                    → the RECURSIVE arm
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { BoardOutput, BoardEntry } from "@/lib/service/operations/get-board";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** `delete_item` refuses a throwaway reason, so every archive here gives a real one. */
const ARCHIVE_REASON = "raised twice by the same import sweep, this copy is the duplicate";

describeIfDb("a board card counts the work beneath it", () => {
  const dbName = scratchDatabaseName("subtask_rollup");
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
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(overrides: Record<string, unknown>): Promise<{ id: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string }>;
  }

  async function setState(id: string, state: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = $1::"ItemState" WHERE "id" = $2`,
      state,
      id,
    );
  }

  /**
   * Every entry in one area across all four columns, keyed by item id.
   *
   * All four columns because these cases move fixtures into terminal states
   * to exercise the `done` count, and a card whose own state is `merged`
   * sits in `completed` — looking in one column only would make a case pass
   * by not finding the row it meant to assert about.
   *
   * `includeTerminal` and a generous `limit` for the same reason: a case
   * that asserts a count must not silently assert about an absent card.
   *
   * **No `level` is passed.** `get_board` defaults nothing (the board's
   * `include(1)` default lives in the URL codec), so an unnarrowed read is
   * what these cases want — a subtask's own card has a rollup too, and
   * every fixture below is asserted about directly.
   */
  async function entriesByArea(area: string): Promise<Map<string, BoardEntry>> {
    const columns = ["backlog", "in_progress", "waiting", "completed"] as const;
    const results = await Promise.all(
      columns.map(
        (column) =>
          runtime.call("get_board", {
            area,
            column,
            limit: 200,
            includeTerminal: true,
          }) as Promise<BoardOutput>,
      ),
    );
    const byId = new Map<string, BoardEntry>();
    for (const [index, column] of columns.entries()) {
      for (const entry of results[index]!.columns[column].entries) {
        byId.set(entry.item.id, entry);
      }
    }
    return byId;
  }

  /**
   * A three-level chain: project → task → subtask → grandchild.
   *
   * Four levels of row so that the *task* card — the one the default board
   * shows — has both a direct child and a grandchild beneath it, which is
   * what makes the two archive arms separable from that card's point of
   * view.
   */
  async function chain(area: string) {
    const project = await createItem({ area, title: "Project" });
    const task = await createItem({ area, title: "Task", parentId: project.id });
    const subtask = await createItem({ area, title: "Subtask", parentId: task.id });
    const grandchild = await createItem({ area, title: "Grandchild", parentId: subtask.id });
    return { project: project.id, task: task.id, subtask: subtask.id, grandchild: grandchild.id };
  }

  describe("the count itself", () => {
    it("counts every descendant at any depth, not just direct children", async () => {
      // The whole reason this is a recursive walk. A `GROUP BY "parentId"`
      // would report the task as holding 1, which is the number that makes
      // a card lie about what it is hiding: the board shows level 1, so the
      // grandchild is hidden by this card and has to be counted by it.
      const ids = await chain("rollup-depth");
      const entries = await entriesByArea("rollup-depth");

      expect(entries.get(ids.task)?.subtasks).toEqual({ total: 2, done: 0 });
      // And each level below reports its own subtree, so the number is
      // "beneath THIS card" rather than "beneath the top of the tree".
      expect(entries.get(ids.subtask)?.subtasks).toEqual({ total: 1, done: 0 });
      // A project's card counts its whole subtree too — three rows under it.
      expect(entries.get(ids.project)?.subtasks).toEqual({ total: 3, done: 0 });
    });

    it("reports null rather than zero for a card with nothing beneath it", async () => {
      // `null` and `{total: 0}` are different claims: one says there is no
      // work under this card, the other says there is work and none of it
      // has moved. A card rendering "0 subtasks · 0 done" would be a
      // sentence about work that does not exist.
      //
      // Fails if the `?? null` in get-board.ts becomes `?? {total: 0, done:
      // 0}`, or if the query starts emitting a zero row per childless card.
      const ids = await chain("rollup-childless");
      const entries = await entriesByArea("rollup-childless");

      expect(entries.get(ids.grandchild)?.subtasks).toBeNull();
    });

    it("counts a descendant as done when its work is over, whatever ended it", async () => {
      // `done` is the completed column's four states, not `merged` alone.
      // A card whose remaining children were all cancelled has nothing left
      // under it, and counting only merged rows would leave it reading
      // "2 subtasks · 0 done" permanently with nothing anyone could do.
      //
      // Fails if `DONE_STATES_SQL` is narrowed to `merged`: `done` drops to
      // 1 while `total` stays 2.
      const ids = await chain("rollup-done");
      await setState(ids.subtask, "merged");
      await setState(ids.grandchild, "cancelled");

      const entries = await entriesByArea("rollup-done");
      expect(entries.get(ids.task)?.subtasks).toEqual({ total: 2, done: 2 });
    });

    it("counts an unfinished descendant as not done", async () => {
      // The other half of the case above — without this, a `done` that
      // simply returned `total` would pass every assertion there.
      const ids = await chain("rollup-partial");
      await setState(ids.subtask, "merged");
      await setState(ids.grandchild, "executing");

      const entries = await entriesByArea("rollup-partial");
      expect(entries.get(ids.task)?.subtasks).toEqual({ total: 2, done: 1 });
    });
  });

  describe("archived descendants do not inflate the count", () => {
    it("does not count an archived direct child", async () => {
      // **The SEED arm.** The archived row is a direct child of the card
      // being asserted about, so it is reached by `"parentId" = ANY($1)`
      // and never by the recursion. Dropping `AND i."archivedAt" IS NULL`
      // from the seed arm alone leaves this at 2.
      //
      // Archiving the subtask also archives the grandchild beneath it —
      // `delete_item` cascades — which is why the expectation is `null`
      // (nothing live left under the task) rather than 1.
      const ids = await chain("rollup-archive-seed");
      const before = await entriesByArea("rollup-archive-seed");
      expect(before.get(ids.task)?.subtasks).toEqual({ total: 2, done: 0 });

      await runtime.call("delete_item", {
        id: ids.subtask,
        reason: ARCHIVE_REASON,
        acknowledgeReferences: true,
      });

      const after = await entriesByArea("rollup-archive-seed");
      expect(after.get(ids.task)?.subtasks).toBeNull();
    });

    it("does not count an archived grandchild under a live child", async () => {
      // **The RECURSIVE arm**, and the case a two-level fixture cannot
      // reach. The archived row is two levels below the card asserted
      // about, with a LIVE row in between, so the seed never sees it and
      // only the `UNION ALL` half's `AND i."archivedAt" IS NULL` can
      // exclude it. Dropping that predicate alone leaves this at 2 — and
      // every other case in this file still passes, which is exactly the
      // half-tested state `get_projects` was found in.
      const ids = await chain("rollup-archive-recursive");
      const before = await entriesByArea("rollup-archive-recursive");
      expect(before.get(ids.task)?.subtasks).toEqual({ total: 2, done: 0 });

      await runtime.call("delete_item", {
        id: ids.grandchild,
        reason: ARCHIVE_REASON,
      });

      const after = await entriesByArea("rollup-archive-recursive");
      // The live child still counts; only the archived grandchild drops.
      expect(after.get(ids.task)?.subtasks).toEqual({ total: 1, done: 0 });
      // ...and the live child in between now has nothing under it, which is
      // `null` rather than a zeroed rollup.
      expect(after.get(ids.subtask)?.subtasks).toBeNull();
    });
  });

  describe("the rollup is one query for the whole page, not one per card", () => {
    it("issues the same number of statements for many cards as for one", async () => {
      // The N+1 that AC 3 forbids, asserted as a fact about the query count
      // rather than as a comment. A per-card walk would grow this list with
      // the number of cards; one statement for the whole response does not.
      //
      // Fails if `SUBTASK_ROLLUP_SQL` is ever moved inside the entry loop:
      // the two counts diverge immediately.
      //
      // It matches on `rollup_subtree`, the CTE name unique to this
      // statement. `get_board` runs a SECOND recursive walk to derive a
      // project's column whose CTE is called `subtree`, so a looser match
      // on "WITH RECURSIVE subtree" counts both and reports 2 for a single
      // rollup — a probe that fails while the code is correct.
      async function countRollupStatements(area: string): Promise<number> {
        let seen = 0;
        const listener = (event: { query: string }) => {
          if (event.query.includes("rollup_subtree")) seen++;
        };
        const logged = new PrismaClient({
          datasourceUrl: scratchUrl,
          log: [{ emit: "event", level: "query" }],
        });
        logged.$on("query", listener);
        const loggedRuntime = new ServiceRuntime({
          transaction: prismaTransactionRunner(logged),
          resolveSnapshot: async () => defaultSnapshot(),
        });
        await loggedRuntime.call("get_board", {
          area,
          column: "backlog",
          limit: 200,
        });
        await logged.$disconnect();
        return seen;
      }

      // One card with children...
      await chain("rollup-n1-small");
      const small = await countRollupStatements("rollup-n1-small");

      // ...against six, each with their own subtree.
      for (let index = 0; index < 6; index++) {
        await chain("rollup-n1-large");
      }
      const large = await countRollupStatements("rollup-n1-large");

      expect(small).toBe(1);
      expect(large).toBe(1);
    });
  });
});
