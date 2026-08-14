// `get_item_detail` against a real Postgres — MILESTONES.md #72.
//
// A real database is needed because the subtask tree is a recursive query
// whose depth-first ordering and unbounded nesting an in-memory model of
// Postgres cannot prove, and because artifacts, events and summaries are
// read from three tables this operation joins nothing across — the shapes
// only exist once rows do. Same harness as tests/board-operations.test.ts.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { columnForSubtree, type ItemDetailOutput } from "@/lib/service/operations/get-item-detail";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// `columnForSubtree` is pure, so it is provable without a database — and it
// is the rule that decides where a project sits, which is the one thing on
// this screen a client cannot recompute. Kept outside the DB block so it
// runs everywhere.
describe("columnForSubtree", () => {
  it("is in_progress if ANYTHING is moving, whatever else is there", () => {
    expect(columnForSubtree(["merged", "blocked", "executing"])).toBe("in_progress");
    expect(columnForSubtree(["planning"])).toBe("in_progress");
  });

  it("is waiting when something is parked and nothing is moving", () => {
    expect(columnForSubtree(["merged", "paused"])).toBe("waiting");
    expect(columnForSubtree(["blocked", "on_deck"])).toBe("waiting");
  });

  it("is backlog when the only unfinished work is unstarted", () => {
    expect(columnForSubtree(["merged", "on_deck"])).toBe("backlog");
    expect(columnForSubtree(["someday"])).toBe("backlog");
  });

  it("is completed only when every child is finished", () => {
    expect(columnForSubtree(["merged", "wont_do", "cancelled", "research_done"])).toBe("completed");
  });

  it("is backlog, not completed, for a project with no children at all", () => {
    // An empty project is work that exists and has not started. Reporting
    // it as completed would mark unstarted work done, which is the more
    // dangerous direction of this ambiguity.
    expect(columnForSubtree([])).toBe("backlog");
  });
});

