// M10 T11 — `get_projects` rolls a project's subtree up into the numbers a
// card renders. MILESTONES.md #74.
//
// **What would make this file hollow.** Asserting that a project with three
// merged children reports `merged: 3` proves less than it looks: so does an
// implementation that counts direct children only, one that counts every
// item in the store, and one that ignores `kind` entirely. The load-bearing
// assertions here are therefore about **discrimination**:
//
//   - a grandchild is counted (a single-level join would pass every
//     shallow-tree test and silently undercount real trees),
//   - another project's children are NOT counted against this one,
//   - a childless project reports `progress: null` rather than `0`, which
//     is the whole honesty requirement and the one an obvious
//     implementation gets wrong by writing `merged / total || 0`,
//   - the rollup costs ONE query regardless of how many projects there are,
//     which is the task's load-bearing performance claim.
//
// Each test below names the single-character change that would break it.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem, type ClaimInput } from "@/lib/claims";
import type { GetProjectsOutput, ProjectRollup } from "@/lib/service/operations/get-projects";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_projects rolls up a project's subtree", () => {
  const dbName = scratchDatabaseName("projects_rollup");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  const AREA = "rollup-tests";

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      AREA,
    );
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  let seq = 0;

  /**
   * Inserts one item directly, so a fixture can name a `state`, a `kind` and
   * a parent — none of which `create_item` takes. The same fixture route
   * `tests/assignments-in-reads.test.ts` and `tests/board-pagination.test.ts`
   * take, including the `ItemArea` join row an area-filtered read needs.
   */
  async function makeItem(options: {
    kind: "project" | "task" | "subtask";
    state?: string;
    parentId?: string | null;
    label: string;
    area?: string;
    repo?: string | null;
    headline?: string | null;
  }): Promise<string> {
    const id = `pr-${seq++}-${options.label.replace(/[^a-z0-9]+/gi, "-")}`;
    const area = options.area ?? AREA;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      area,
    );
    // `Item.repo` is a foreign key, so a fixture naming a repo has to seed
    // the row it points at.
    if (options.repo != null) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Repo" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
        options.repo,
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Item" ("id", "kind", "title", "body", "headline", "state", "priority", "area",
         "repo", "parentId", "originType", "driveMode", "mergeAuthority", "createdAt", "updatedAt")
       VALUES ($1, $2::"ItemKind", $3, 'body', $4, $5::"ItemState", 'P2'::"Priority", $6,
         $7, $8, 'auto'::"OriginType", 'autonomous'::"DriveMode", 'agent_judgement'::"MergeAuthority",
         now(), now())`,
      id,
      options.kind,
      options.label,
      options.headline ?? null,
      options.state ?? "on_deck",
      area,
      options.repo ?? null,
      options.parentId ?? null,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      id,
      area,
    );
    return id;
  }

  async function projects(input: Record<string, unknown> = {}): Promise<GetProjectsOutput> {
    return (await runtime.call("get_projects", input)) as GetProjectsOutput;
  }

  function projectFor(result: GetProjectsOutput, id: string): ProjectRollup {
    const project = result.projects.find((p) => p.id === id);
    if (!project) throw new Error(`Project ${id} was not returned.`);
    return project;
  }

  describe("the counts", () => {
    it("counts children by state, and totals them", async () => {
      // Breaks if: the `FILTER (WHERE …)` clause loses a state, or `total`
      // is computed as anything but the number of descendants.
      const area = "counts-basic";
      const project = await makeItem({ kind: "project", label: "counted", area });
      await makeItem({ kind: "task", state: "merged", parentId: project, label: "m1", area });
      await makeItem({ kind: "task", state: "merged", parentId: project, label: "m2", area });
      await makeItem({ kind: "task", state: "executing", parentId: project, label: "e1", area });

      const result = projectFor(await projects({ area }), project);

      expect(result.total).toBe(3);
      expect(result.merged).toBe(2);
      expect(result.counts.merged).toBe(2);
      expect(result.counts.executing).toBe(1);
      // A state with nothing in it is a zero, never a missing key — the
      // distribution strip walks every state and a gap would read as a
      // rendering fault.
      expect(result.counts.blocked).toBe(0);
      expect(result.progress).toBeCloseTo(2 / 3);
    });

    it("counts a GRANDCHILD, not just direct children", async () => {
      // The single most likely wrong implementation: a one-level join. It
      // passes every shallow fixture and silently undercounts any project
      // whose work is organised one level deeper — and `kind`'s nesting is
      // unbounded (SCHEMA.md §1).
      //
      // Breaks if: the recursive `UNION ALL` arm is dropped — `total`
      // becomes 1 and `merged` becomes 0.
      const area = "counts-deep";
      const project = await makeItem({ kind: "project", label: "deep", area });
      const task = await makeItem({
        kind: "task",
        state: "executing",
        parentId: project,
        label: "mid",
        area,
      });
      await makeItem({
        kind: "subtask",
        state: "merged",
        parentId: task,
        label: "leaf",
        area,
      });

      const result = projectFor(await projects({ area }), project);

      expect(result.total).toBe(2);
      expect(result.merged).toBe(1);
    });

    it("does not count another project's children against this one", async () => {
      // Breaks if: `rootId` stops being carried through the recursion (so
      // every descendant aggregates against whichever project the join
      // happens to reach), or the `LEFT JOIN` condition drops `s."rootId" =
      // p."id"` — both make each project report the other's children too.
      const area = "counts-isolation";
      const mine = await makeItem({ kind: "project", label: "mine", area });
      const theirs = await makeItem({ kind: "project", label: "theirs", area });
      await makeItem({ kind: "task", state: "merged", parentId: mine, label: "a", area });
      await makeItem({ kind: "task", state: "merged", parentId: theirs, label: "b", area });
      await makeItem({ kind: "task", state: "merged", parentId: theirs, label: "c", area });

      // Every child here is merged, so both projects are fully finished and
      // the default read would exclude them — this test is about attribution,
      // not about that exclusion.
      const result = await projects({ area, includeCompleted: true });

      expect(projectFor(result, mine).total).toBe(1);
      expect(projectFor(result, theirs).total).toBe(2);
    });

    it("counts terminal states as finished without calling them merged", async () => {
      // `finished` and `merged` answer different questions: a progress bar
      // measures what shipped, while "is anything still live" decides
      // whether a project is over. A project whose remaining children were
      // cancelled is done and is not 100% merged.
      //
      // Breaks if: `finished` is computed as `counts.merged`, or the sum
      // drops any of the four terminal states.
      const area = "counts-terminal";
      const project = await makeItem({ kind: "project", label: "terminal", area });
      await makeItem({ kind: "task", state: "merged", parentId: project, label: "t1", area });
      await makeItem({ kind: "task", state: "cancelled", parentId: project, label: "t2", area });
      await makeItem({ kind: "task", state: "wont_do", parentId: project, label: "t3", area });
      await makeItem({
        kind: "task",
        state: "research_done",
        parentId: project,
        label: "t4",
        area,
      });

      // Every child is terminal, so this project only appears when
      // completed work is asked for.
      const result = projectFor(await projects({ area, includeCompleted: true }), project);

      expect(result.finished).toBe(4);
      expect(result.merged).toBe(1);
      expect(result.progress).toBeCloseTo(0.25);
    });
  });

  describe("a project with no children", () => {
    it("reports progress as NULL, never as zero", async () => {
      // The honesty requirement. `0` states that no work is done; `null`
      // states there is no work — and a card that renders "0% complete"
      // against an empty project asserts something false about work that
      // does not exist.
      //
      // Breaks if: `progress` is written as `total === 0 ? 0 : …`, or as
      // `counts.merged / total || 0` — both make this `0` and fail.
      const area = "childless-progress";
      const project = await makeItem({ kind: "project", label: "empty", area });

      const result = projectFor(await projects({ area }), project);

      expect(result.progress).toBeNull();
      expect(result.total).toBe(0);
      expect(result.childless).toBe(true);
    });

    it("is RETURNED, not filtered out — including on the default read", async () => {
      // Hiding structurally broken rows is how a board stops being
      // trustworthy. The default read excludes *completed* projects, and a
      // childless one must not be swept up in that: `finished === total` is
      // trivially true at `0 === 0`.
      //
      // Breaks if: the exclusion loses its `!childless` half — the project
      // vanishes from the default read and `projectFor` throws.
      const area = "childless-visible";
      const project = await makeItem({ kind: "project", label: "visible", area });

      const result = await projects({ area });

      expect(projectFor(result, project).childless).toBe(true);
      expect(result.childlessCount).toBe(1);
    });

    it("is distinguished from a project whose children are merely all merged", async () => {
      // The two look identical on a progress bar alone (`0/0` and `3/3`
      // both render as "nothing left to do"), and they are completely
      // different facts: one is finished, the other never had any work.
      //
      // Breaks if: `childless` is derived from anything but the child count
      // — e.g. from `finished === total`, which is true for both.
      const area = "childless-vs-done";
      const empty = await makeItem({ kind: "project", label: "nothing", area });
      const done = await makeItem({ kind: "project", label: "all-done", area });
      await makeItem({ kind: "task", state: "merged", parentId: done, label: "d1", area });

      const result = await projects({ area, includeCompleted: true });

      expect(projectFor(result, empty).childless).toBe(true);
      expect(projectFor(result, empty).progress).toBeNull();
      expect(projectFor(result, done).childless).toBe(false);
      expect(projectFor(result, done).progress).toBe(1);
      expect(result.childlessCount).toBe(1);
    });
  });

  describe("what the default read excludes", () => {
    it("hides a project whose every child is finished, until asked", async () => {
      // Breaks if: the `finished === total` exclusion is removed — the
      // project appears in the default read and the first expectation
      // fails.
      const area = "completed-hidden";
      const project = await makeItem({ kind: "project", label: "done", area });
      await makeItem({ kind: "task", state: "merged", parentId: project, label: "x", area });

      expect((await projects({ area })).projects.map((p) => p.id)).not.toContain(project);
      expect(
        (await projects({ area, includeCompleted: true })).projects.map((p) => p.id),
      ).toContain(project);
    });

    it("keeps a project with any live child", async () => {
      // Breaks if: the exclusion compares anything but `finished === total`
      // — e.g. `finished > 0`, which would hide a project that has merged
      // one child and is actively working two more.
      const area = "partially-done";
      const project = await makeItem({ kind: "project", label: "partial", area });
      await makeItem({ kind: "task", state: "merged", parentId: project, label: "p1", area });
      await makeItem({ kind: "task", state: "executing", parentId: project, label: "p2", area });

      expect((await projects({ area })).projects.map((p) => p.id)).toContain(project);
    });
  });

  describe("last activity", () => {
    it("reports a child's timestamp when the child is newer than the project row", async () => {
      // A project row is only touched when the project itself is edited,
      // which for an active project is almost never — so reading its own
      // `updatedAt` would report a project whose children were all touched
      // this morning as untouched for months.
      //
      // Breaks if: `lastActivity` is taken from the project's own
      // `updatedAt` alone — it stays at the seeded past date and fails.
      const area = "activity-child";
      const project = await makeItem({ kind: "project", label: "stale-row", area });
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "updatedAt" = now() - interval '90 days' WHERE "id" = $1`,
        project,
      );
      const child = await makeItem({
        kind: "task",
        state: "executing",
        parentId: project,
        label: "fresh",
        area,
      });

      const result = projectFor(await projects({ area }), project);
      const childRow = await prisma.$queryRawUnsafe<{ updatedAt: Date }[]>(
        `SELECT "updatedAt" FROM "Item" WHERE "id" = $1`,
        child,
      );

      expect(result.lastActivity).toBe(childRow[0]!.updatedAt.toISOString());
    });

    it("falls back to the project's own timestamp when there are no children", async () => {
      // Breaks if: the fallback is dropped — `lastActivity` becomes null on
      // a childless project, and the card has no date to render.
      const area = "activity-own";
      const project = await makeItem({ kind: "project", label: "no-kids", area });

      const result = projectFor(await projects({ area }), project);

      expect(result.lastActivity).not.toBeNull();
      expect(() => new Date(result.lastActivity).toISOString()).not.toThrow();
    });
  });

  describe("live crew", () => {
    async function claim(input: Partial<ClaimInput> & { itemId: string; sessionId: string }) {
      return prisma.$transaction((tx) =>
        claimItem(tx, {
          role: "orchestrator",
          holderType: "agent",
          holderId: "crew-one",
          machine: "desktop",
          ...input,
        } as ClaimInput),
      );
    }

    it("reports the live holders of a project", async () => {
      // Breaks if: the assignment attach pass is removed — `assignments`
      // stays `[]` and the length check fails.
      const area = "crew-live";
      const project = await makeItem({ kind: "project", label: "held", area });
      await makeItem({ kind: "task", state: "executing", parentId: project, label: "w", area });
      await claim({ itemId: project, sessionId: "s-held", holderId: "crew-held" });

      const result = projectFor(await projects({ area }), project);

      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0]!.holderId).toBe("crew-held");
      expect(result.assignments[0]!.liveness).toBe("running");
    });

    it("gives an unheld project an empty list, not a missing field", async () => {
      // "Nobody holds this" and "this read does not report ownership" must
      // not render identically.
      //
      // Breaks if: `assignmentsByItem.get(id) ?? []` loses its `?? []` —
      // the field becomes `undefined`.
      const area = "crew-unheld";
      const project = await makeItem({ kind: "project", label: "unheld", area });
      await makeItem({ kind: "task", state: "executing", parentId: project, label: "w", area });

      const result = projectFor(await projects({ area }), project);

      expect(result.assignments).toEqual([]);
      expect("assignments" in result).toBe(true);
    });

    it("does not report a released holder as current", async () => {
      // Breaks if: the read stops filtering on `releasedAt IS NULL` — the
      // released row comes back and the length check fails.
      const area = "crew-released";
      const project = await makeItem({ kind: "project", label: "released", area });
      await makeItem({ kind: "task", state: "executing", parentId: project, label: "w", area });
      await claim({ itemId: project, sessionId: "s-rel", holderId: "crew-rel" });
      await prisma.$executeRawUnsafe(
        `UPDATE "Assignment" SET "releasedAt" = now() WHERE "itemId" = $1`,
        project,
      );

      expect(projectFor(await projects({ area }), project).assignments).toEqual([]);
    });
  });

  describe("filters", () => {
    it("narrows by repo", async () => {
      // Breaks if: the repo condition is dropped — the other project comes
      // back too and the length check fails.
      const area = "filter-repo";
      const mine = await makeItem({ kind: "project", label: "repo-a", area, repo: "web" });
      await makeItem({ kind: "project", label: "repo-b", area, repo: "infra" });

      const result = await projects({ area, repo: "web" });

      expect(result.projects.map((p) => p.id)).toEqual([mine]);
    });

    it("returns only projects, never tasks", async () => {
      // The rollup is meaningless for a task, and a task appearing here
      // would be rendered as a project with no children — indistinguishable
      // from the broken rows this read exists to flag.
      //
      // Breaks if: the `kind = 'project'` condition is dropped.
      const area = "filter-kind";
      const project = await makeItem({ kind: "project", label: "real", area });
      await makeItem({ kind: "task", state: "executing", label: "loose-task", area });

      const result = await projects({ area });

      expect(result.projects.map((p) => p.id)).toEqual([project]);
    });
  });

  describe("the rollup does not scale with the number of projects", () => {
    it("costs ONE rollup query for every project, however many there are", async () => {
      // The task's load-bearing performance claim, and the N+1 this is most
      // likely to have been implemented as: read the projects, then walk
      // each one's subtree. That is correct in every assertion above and
      // one round trip per project on a page whose whole purpose is to show
      // every project.
      //
      // Counted from Prisma's own query event stream, so it measures
      // statements that actually reached Postgres.
      //
      // Breaks if: the subtree walk moves inside a per-project loop — the
      // count becomes one per project and `toBe(1)` fails.
      const area = "n-plus-one";
      for (let i = 0; i < 20; i++) {
        const project = await makeItem({ kind: "project", label: `np-${i}`, area });
        await makeItem({
          kind: "task",
          state: "executing",
          parentId: project,
          label: `np-child-${i}`,
          area,
        });
      }

      const logged = new PrismaClient({
        datasourceUrl: scratchUrl,
        log: [{ emit: "event", level: "query" }],
      });
      const statements: string[] = [];
      logged.$on("query", (event: { query: string }) => statements.push(event.query));
      const loggedRuntime = new ServiceRuntime({
        transaction: prismaTransactionRunner(logged),
        resolveSnapshot: async () => defaultSnapshot(),
      });

      try {
        const result = (await loggedRuntime.call("get_projects", { area })) as GetProjectsOutput;

        // The page really is large — otherwise "one query" is trivially
        // true and this proves nothing about scaling.
        expect(result.projects.length).toBeGreaterThanOrEqual(20);

        const rollupQueries = statements.filter((q) => q.includes(`FROM "Item"`));
        expect(rollupQueries).toHaveLength(1);
        // And ownership is still the board's single keyed statement, not
        // one per project.
        expect(statements.filter((q) => q.includes(`FROM "Assignment"`))).toHaveLength(1);
      } finally {
        await logged.$disconnect();
      }
    }, 120_000);

    it("issues no assignment query at all when nothing matched", async () => {
      // Breaks if: the `ids.length === 0` guard is removed — the count
      // becomes 1.
      const logged = new PrismaClient({
        datasourceUrl: scratchUrl,
        log: [{ emit: "event", level: "query" }],
      });
      const statements: string[] = [];
      logged.$on("query", (event: { query: string }) => statements.push(event.query));
      const loggedRuntime = new ServiceRuntime({
        transaction: prismaTransactionRunner(logged),
        resolveSnapshot: async () => defaultSnapshot(),
      });

      try {
        const result = (await loggedRuntime.call("get_projects", {
          area: "an-area-with-no-projects",
        })) as GetProjectsOutput;
        expect(result.projects).toEqual([]);

        expect(statements.filter((q) => q.includes(`FROM "Assignment"`))).toHaveLength(0);
      } finally {
        await logged.$disconnect();
      }
    }, 60_000);
  });
});
