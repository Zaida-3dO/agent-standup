// `get_board` against a real Postgres — SCHEMA.md §19 (`GET /board`), §1.1
// (columns), DECISIONS.md §13c (projects derive their column from
// children). Same shape as tests/items-operations.test.ts: a real database
// is needed because the column derivation runs a recursive query that an
// in-memory model of Postgres cannot prove.
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
import type { BoardOutput } from "@/lib/service/operations/get-board";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_board against Postgres", () => {
  const dbName = scratchDatabaseName("board_ops");
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

      // `includeTerminal` because this asserts the *column derivation* —
      // that `merged` maps to `completed` — and finished work is out of the
      // default read (MILESTONES.md #103), which is a separate behaviour
      // proved in tests/terminal-items-default.test.ts.
      const board = (await runtime.call("get_board", {
        area: "board-completed",
        includeTerminal: true,
      })) as BoardOutput;
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

      // `includeTerminal` for the same reason as "places a merged task in
      // completed" above: the assertion is about derivation, not about the
      // default filter #103 put in front of it.
      const board = (await runtime.call("get_board", {
        area: "board-project-done",
        includeTerminal: true,
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

    it("kind=task EXCLUDES the project itself, keeping only the task", async () => {
      // Together with the kind=project case above, this pins the
      // project/task split in both directions — a filter that always
      // returned everything (or a project-detection that treated every
      // item as a project) would pass one of the two but not both.
      const project = await createItem({ area: "board-filter-kind-task" });
      const task = await createItem({ area: "board-filter-kind-task", parentId: project.id });

      const board = (await runtime.call("get_board", {
        area: "board-filter-kind-task",
        kind: "task",
      })) as BoardOutput;
      const allIds = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].map((entry) => entry.item.id);
      expect(allIds).toEqual([task.id]);
    });

    it("repo filter genuinely EXCLUDES an item in a different repo", async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Repo" ("id", "displayName", "defaultBranch", "host", "needsVisualReview")
         VALUES ('board-repo-a', 'Repo A', 'main', 'github', false),
                ('board-repo-b', 'Repo B', 'main', 'github', false)
         ON CONFLICT ("id") DO NOTHING`,
      );
      const inRepoA = await createItem({ area: "board-filter-repo", repo: "board-repo-a" });
      await createItem({ area: "board-filter-repo", repo: "board-repo-b" });

      const board = (await runtime.call("get_board", {
        area: "board-filter-repo",
        repo: "board-repo-a",
      })) as BoardOutput;
      const allIds = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].map((entry) => entry.item.id);
      expect(allIds).toEqual([inRepoA.id]);
    });

    it("repo AND kind filters combined still bind the right value to the right placeholder", async () => {
      // repo is not the last condition built (kind can follow it), so a
      // wrong paramIndex increment after the repo clause would bind kind's
      // value into repo's placeholder (or vice versa) — a single-filter
      // test can't observe that misalignment because there is only ever
      // one placeholder in play. Two projects in the SAME repo, only one
      // of the matching kind, is the case that tells them apart.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Repo" ("id", "displayName", "defaultBranch", "host", "needsVisualReview")
         VALUES ('board-repo-combo', 'Repo Combo', 'main', 'github', false)
         ON CONFLICT ("id") DO NOTHING`,
      );
      const project = await createItem({ area: "board-filter-combo", repo: "board-repo-combo" });
      await createItem({
        area: "board-filter-combo",
        repo: "board-repo-combo",
        parentId: project.id,
      });

      const board = (await runtime.call("get_board", {
        area: "board-filter-combo",
        repo: "board-repo-combo",
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

    it("a board with NO projects at all (only tasks) still resolves — the descendant-lookup query is genuinely skipped, not merely unused", async () => {
      // Distinguishes projectIds.length > 0 from a mutated >= 0 (always
      // true): with zero projects on the board, a task's own column must
      // still come from columnForState, not from an empty/undefined
      // descendant-states path silently succeeding for the wrong reason.
      const root = await createItem({ area: "board-no-projects" });
      await setState(root.id, "executing");
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "kind" = 'task'::"ItemKind" WHERE "id" = $1`,
        root.id,
      );

      const board = (await runtime.call("get_board", {
        area: "board-no-projects",
        kind: "task",
      })) as BoardOutput;
      expect(board.in_progress.some((entry) => entry.item.id === root.id)).toBe(true);
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

    it("with NO filters at all, an item from any area still appears — proves each filter clause is genuinely conditional on its input being present, not unconditionally applied", async () => {
      // If `input.area !== undefined` (or priority's / repo's / kind's
      // equivalent guard) were mutated to an unconditional `true`, this
      // call would try to bind `undefined` into a WHERE clause no caller
      // asked for and either error or wrongly exclude every item —
      // including this one, which no filter here should ever touch.
      const item = await createItem({ area: "board-no-filters-at-all" });
      const board = (await runtime.call("get_board", {})) as BoardOutput;
      const allIds = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].map((entry) => entry.item.id);
      expect(allIds).toContain(item.id);
    });

    it("state filter genuinely EXCLUDES a task in a different state", async () => {
      // A root item (no parentId) is a PROJECT (kind derived from depth,
      // create-item.ts) — the state filter excludes those by design (see
      // the next test), so both items here must be TASKS under a project,
      // or this would trivially pass by excluding both, not by narrowing.
      const project = await createItem({ area: "board-filter-state" });
      const executing = await createItem({ area: "board-filter-state", parentId: project.id });
      await setState(executing.id, "executing");
      const blocked = await createItem({ area: "board-filter-state", parentId: project.id });
      await setState(blocked.id, "blocked");

      const board = (await runtime.call("get_board", {
        area: "board-filter-state",
        state: "executing",
      })) as BoardOutput;
      const allIds = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].map((entry) => entry.item.id);
      expect(allIds).toEqual([executing.id]);
    });

    it("state filter EXCLUDES a project even when the project's own leftover-default state matches the filter value", async () => {
      // Every item, project included, is created with `on_deck`
      // (`create_item`'s default) and a project never transitions — so a
      // naive `state = 'on_deck'` equality with no kind exclusion would
      // wrongly sweep in every untouched project. This is the exact case
      // the module header names as the reason the filter carries a
      // `kind != 'project'` clause alongside the equality check.
      const project = await createItem({ area: "board-filter-state-project" });
      expect(project.state).toBe("on_deck");
      const onDeckTask = await createItem({
        area: "board-filter-state-project",
        parentId: project.id,
      });
      expect(onDeckTask.state).toBe("on_deck");

      const board = (await runtime.call("get_board", {
        area: "board-filter-state-project",
        state: "on_deck",
      })) as BoardOutput;
      const allIds = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ].map((entry) => entry.item.id);
      expect(allIds).toEqual([onDeckTask.id]);
      expect(allIds).not.toContain(project.id);
    });

    describe('assignee filter — "who\'s on it"', () => {
      async function claimAs(itemId: string, holderId: string, sessionId: string): Promise<void> {
        await runtime.call("claim", {
          itemId,
          role: "builder",
          holderType: "agent",
          holderId,
          sessionId,
          machine: "board-tests-machine",
        });
      }

      it("genuinely EXCLUDES an item held by a different holder", async () => {
        const held = await createItem({ area: "board-filter-assignee" });
        await claimAs(held.id, "crew-alpha", "session-alpha");
        const unheld = await createItem({ area: "board-filter-assignee" });
        await claimAs(unheld.id, "crew-beta", "session-beta");

        const board = (await runtime.call("get_board", {
          area: "board-filter-assignee",
          assignee: "crew-alpha",
        })) as BoardOutput;
        const allIds = [
          ...board.backlog,
          ...board.in_progress,
          ...board.waiting,
          ...board.completed,
        ].map((entry) => entry.item.id);
        expect(allIds).toEqual([held.id]);
      });

      it("excludes an item whose only assignment has been RELEASED — 'who's on it' means a live claim, not history", async () => {
        const item = await createItem({ area: "board-filter-assignee-released" });
        await claimAs(item.id, "crew-gamma", "session-gamma");
        await runtime.call("release", { itemId: item.id, sessionId: "session-gamma" });

        const board = (await runtime.call("get_board", {
          area: "board-filter-assignee-released",
          assignee: "crew-gamma",
        })) as BoardOutput;
        const allIds = [
          ...board.backlog,
          ...board.in_progress,
          ...board.waiting,
          ...board.completed,
        ].map((entry) => entry.item.id);
        expect(allIds).toEqual([]);
      });

      it("an unclaimed item never matches any assignee filter", async () => {
        await createItem({ area: "board-filter-assignee-none" });
        const board = (await runtime.call("get_board", {
          area: "board-filter-assignee-none",
          assignee: "nobody-in-particular",
        })) as BoardOutput;
        const allIds = [
          ...board.backlog,
          ...board.in_progress,
          ...board.waiting,
          ...board.completed,
        ].map((entry) => entry.item.id);
        expect(allIds).toEqual([]);
      });
    });

    describe("search filter — free text over title/body", () => {
      it("matches a substring of the title, case-insensitively", async () => {
        const match = await createItem({
          area: "board-filter-search-title",
          title: "Fix the Onboarding flow",
          body: "irrelevant",
        });
        await createItem({
          area: "board-filter-search-title",
          title: "Unrelated work",
          body: "irrelevant",
        });

        const board = (await runtime.call("get_board", {
          area: "board-filter-search-title",
          search: "onboard",
        })) as BoardOutput;
        const allIds = [
          ...board.backlog,
          ...board.in_progress,
          ...board.waiting,
          ...board.completed,
        ].map((entry) => entry.item.id);
        expect(allIds).toEqual([match.id]);
      });

      it("matches a substring of the body, and genuinely excludes an item where neither field matches", async () => {
        const match = await createItem({
          area: "board-filter-search-body",
          title: "x",
          body: "The migration touches the payments table.",
        });
        await createItem({
          area: "board-filter-search-body",
          title: "x",
          body: "Nothing to do with that at all.",
        });

        const board = (await runtime.call("get_board", {
          area: "board-filter-search-body",
          search: "payments",
        })) as BoardOutput;
        const allIds = [
          ...board.backlog,
          ...board.in_progress,
          ...board.waiting,
          ...board.completed,
        ].map((entry) => entry.item.id);
        expect(allIds).toEqual([match.id]);
      });

      // `escapeLikePattern` is the boundary between caller-supplied text and
      // an `ILIKE ... ESCAPE '\'` pattern, and no test above reaches it: none
      // of their search terms contains a `%`, `_` or `\`, so the escaping
      // never runs and removing it changes no outcome. That showed up as
      // surviving mutants on both the regex and the replacement.
      //
      // Each case below pairs an item containing the literal character with
      // a decoy that matches only if the character is treated as a wildcard.
      // Asserting the decoy is excluded is what makes these fail when the
      // escaping is gone — asserting only that the literal item is found
      // would pass either way, since a wildcard match is a superset.
      describe("search treats LIKE wildcards in the term as literal characters", () => {
        it("matches a literal % without letting it stand for any run of characters", async () => {
          const match = await createItem({
            area: "board-search-literal-percent",
            title: "Cut latency by 100% this quarter",
            body: "x",
          });
          const decoy = await createItem({
            area: "board-search-literal-percent",
            // Contains "100" and "quarter" but no "%", so `100% this quarter`
            // read as a pattern (`100`, anything, ` this quarter`) matches it.
            title: "Cut latency by 100 in this quarter",
            body: "x",
          });

          const board = (await runtime.call("get_board", {
            area: "board-search-literal-percent",
            search: "100% this quarter",
          })) as BoardOutput;
          const allIds = [
            ...board.backlog,
            ...board.in_progress,
            ...board.waiting,
            ...board.completed,
          ].map((entry) => entry.item.id);

          expect(allIds).toEqual([match.id]);
          expect(allIds).not.toContain(decoy.id);
        });

        it("matches a literal _ without letting it stand for a single character", async () => {
          const match = await createItem({
            area: "board-search-literal-underscore",
            title: "rename foo_bar everywhere",
            body: "x",
          });
          const decoy = await createItem({
            area: "board-search-literal-underscore",
            // `foo_bar` as a pattern matches `fooXbar` — one character where
            // the underscore is.
            title: "rename fooXbar everywhere",
            body: "x",
          });

          const board = (await runtime.call("get_board", {
            area: "board-search-literal-underscore",
            search: "foo_bar",
          })) as BoardOutput;
          const allIds = [
            ...board.backlog,
            ...board.in_progress,
            ...board.waiting,
            ...board.completed,
          ].map((entry) => entry.item.id);

          expect(allIds).toEqual([match.id]);
          expect(allIds).not.toContain(decoy.id);
        });

        it("matches a literal backslash before an ordinary character", async () => {
          // The case the other two cannot cover, and the one that pins `\`'s
          // presence in the escaping character class.
          //
          // The backslash has to be followed by an ORDINARY character to
          // distinguish anything. A term like `C:\%` is escaped identically
          // whether or not the class contains `\`, because the lone
          // backslash still escapes the `%` that follows it — the two
          // patterns differ in text and agree in meaning, so a test built on
          // one cannot fail. With `src\lib` they genuinely diverge: escaping
          // the backslash gives `src\\lib`, which matches a literal
          // backslash, while leaving it gives `src\lib`, where the backslash
          // escapes the `l` and matches `srclib` — text with no backslash in
          // it at all. So the decoy below is matched by exactly the broken
          // version, and the real title by exactly the correct one.
          const match = await createItem({
            area: "board-search-literal-backslash",
            title: "see src\\lib here",
            body: "x",
          });
          const decoy = await createItem({
            area: "board-search-literal-backslash",
            title: "see srclib here",
            body: "x",
          });

          const board = (await runtime.call("get_board", {
            area: "board-search-literal-backslash",
            search: "src\\lib",
          })) as BoardOutput;
          const allIds = [
            ...board.backlog,
            ...board.in_progress,
            ...board.waiting,
            ...board.completed,
          ].map((entry) => entry.item.id);

          expect(allIds).toEqual([match.id]);
          expect(allIds).not.toContain(decoy.id);
        });
      });
    });

    describe("composition — two or more filters narrow together", () => {
      it("area + priority + state together return only the item matching ALL three, not any one of them", async () => {
        // Three items, each matching exactly two of the three filters, plus
        // one matching all three — a test that only ANDs two dimensions
        // could still pass if the implementation quietly ORed a third in.
        // Each is a TASK under a project, not a bare root item — a root
        // item is itself a project (kind derived from depth), and the
        // state filter deliberately excludes projects (see the dedicated
        // test above), which would make this test pass by exclusion rather
        // than by genuinely narrowing on all three dimensions.
        const project = await createItem({ area: "board-compose-target" });
        const target = await createItem({
          area: "board-compose-target",
          parentId: project.id,
          priority: "P0",
        });
        await setState(target.id, "blocked");

        const wrongPriority = await createItem({
          area: "board-compose-target",
          parentId: project.id,
          priority: "P2",
        });
        await setState(wrongPriority.id, "blocked");

        const wrongState = await createItem({
          area: "board-compose-target",
          parentId: project.id,
          priority: "P0",
        });
        await setState(wrongState.id, "executing");

        const otherAreaProject = await createItem({ area: "board-compose-other-area" });
        const wrongArea = await createItem({
          area: "board-compose-other-area",
          parentId: otherAreaProject.id,
          priority: "P0",
        });
        await setState(wrongArea.id, "blocked");

        const board = (await runtime.call("get_board", {
          area: "board-compose-target",
          priority: "P0",
          state: "blocked",
        })) as BoardOutput;
        const allIds = [
          ...board.backlog,
          ...board.in_progress,
          ...board.waiting,
          ...board.completed,
        ].map((entry) => entry.item.id);
        expect(allIds).toEqual([target.id]);
      });

      it("assignee + search together return empty when the assignee holds an item that doesn't match the search text", async () => {
        // Proves composition narrows even when each filter alone would
        // match something — a mistakenly-OR'd implementation would still
        // return the held item here.
        const held = await createItem({
          area: "board-compose-empty",
          title: "Completely different topic",
          body: "nothing searched for here",
        });
        await runtime.call("claim", {
          itemId: held.id,
          role: "builder",
          holderType: "agent",
          holderId: "crew-delta",
          sessionId: "session-delta",
          machine: "board-tests-machine",
        });

        const board = (await runtime.call("get_board", {
          area: "board-compose-empty",
          assignee: "crew-delta",
          search: "onboarding",
        })) as BoardOutput;
        expect(board.backlog).toEqual([]);
        expect(board.in_progress).toEqual([]);
        expect(board.waiting).toEqual([]);
        expect(board.completed).toEqual([]);
      });
    });
  });
});