describeIfDb("get_item_detail against Postgres", () => {
  const dbName = scratchDatabaseName("item_detail");
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

  async function createItem(
    overrides: Record<string, unknown>,
  ): Promise<{ id: string; state: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "detail-tests",
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

  async function detailOf(id: string, input: Record<string, unknown> = {}) {
    return (await runtime.call("get_item_detail", { id, ...input })) as ItemDetailOutput;
  }

  describe("the item itself", () => {
    it("refuses an id that does not exist rather than returning an empty detail", async () => {
      await expect(detailOf("no-such-item")).rejects.toThrow(/No such item/);
    });

    it("returns the item it was asked for", async () => {
      const project = await createItem({ area: "detail-item" });
      const task = await createItem({
        area: "detail-item",
        parentId: project.id,
        title: "The task",
      });
      const detail = await detailOf(task.id);
      expect(detail.item.id).toBe(task.id);
      expect(detail.item.title).toBe("The task");
    });
  });

  describe("the subtask tree", () => {
    it("is empty for a leaf, and the root is never in its own tree", async () => {
      const project = await createItem({ area: "detail-leaf" });
      const task = await createItem({ area: "detail-leaf", parentId: project.id });
      const detail = await detailOf(task.id);
      expect(detail.subtasks).toEqual([]);
    });

    it("walks the WHOLE subtree, not just direct children", async () => {
      // The behaviour that distinguishes this operation from `orientation`,
      // which reads one level. Nesting is unbounded (SCHEMA.md §1), so a
      // grandchild must appear.
      const project = await createItem({ area: "detail-deep" });
      const child = await createItem({
        area: "detail-deep",
        parentId: project.id,
        title: "child",
      });
      const grandchild = await createItem({
        area: "detail-deep",
        parentId: child.id,
        title: "grandchild",
      });
      const greatGrandchild = await createItem({
        area: "detail-deep",
        parentId: grandchild.id,
        title: "great-grandchild",
      });

      const detail = await detailOf(project.id);
      const ids = detail.subtasks.map((s) => s.id);
      expect(ids).toContain(child.id);
      expect(ids).toContain(grandchild.id);
      expect(ids).toContain(greatGrandchild.id);
    });

    it("reports each node's depth from the root", async () => {
      const project = await createItem({ area: "detail-depth" });
      const child = await createItem({ area: "detail-depth", parentId: project.id });
      const grandchild = await createItem({ area: "detail-depth", parentId: child.id });

      const detail = await detailOf(project.id);
      const byId = new Map(detail.subtasks.map((s) => [s.id, s.depth]));
      expect(byId.get(child.id)).toBe(1);
      expect(byId.get(grandchild.id)).toBe(2);
    });

    it("orders depth-first — a child follows its own parent, not the next sibling", async () => {
      // The bug an `ORDER BY depth` would introduce: both branches'
      // children would be listed together, away from their parents, so the
      // indent would show a tree the order contradicts.
      const project = await createItem({ area: "detail-order" });
      const first = await createItem({
        area: "detail-order",
        parentId: project.id,
        title: "first",
      });
      const firstChild = await createItem({
        area: "detail-order",
        parentId: first.id,
        title: "first-child",
      });
      const second = await createItem({
        area: "detail-order",
        parentId: project.id,
        title: "second",
      });

      const detail = await detailOf(project.id);
      const titles = detail.subtasks.map((s) => s.title);
      expect(titles.indexOf("first")).toBeLessThan(titles.indexOf("first-child"));
      expect(titles.indexOf("first-child")).toBeLessThan(titles.indexOf("second"));
      expect(detail.subtasks.map((s) => s.id)).toEqual([first.id, firstChild.id, second.id]);
    });

    it("gives a task its column and gives a nested project NONE", async () => {
      // DECISIONS.md §13c: a project's stored state is a creation leftover.
      // A column derived from it would be a lie, so it is null.
      const project = await createItem({ area: "detail-kinds" });
      const task = await createItem({ area: "detail-kinds", parentId: project.id });
      await setState(task.id, "executing");
      const subProject = await createItem({ area: "detail-kinds", parentId: project.id });
      // A project by virtue of being parentless is not available here (it
      // has a parent), so make it one the way the schema allows: `kind` is
      // set at creation from parentage, so set it directly.
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "kind" = 'project'::"ItemKind" WHERE "id" = $1`,
        subProject.id,
      );

      const detail = await detailOf(project.id);
      const byId = new Map(detail.subtasks.map((s) => [s.id, s]));
      expect(byId.get(task.id)!.column).toBe("in_progress");
      expect(byId.get(subProject.id)!.column).toBeNull();
    });
  });

  describe("the root's column", () => {
    it("reads a task's own state directly", async () => {
      const project = await createItem({ area: "detail-col-task" });
      const task = await createItem({ area: "detail-col-task", parentId: project.id });
      await setState(task.id, "blocked");
      expect((await detailOf(task.id)).column).toBe("waiting");
    });

    it("derives a project's from its children, NOT from its stored state", async () => {
      // The load-bearing assertion: the project's row still says `on_deck`
      // (which maps to backlog), and the answer must be in_progress.
      const project = await createItem({ area: "detail-col-project" });
      expect(project.state).toBe("on_deck");
      const task = await createItem({ area: "detail-col-project", parentId: project.id });
      await setState(task.id, "executing");

      const detail = await detailOf(project.id);
      expect(detail.item.state).toBe("on_deck");
      expect(detail.column).toBe("in_progress");
      expect(detail.column).not.toBe("backlog");
    });

    it("derives a fully-merged project as completed", async () => {
      const project = await createItem({ area: "detail-col-done" });
      const task = await createItem({ area: "detail-col-done", parentId: project.id });
      await setState(task.id, "merged");
      expect((await detailOf(project.id)).column).toBe("completed");
    });
  });

  describe("artifacts", () => {
    async function addArtifact(
      itemId: string,
      fields: { kind: string; verdict?: string; round?: number; sha?: string },
    ): Promise<void> {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Artifact" ("id", "itemId", "kind", "verdict", "reviewRound", "commitSha")
         VALUES (gen_random_uuid(), $1, $2::"ArtifactKind", $3::"Verdict", $4, $5)`,
        itemId,
        fields.kind,
        fields.verdict ?? null,
        fields.round ?? 1,
        fields.sha ?? null,
      );
    }

    it("is empty for an item with none", async () => {
      const project = await createItem({ area: "detail-art-none" });
      const task = await createItem({ area: "detail-art-none", parentId: project.id });
      expect((await detailOf(task.id)).artifacts).toEqual([]);
    });

    it("returns every artifact, ordered by review round ascending", async () => {
      const project = await createItem({ area: "detail-art" });
      const task = await createItem({ area: "detail-art", parentId: project.id });
      await addArtifact(task.id, { kind: "code_review", verdict: "changes_requested", round: 2 });
      await addArtifact(task.id, { kind: "plan", round: 1 });
      await addArtifact(task.id, { kind: "code_review", verdict: "lgtm", round: 3 });

      const detail = await detailOf(task.id);
      expect(detail.artifacts.map((a) => a.reviewRound)).toEqual([1, 2, 3]);
      expect(detail.artifacts.map((a) => a.verdict)).toEqual([null, "changes_requested", "lgtm"]);
    });

    it("does not return another item's artifacts", async () => {
      const project = await createItem({ area: "detail-art-scope" });
      const mine = await createItem({ area: "detail-art-scope", parentId: project.id });
      const theirs = await createItem({ area: "detail-art-scope", parentId: project.id });
      await addArtifact(theirs.id, { kind: "code_review", verdict: "lgtm" });

      expect((await detailOf(mine.id)).artifacts).toEqual([]);
    });
  });

  describe("history", () => {
    it("returns the item's events newest first", async () => {
      const project = await createItem({ area: "detail-history" });
      const task = await createItem({ area: "detail-history", parentId: project.id });
      await runtime.call("note", { itemId: task.id, body: "first note" });
      await runtime.call("note", { itemId: task.id, body: "second note" });

      const detail = await detailOf(task.id);
      const bodies = detail.history.map((h) => h.body);
      expect(bodies.indexOf("second note")).toBeLessThan(bodies.indexOf("first note"));
    });

    it("stringifies the event id — a bigint cannot cross a JSON boundary", async () => {
      // `JSON.stringify` throws on a bigint outright, so an unmapped id
      // would fail the HTTP route on its very first call.
      const project = await createItem({ area: "detail-history-json" });
      const task = await createItem({ area: "detail-history-json", parentId: project.id });
      await runtime.call("note", { itemId: task.id, body: "a note" });

      const detail = await detailOf(task.id);
      expect(detail.history.length).toBeGreaterThan(0);
      expect(typeof detail.history[0]!.id).toBe("string");
      expect(() => JSON.stringify(detail)).not.toThrow();
    });

    it("caps at historyLimit and says so, without counting the probe row as an entry", async () => {
      const project = await createItem({ area: "detail-history-cap" });
      const task = await createItem({ area: "detail-history-cap", parentId: project.id });
      for (let i = 0; i < 5; i++) {
        await runtime.call("note", { itemId: task.id, body: `note ${i}` });
      }

      const detail = await detailOf(task.id, { historyLimit: 2 });
      expect(detail.history).toHaveLength(2);
      expect(detail.historyTruncated).toBe(true);
    });

    it("does NOT claim truncation when the ledger fits exactly within the limit", async () => {
      // The off-by-one this guards: reading `limit + 1` rows and then
      // comparing against `limit` naively would flag a full page as
      // truncated even when there is nothing more.
      const project = await createItem({ area: "detail-history-exact" });
      const task = await createItem({ area: "detail-history-exact", parentId: project.id });
      const before = (await detailOf(task.id)).history.length;

      const detail = await detailOf(task.id, { historyLimit: before });
      expect(detail.history).toHaveLength(before);
      expect(detail.historyTruncated).toBe(false);
    });

    it("does not return another item's events", async () => {
      const project = await createItem({ area: "detail-history-scope" });
      const mine = await createItem({ area: "detail-history-scope", parentId: project.id });
      const theirs = await createItem({ area: "detail-history-scope", parentId: project.id });
      await runtime.call("note", { itemId: theirs.id, body: "not mine" });

      const detail = await detailOf(mine.id);
      expect(detail.history.map((h) => h.body)).not.toContain("not mine");
    });
  });

  describe("the summary", () => {
    it("is null for an item that has never been completed", async () => {
      const project = await createItem({ area: "detail-summary-none" });
      const task = await createItem({ area: "detail-summary-none", parentId: project.id });
      expect((await detailOf(task.id)).summary).toBeNull();
    });

    it("is returned once one exists", async () => {
      const project = await createItem({ area: "detail-summary" });
      const task = await createItem({ area: "detail-summary", parentId: project.id });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Summary" ("itemId", "shipped", "notDone", "userFacing", "howVerified", "watchFor", "finalState")
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6::jsonb, $7::jsonb)`,
        task.id,
        JSON.stringify(["the thing"]),
        JSON.stringify([]),
        false,
        "unit tests",
        JSON.stringify([]),
        JSON.stringify({}),
      );

      const detail = await detailOf(task.id);
      expect(detail.summary).not.toBeNull();
      expect(detail.summary!.shipped).toEqual(["the thing"]);
      expect(detail.summary!.userFacing).toBe(false);
      expect(detail.summary!.howVerified).toBe("unit tests");
    });
  });

  describe("input validation", () => {
    it("refuses a historyLimit above the cap rather than serving an unbounded page", async () => {
      const project = await createItem({ area: "detail-limit" });
      const task = await createItem({ area: "detail-limit", parentId: project.id });
      await expect(detailOf(task.id, { historyLimit: 5000 })).rejects.toThrow();
    });

    it("refuses an unrecognised field rather than silently ignoring it", async () => {
      const project = await createItem({ area: "detail-strict" });
      const task = await createItem({ area: "detail-strict", parentId: project.id });
      await expect(detailOf(task.id, { nope: true })).rejects.toThrow();
    });
  });
});
