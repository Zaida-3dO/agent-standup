// `reparent_item` / `retype_to_task` / `repair_stuck_projects` against a
// real Postgres — SCHEMA.md §1, §17.2, DECISIONS.md §13c.
//
// The behaviour under test is that an item's *position* is correctable: a
// move re-derives `kind` and depth on the item and on everything beneath it,
// records the change on the one event ledger, and refuses the four moves that
// would corrupt the tree. The end-to-end claim that matters is the one the
// defect was about — an item that could not be transitioned *before* the move
// can be transitioned *after* it.
//
// The rejection cases are the point of the file. Each one names a single
// source change that would make it pass wrongly, in a comment above it, so a
// test that cannot fail is visible as such rather than counted as coverage.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot, resolveSettings } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface Item {
  id: string;
  kind: string;
  parentId: string | null;
  state: string;
  area: string;
  title: string;
}

interface Rejection {
  code: string;
  fields?: string[];
  guard?: string;
  message: string;
}

interface RepairResult {
  applied: boolean;
  projectId: string;
  items: { id: string; title: string; area: string; state: string }[];
  count: number;
}

describeIfDb("reparenting and retyping", () => {
  const dbName = scratchDatabaseName("reparent");
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

  /** The common fields every create needs, so a case shows only what it varies. */
  function base(title: string, area = "reparent") {
    return { title, body: "The brief.", area, originType: "auto" as const };
  }

  async function call(name: string, input: unknown): Promise<Item> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(name, input)) as Item;
  }

  async function rejectionOf(name: string, input: unknown): Promise<Rejection> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await (runtime.call as any)(name, input).catch((e: unknown) => e);
    return error as Rejection;
  }

  /** One item straight from the database, bypassing the service's own read. */
  async function rowOf(id: string): Promise<{ kind: string; parentId: string | null }> {
    const rows = await prisma.$queryRawUnsafe<{ kind: string; parentId: string | null }[]>(
      `SELECT "kind"::text AS "kind", "parentId" FROM "Item" WHERE "id" = $1`,
      id,
    );
    return rows[0]!;
  }

  /** Every `field_change` event on one item, newest last, as `{field, from, to}`. */
  async function fieldChanges(
    id: string,
  ): Promise<{ field: string; from: unknown; to: unknown }[]> {
    const rows = await prisma.$queryRawUnsafe<{ payload: Record<string, unknown> }[]>(
      `SELECT "payload" FROM "Event" WHERE "itemId" = $1 AND "type" = 'field_change' ORDER BY "id" ASC`,
      id,
    );
    return rows.map(
      (row) => row.payload as unknown as { field: string; from: unknown; to: unknown },
    );
  }

  describe("reparent_item", () => {
    it("moves a task between projects and keeps it a task", async () => {
      const from = await call("create_project", base("Origin project"));
      const to = await call("create_project", base("Destination project"));
      const task = await call("create_task", { ...base("A task"), projectId: from.id });

      const moved = await call("reparent_item", { id: task.id, parentId: to.id });

      expect(moved.parentId).toBe(to.id);
      expect(moved.kind).toBe("task");
      // Read back from the row, not from the returned record: an operation
      // that shaped a correct-looking result without writing would pass an
      // assertion on its own return value. Fails if `applyMove`'s UPDATE
      // stops setting `"parentId"`.
      expect((await rowOf(task.id)).parentId).toBe(to.id);
    });

    // The whole point of the change, end to end. Before the move the item is
    // a parentless, childless project: the state machine refuses it
    // (`ProjectHasNoStateError`) and no child exists whose completion could
    // resolve it. After the move it is a task and moves.
    //
    // Fails if `applyMove` stops re-deriving `kind` — change `kindForDepth(newDepth)`
    // to `item.kind` and the row stays a project, so the transition below
    // is refused with `forbidden` and the assertion on "planning" fails.
    it("turns a stuck parentless item into something that CAN be transitioned", async () => {
      const stuck = await call("create_project", base("Stuck, then not"));
      const home = await call("create_project", base("Its real home"));

      const before = await rejectionOf("transition_item", { id: stuck.id, to: "planning" });
      expect(before.code).toBe("forbidden");

      await call("reparent_item", { id: stuck.id, parentId: home.id });

      const moved = (await runtime.call("transition_item", {
        id: stuck.id,
        to: "planning",
      })) as { item: { state: string } };
      expect(moved.item.state).toBe("planning");
    });

    // A move down one level makes the moving item a subtask; its own child
    // lands one deeper and is a subtask at both depths, so its kind holds
    // steady while the item's own kind changes. Asserting both halves is
    // what distinguishes "descendants are re-derived" from "descendants are
    // rewritten to whatever the parent got".
    it("re-derives kind on descendants, not just on the item that moved", async () => {
      const project = await call("create_project", base("Deep project"));
      const task = await call("create_task", { ...base("Deep task"), projectId: project.id });
      const child = await call("create_task", {
        ...base("Becomes subtask"),
        projectId: project.id,
      });
      const grandchild = await call("create_subtask", {
        ...base("Becomes deeper subtask"),
        taskId: child.id,
      });

      // `child` is a task at depth 1 with a subtask under it. Moving it under
      // `task` puts it at depth 2 (subtask) and `grandchild` at depth 3.
      await call("reparent_item", { id: child.id, parentId: task.id });

      expect((await rowOf(child.id)).kind).toBe("subtask");
      // Fails if the descendant loop in `applyMove` is deleted: the
      // grandchild's kind was already `subtask` so this specific row would
      // still read correctly — which is why the *next* test moves a subtree
      // whose descendant's kind genuinely has to change.
      expect((await rowOf(grandchild.id)).kind).toBe("subtask");
    });

    // The descendant case where skipping the loop is actually visible: a task
    // with a subtask under it, promoted to a root. The task becomes a project
    // and its child must become a task. Fails if the descendant loop in
    // `applyMove` is removed — the child stays `subtask` under a project,
    // which is a kind that contradicts where it sits.
    it("re-derives a descendant whose kind genuinely changes", async () => {
      const project = await call("create_project", base("Promotion source"));
      const task = await call("create_task", { ...base("Gets promoted"), projectId: project.id });
      const sub = await call("create_subtask", { ...base("Gets promoted too"), taskId: task.id });

      await call("reparent_item", { id: task.id, parentId: null });

      expect((await rowOf(task.id)).kind).toBe("project");
      expect((await rowOf(task.id)).parentId).toBeNull();
      expect((await rowOf(sub.id)).kind).toBe("task");
    });

    // "Every mutating call appends a row" (SCHEMA.md §3). A move is recorded
    // as field changes on `parentId` and `kind` through the single writer —
    // no new event type, no second raw insert. Fails if the
    // `recordFieldChanges` call in `applyMove` is deleted.
    it("records the move on the event ledger as parentId and kind changes", async () => {
      const from = await call("create_project", base("Ledger origin"));
      const to = await call("create_project", base("Ledger destination"));
      const task = await call("create_task", { ...base("Ledger task"), projectId: from.id });

      await call("reparent_item", { id: task.id, parentId: to.id });

      const changes = await fieldChanges(task.id);
      const parentChange = changes.find((change) => change.field === "parentId");
      expect(parentChange).toBeDefined();
      expect(parentChange!.from).toBe(from.id);
      expect(parentChange!.to).toBe(to.id);
    });

    // The kind half of the same rule, on a move where kind actually changes.
    // Fails if `applyMove` narrows its `fields` list to `["parentId"]`.
    it("records a kind change when the move changes the kind", async () => {
      const project = await call("create_project", base("Kind ledger project"));
      const task = await call("create_task", {
        ...base("Kind ledger task"),
        projectId: project.id,
      });

      await call("reparent_item", { id: task.id, parentId: null });

      const changes = await fieldChanges(task.id);
      const kindChange = changes.find(
        (change) => change.field === "kind" && change.to === "project",
      );
      expect(kindChange).toBeDefined();
      expect(kindChange!.from).toBe("task");
    });

    // A move that changes nothing writes nothing — `recordFieldChanges`
    // skips fields whose value is unchanged. Fails if `applyMove` starts
    // appending unconditionally rather than through the diffing writer.
    it("writes no field_change events for a move to the parent it already has", async () => {
      const project = await call("create_project", base("No-op project"));
      const task = await call("create_task", { ...base("No-op task"), projectId: project.id });

      const before = (await fieldChanges(task.id)).length;
      await call("reparent_item", { id: task.id, parentId: project.id });
      expect((await fieldChanges(task.id)).length).toBe(before);
    });

    // ── Rejections ────────────────────────────────────────────────────

    // Fails if `assertNoCycle` is deleted from the handler, or if its
    // membership test is narrowed to exclude the item itself (row zero of
    // its own subtree).
    it("refuses moving an item under itself", async () => {
      const project = await call("create_project", base("Self parent"));
      const task = await call("create_task", { ...base("Self mover"), projectId: project.id });

      const rejection = await rejectionOf("reparent_item", { id: task.id, parentId: task.id });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.guard).toBe("hierarchy.no_cycle");
      expect(rejection.fields).toContain("parentId");
    });

    // The longer cycle: under a descendant, two levels down. Fails if
    // `subtreeOf`'s recursive term is dropped so the subtree is only ever
    // the item itself — the self-move test above would still pass, and this
    // one would not.
    it("refuses moving an item under one of its own descendants", async () => {
      const project = await call("create_project", base("Cycle project"));
      const task = await call("create_task", { ...base("Cycle task"), projectId: project.id });
      const sub = await call("create_subtask", { ...base("Cycle subtask"), taskId: task.id });

      const rejection = await rejectionOf("reparent_item", { id: task.id, parentId: sub.id });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.guard).toBe("hierarchy.no_cycle");
    });

    // And the tree is unchanged afterwards — a refusal that had already
    // written is worse than no refusal. Fails if the cycle check moves below
    // `applyMove` in the handler.
    it("leaves the tree untouched when it refuses a cycle", async () => {
      const project = await call("create_project", base("Untouched project"));
      const task = await call("create_task", { ...base("Untouched task"), projectId: project.id });
      const sub = await call("create_subtask", { ...base("Untouched sub"), taskId: task.id });

      await rejectionOf("reparent_item", { id: task.id, parentId: sub.id });

      expect((await rowOf(task.id)).parentId).toBe(project.id);
      expect((await rowOf(sub.id)).parentId).toBe(task.id);
    });

    // Fails if `resolveParent`'s empty-result branch stops throwing — the
    // move would then write a `parentId` pointing at nothing, which the
    // foreign key would refuse with a driver error nobody can act on rather
    // than a `not_found` naming the field.
    it("refuses a parent that does not exist", async () => {
      const project = await call("create_project", base("Real project"));
      const task = await call("create_task", { ...base("Real task"), projectId: project.id });

      const rejection = await rejectionOf("reparent_item", {
        id: task.id,
        parentId: "00000000-0000-0000-0000-000000000000",
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toContain("parentId");
    });

    // Fails if `resolveParent`'s `archivedAt` check is deleted, or if its
    // query drops the join to `Area` (the column would not be selected and
    // the check would compare `undefined !== null`, which is true — so this
    // test also catches the join going missing, in the direction that
    // matters: it would start refusing everything, and every other test in
    // this file would go red alongside it).
    it("refuses a parent in an archived area", async () => {
      const project = await call("create_project", base("Archived home", "retired-area"));
      const elsewhere = await call("create_project", base("Live project"));
      const task = await call("create_task", { ...base("Homeless task"), projectId: elsewhere.id });

      await prisma.$executeRawUnsafe(
        `UPDATE "Area" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        "retired-area",
      );

      const rejection = await rejectionOf("reparent_item", {
        id: task.id,
        parentId: project.id,
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.message).toContain("archived");

      await prisma.$executeRawUnsafe(
        `UPDATE "Area" SET "archivedAt" = NULL WHERE "id" = $1`,
        "retired-area",
      );
    });

    // The depth bound, read from the setting rather than a constant. Fails
    // if `assertDepthFits` is deleted, or if it compares against a literal
    // instead of `ctx.settings.values["items.max_depth"]` — this runtime
    // resolves the setting to 2, well below the code default of 6.
    it("refuses a move that would exceed items.max_depth, reading the setting", async () => {
      const shallow = new ServiceRuntime({
        transaction: prismaTransactionRunner(prisma),
        resolveSnapshot: async () =>
          resolveSettings({ overrides: [{ key: "items.max_depth", value: 2 }], revision: 1n }),
      });

      const project = await call("create_project", base("Depth project"));
      const task = await call("create_task", { ...base("Depth task"), projectId: project.id });
      const sub = await call("create_subtask", { ...base("Depth sub"), taskId: task.id });
      const deeper = await call("create_subtask", { ...base("Depth deeper"), taskId: sub.id });

      // `deeper` sits at depth 3. Moving it under `sub` (depth 2) would put
      // it at 3 again — but under `deeper`'s sibling chain the bound of 2 is
      // already the issue: moving `sub` under itself is a cycle, so the
      // honest case is moving a depth-2 subtree one level deeper.
      const rejection = (await shallow
        .call("reparent_item", { id: sub.id, parentId: task.id })
        .catch((error: unknown) => error)) as Rejection;

      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.guard).toBe("items.max_depth");
      expect(rejection.fields).toContain("parentId");
      expect(deeper.id).toBeTruthy();
    });

    // The subtree half of the depth bound: the moving item itself fits, and
    // its deepest descendant does not. Fails if `assertDepthFits` checks
    // `newDepth` alone rather than `newDepth + deepestRelative` — the item
    // lands at depth 2, inside the bound, while its child lands at 3.
    it("refuses on the DEEPEST descendant, not just the item named", async () => {
      const shallow = new ServiceRuntime({
        transaction: prismaTransactionRunner(prisma),
        resolveSnapshot: async () =>
          resolveSettings({ overrides: [{ key: "items.max_depth", value: 2 }], revision: 1n }),
      });

      const project = await call("create_project", base("Subtree depth project"));
      const taskA = await call("create_task", { ...base("Subtree A"), projectId: project.id });
      const taskB = await call("create_task", { ...base("Subtree B"), projectId: project.id });
      await call("create_subtask", { ...base("Subtree B child"), taskId: taskB.id });

      // Moving `taskB` under `taskA` puts `taskB` at depth 2 (allowed) and
      // its child at depth 3 (not).
      const rejection = (await shallow
        .call("reparent_item", { id: taskB.id, parentId: taskA.id })
        .catch((error: unknown) => error)) as Rejection;

      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.guard).toBe("items.max_depth");
      expect(rejection.message).toContain("subtree");
    });

    // Fails if `.strict()` is dropped from the input schema. Asserted on the
    // message because Zod reports `unrecognized_keys` with an empty path.
    it("refuses an unrecognised field", async () => {
      const project = await call("create_project", base("Strict project"));
      const rejection = await rejectionOf("reparent_item", {
        id: project.id,
        parentId: null,
        kind: "task",
      });
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.message).toContain("kind");
    });

    // `parentId` is required, and `null` is a value rather than an absence.
    // Fails if the field is changed from `.nullable()` to `.optional()`:
    // omitting it would then parse, and the handler would treat "the caller
    // did not say" as "make this a root".
    it("requires parentId to be stated, even as null", async () => {
      const project = await call("create_project", base("Requires parent"));
      const rejection = await rejectionOf("reparent_item", { id: project.id });
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("parentId");
    });

    it("refuses an item that does not exist", async () => {
      const rejection = await rejectionOf("reparent_item", {
        id: "00000000-0000-0000-0000-000000000000",
        parentId: null,
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toContain("id");
    });

    // `"inbox"` means the same thing here as in `create_task` — resolved
    // through the same function. Fails if the sentinel branch is removed:
    // the literal string would be looked up as an id and refused
    // `not_found`.
    it('accepts the "inbox" sentinel and files the item under the inbox project', async () => {
      const stuck = await call("create_project", base("Inbox-bound"));

      const moved = await call("reparent_item", { id: stuck.id, parentId: "inbox" });

      expect(moved.kind).toBe("task");
      expect(moved.parentId).not.toBeNull();
      const parent = await rowOf(moved.parentId!);
      expect(parent.kind).toBe("project");
      expect(parent.parentId).toBeNull();
    });
  });

  describe("retype_to_task", () => {
    it("turns a childless project into a task under a named project", async () => {
      const stuck = await call("create_project", base("Was a project"));
      const home = await call("create_project", base("Retype home"));

      const retyped = await call("retype_to_task", { id: stuck.id, projectId: home.id });

      expect(retyped.kind).toBe("task");
      expect(retyped.parentId).toBe(home.id);
    });

    // The state answer, asserted rather than merely documented: the row
    // keeps the state it already had. Nothing is invented and nothing is
    // reset. Fails if `applyMove` starts writing `"state"` — set it to
    // `'on_deck'` in the UPDATE and this reads `on_deck` instead of
    // `blocked`.
    it("keeps the state already on the row — nothing is invented", async () => {
      const stuck = await call("create_project", base("Keeps its state"));
      const home = await call("create_project", base("State home"));

      // Written directly: a project cannot be transitioned, which is the
      // whole condition this operation exists to escape, so the state it is
      // stuck with can only have arrived by an import or a create.
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "state" = 'blocked'::"ItemState" WHERE "id" = $1`,
        stuck.id,
      );

      const retyped = await call("retype_to_task", { id: stuck.id, projectId: home.id });
      expect(retyped.state).toBe("blocked");
    });

    // And the consequence that makes keeping it worthwhile: from that state,
    // the state machine now moves it. Fails if `retype_to_task` stops
    // re-deriving `kind`.
    it("produces an item the state machine will move", async () => {
      const stuck = await call("create_project", base("Retype then move"));
      const home = await call("create_project", base("Move home"));

      await call("retype_to_task", { id: stuck.id, projectId: home.id });

      const moved = (await runtime.call("transition_item", {
        id: stuck.id,
        to: "planning",
      })) as { item: { state: string } };
      expect(moved.item.state).toBe("planning");
    });

    // ── Rejections ────────────────────────────────────────────────────

    // The decision this operation makes explicitly: a project with children
    // is refused rather than silently deepening them. Fails if the
    // `children.length > 0` branch is deleted.
    it("refuses a project that still has children", async () => {
      const parent = await call("create_project", base("Has children"));
      const home = await call("create_project", base("Children home"));
      await call("create_task", { ...base("A child"), projectId: parent.id });

      const rejection = await rejectionOf("retype_to_task", {
        id: parent.id,
        projectId: home.id,
      });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.guard).toBe("hierarchy.no_retype_with_children");
      expect(rejection.fields).toContain("id");
    });

    // The two-call escape hatch the refusal above points at actually works:
    // move the children out, then retype. Fails if `reparent_item` cannot
    // move a child off a project, which would make the refusal a dead end.
    it("accepts the same project once its children have been moved away", async () => {
      const parent = await call("create_project", base("Emptied"));
      const elsewhere = await call("create_project", base("Child's new home"));
      const home = await call("create_project", base("Emptied home"));
      const child = await call("create_task", { ...base("Moved away"), projectId: parent.id });

      await call("reparent_item", { id: child.id, parentId: elsewhere.id });
      const retyped = await call("retype_to_task", { id: parent.id, projectId: home.id });

      expect(retyped.kind).toBe("task");
    });

    // Fails if the `kind !== "project"` check is deleted: a task would be
    // moved by an operation whose whole contract is about projects, and the
    // caller would get no signal it had reached for the wrong one.
    it("refuses an item that is not a project", async () => {
      const project = await call("create_project", base("Not-a-project home"));
      const task = await call("create_task", { ...base("Already a task"), projectId: project.id });

      const rejection = await rejectionOf("retype_to_task", {
        id: task.id,
        projectId: project.id,
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toContain("id");
      expect(rejection.message).toContain("reparent_item");
    });

    // Fails if `assertNoCycle` is dropped from this handler — it would file
    // the item under itself, producing a row that is its own parent.
    it("refuses filing a project under itself", async () => {
      const stuck = await call("create_project", base("Self retype"));

      const rejection = await rejectionOf("retype_to_task", {
        id: stuck.id,
        projectId: stuck.id,
      });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.guard).toBe("hierarchy.no_cycle");
      expect(rejection.fields).toContain("projectId");
    });

    it("refuses a projectId that does not exist", async () => {
      const stuck = await call("create_project", base("No such home"));

      const rejection = await rejectionOf("retype_to_task", {
        id: stuck.id,
        projectId: "00000000-0000-0000-0000-000000000000",
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toContain("projectId");
    });
  });

  describe("repair_stuck_projects", () => {
    /** A scratch database of its own, so the scan's counts are not perturbed by other cases. */
    const repairDbName = scratchDatabaseName("repair");
    let repairPrisma: PrismaClient;
    let repairRuntime: ServiceRuntime;

    beforeAll(async () => {
      const url = (await createMigratedScratchDatabase(testDatabaseUrl!, repairDbName)).url;
      repairPrisma = new PrismaClient({ datasourceUrl: url });
      repairRuntime = new ServiceRuntime({
        transaction: prismaTransactionRunner(repairPrisma),
        resolveSnapshot: async () => defaultSnapshot(),
      });
    }, 60_000);

    afterAll(async () => {
      await repairPrisma?.$disconnect();
      await dropScratchDatabase(testDatabaseUrl!, repairDbName);
    });

    async function repairCall(name: string, input: unknown): Promise<Item> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await (repairRuntime.call as any)(name, input)) as Item;
    }

    async function repair(input: unknown): Promise<RepairResult> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await (repairRuntime.call as any)("repair_stuck_projects", input)) as RepairResult;
    }

    it("reports stuck rows without writing anything when apply is omitted", async () => {
      const home = await repairCall("create_project", base("Repair home"));
      const stuck = await repairCall("create_project", base("Repair stuck one"));

      const report = await repair({ projectId: home.id });

      expect(report.applied).toBe(false);
      expect(report.items.map((item) => item.id)).toContain(stuck.id);

      // Fails if `apply` stops defaulting to `false` — the row would have
      // moved and this would read the home's id instead of null.
      const rows = await repairPrisma.$queryRawUnsafe<{ parentId: string | null }[]>(
        `SELECT "parentId" FROM "Item" WHERE "id" = $1`,
        stuck.id,
      );
      expect(rows[0]!.parentId).toBeNull();
    });

    it("moves every stuck row under the named project when apply is true", async () => {
      const home = await repairCall("create_project", base("Applied home"));
      const stuckA = await repairCall("create_project", base("Applied stuck A"));
      const stuckB = await repairCall("create_project", base("Applied stuck B"));

      const result = await repair({ projectId: home.id, apply: true });

      expect(result.applied).toBe(true);
      const moved = result.items.map((item) => item.id);
      expect(moved).toContain(stuckA.id);
      expect(moved).toContain(stuckB.id);

      const rows = await repairPrisma.$queryRawUnsafe<{ id: string; kind: string }[]>(
        `SELECT "id", "kind"::text AS "kind" FROM "Item" WHERE "id" IN ($1, $2)`,
        stuckA.id,
        stuckB.id,
      );
      expect(rows.every((row) => row.kind === "task")).toBe(true);
    });

    // Idempotence, proved by the scan's own predicate rather than by a
    // marker: a repaired row has a parent, so it falls outside the scan.
    // Fails if the `parentId IS NULL` clause is dropped — the second run
    // would select the same rows again, sitting under `home`, and try to
    // move them a second time.
    it("finds nothing on a second run — the repair is idempotent", async () => {
      const home = await repairCall("create_project", base("Idempotent home"));
      await repairCall("create_project", base("Idempotent stuck"));

      const first = await repair({ projectId: home.id, apply: true });
      expect(first.count).toBeGreaterThan(0);

      const second = await repair({ projectId: home.id, apply: true });
      expect(second.count).toBe(0);
      expect(second.items).toEqual([]);
    });

    // A project with children derives its column from them, which is the
    // design working — it is not stuck and must not be moved. Fails if the
    // `NOT EXISTS` child clause is dropped from the scan.
    it("never touches a project that has children", async () => {
      const home = await repairCall("create_project", base("Parented home"));
      const withChild = await repairCall("create_project", base("Has a child"));
      await repairCall("create_task", { ...base("The child"), projectId: withChild.id });

      const report = await repair({ projectId: home.id });

      expect(report.items.map((item) => item.id)).not.toContain(withChild.id);
    });

    // A parentless row already in a terminal state reads as finished, so
    // moving it would be churn. Fails if the terminal-state clause is
    // dropped from the scan.
    it("never touches a parentless item already in a terminal state", async () => {
      const home = await repairCall("create_project", base("Terminal home"));
      const done = await repairCall("create_project", base("Already done"));
      await repairPrisma.$executeRawUnsafe(
        `UPDATE "Item" SET "state" = 'merged'::"ItemState" WHERE "id" = $1`,
        done.id,
      );

      const report = await repair({ projectId: home.id });

      expect(report.items.map((item) => item.id)).not.toContain(done.id);
    });

    // The destination is itself a parentless item. Fails if the `id <> $1`
    // exclusion is dropped from the scan: the home would match its own
    // predicate on the run that repairs everything else, and the cycle check
    // would then abort the whole batch.
    it("never files the destination project under itself", async () => {
      const home = await repairCall("create_project", base("Self-exclusion home"));

      const report = await repair({ projectId: home.id, apply: true });

      expect(report.items.map((item) => item.id)).not.toContain(home.id);
      const rows = await repairPrisma.$queryRawUnsafe<{ parentId: string | null }[]>(
        `SELECT "parentId" FROM "Item" WHERE "id" = $1`,
        home.id,
      );
      expect(rows[0]!.parentId).toBeNull();
    });

    // Fails if the `area` filter is dropped from the scan — the row in the
    // other area would be included.
    it("restricts the scan to one area when area is given", async () => {
      const home = await repairCall("create_project", base("Area home", "area-one"));
      const inScope = await repairCall("create_project", base("In scope", "area-one"));
      const outOfScope = await repairCall("create_project", base("Out of scope", "area-two"));

      const report = await repair({ projectId: home.id, area: "area-one" });

      const found = report.items.map((item) => item.id);
      expect(found).toContain(inScope.id);
      expect(found).not.toContain(outOfScope.id);
    });

    // No parent is ever guessed. Fails if `projectId` is made optional and
    // given a fallback.
    it("requires projectId — it never invents a parent", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rejection = (await (repairRuntime.call as any)("repair_stuck_projects", {
        apply: false,
      }).catch((error: unknown) => error)) as Rejection;

      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("projectId");
    });
  });
});
