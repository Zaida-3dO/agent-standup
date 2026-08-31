// The two folded tools — `loop` and `create_work` — against Postgres.
//
// **What would make this file hollow.** Asserting that `loop { action:
// "add" }` returns a loopId proves only that a dispatch happened; it would
// pass against a fold that defaulted `kind` on edit, accepted every
// type/parent combination, and refused nothing by name. So every case below
// fixes a *decision* and names, beside the assertion, the single source
// change that breaks it.
//
// The decisions worth pinning, in the order they can go wrong:
//
//   1. **`kind` means different things by its absence in add and in edit.**
//      `loop_add` defaults it to `work`; `loop_edit` treats absence as
//      "leave it alone". A fold carrying one optional `kind` with one
//      default silently retypes every `note` loop that is reworded without
//      restating its kind — inflating the count of outstanding work in the
//      direction nobody checks. Pinned twice: once that the default still
//      applies on add, once that it does NOT apply on edit.
//   2. **A type/parent mismatch is refused, not guessed.** This is the
//      whole argument for folding three creates into one: `create_item` was
//      retired because it inferred the kind from whether a pointer was
//      supplied, and a fold that accepted `type: "task"` with no
//      `projectId` and produced a project would be that defect returning
//      with a nicer schema.
//   3. **The refusal names the field and says what to pass.** A bare
//      "invalid type" is a regression against the bar the summary guards
//      set, and would justify the objection this design answers.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { DEFAULT_LOOP_KIND } from "@/lib/open-loops";
import { LOOP_ACTIONS } from "@/lib/service/operations/loop";
import { CREATE_WORK_TYPES } from "@/lib/service/operations/create-work";
import type { LoopGetOutput, LoopListOutput } from "@/lib/service/operations/loop-reads";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ServiceError {
  code: string;
  guard?: string;
  fields?: string[];
  message: string;
}

/** Runs `call` and returns the error it threw, failing the test if it did not throw. */
async function rejection(call: Promise<unknown>): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

describeIfDb("the folded loop and create_work tools, against Postgres", () => {
  const dbName = scratchDatabaseName("tool_folds");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const scratch = await createMigratedScratchDatabase(testDatabaseUrl!, dbName);
    prisma = new PrismaClient({ datasourceUrl: scratch.url });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  const call = <T>(name: string, input: unknown): Promise<T> =>
    runtime.call(name as never, input, { caller: { actor: "tester" } }) as Promise<T>;

  let counter = 0;
  async function seedItem(): Promise<string> {
    counter += 1;
    const id = `fold-item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Item ${counter}`,
        body: "seeded for the fold tests",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

  // ── Fold 1: the loop verbs ───────────────────────────────────────────

  describe("loop — every action reaches the operation it folds", () => {
    it("runs a loop through add, get, list, edit, close", async () => {
      const itemId = await seedItem();
      const added = await call<{ loopId: string }>("loop", {
        action: "add",
        itemId,
        text: "the first loose end",
      });
      expect(added.loopId).toBeTruthy();

      const got = await call<LoopGetOutput>("loop", {
        action: "get",
        itemId,
        loopId: added.loopId,
      });
      expect(got.text).toBe("the first loose end");

      const listed = await call<LoopListOutput>("loop", { action: "list", itemId });
      expect(listed.loops.map((l) => l.loopId)).toContain(added.loopId);

      await call("loop", {
        action: "edit",
        itemId,
        loopId: added.loopId,
        text: "the first loose end, reworded",
      });
      const afterEdit = await call<LoopGetOutput>("loop", {
        action: "get",
        itemId,
        loopId: added.loopId,
      });
      expect(afterEdit.text).toBe("the first loose end, reworded");

      await call("loop", { action: "close", itemId, loopId: added.loopId });
      const afterClose = await call<LoopGetOutput>("loop", {
        action: "get",
        itemId,
        loopId: added.loopId,
      });
      expect(afterClose.status).toBe("closed");
    });

    // Fails if `delete` stops dispatching to `loop_delete` — the retraction
    // has to keep the loop out of the ordinary list, not merely close it.
    it("retracts a loop through action delete, and it leaves the ordinary list", async () => {
      const itemId = await seedItem();
      const added = await call<{ loopId: string }>("loop", {
        action: "add",
        itemId,
        text: "a duplicate loose end",
      });
      await call("loop", {
        action: "delete",
        itemId,
        loopId: added.loopId,
        reason: "a duplicate of the loop recorded moments earlier by mistake",
      });
      const listed = await call<LoopListOutput>("loop", {
        action: "list",
        itemId,
        includeClosed: true,
      });
      expect(listed.loops.map((l) => l.loopId)).not.toContain(added.loopId);
    });
  });

  describe("loop — the kind asymmetry between add and edit", () => {
    // THE TRAP. Fails the moment `kind` is given a `.default()` on the
    // folded schema, or the edit branch stops forwarding an absent kind as
    // absent — either change retypes this `note` to `work`.
    it("an edit that omits kind leaves a note a note", async () => {
      const itemId = await seedItem();
      const added = await call<{ loopId: string; kind: string }>("loop", {
        action: "add",
        itemId,
        text: "a reference, not work",
        kind: "note",
      });
      expect(added.kind).toBe("note");

      const edited = await call<{ kind: string; previousKind: string }>("loop", {
        action: "edit",
        itemId,
        loopId: added.loopId,
        text: "a reference, not work — reworded",
        // `kind` deliberately not sent.
      });
      expect(edited.previousKind).toBe("note");
      expect(edited.kind).toBe("note");

      const got = await call<LoopGetOutput>("loop", {
        action: "get",
        itemId,
        loopId: added.loopId,
      });
      expect(got.kind).toBe("note");
    });

    // The other half of the same asymmetry: absence on ADD does default.
    // Fails if the fold starts forwarding an explicit kind on add, or if
    // `loop_add`'s own default is removed.
    it("an add that omits kind records work", async () => {
      const itemId = await seedItem();
      const added = await call<{ loopId: string; kind: string }>("loop", {
        action: "add",
        itemId,
        text: "an ordinary loose end",
      });
      expect(added.kind).toBe(DEFAULT_LOOP_KIND);
      expect(added.kind).toBe("work");
    });

    // An explicit kind on edit still reclassifies — the preserve rule is
    // about absence, not about ignoring the field.
    it("an edit that sends kind does reclassify", async () => {
      const itemId = await seedItem();
      const added = await call<{ loopId: string }>("loop", {
        action: "add",
        itemId,
        text: "filed as work by mistake",
      });
      const edited = await call<{ kind: string }>("loop", {
        action: "edit",
        itemId,
        loopId: added.loopId,
        text: "filed as work by mistake",
        kind: "note",
      });
      expect(edited.kind).toBe("note");
    });
  });

  describe("loop — error paths", () => {
    // Fails if `requireFields` stops checking, or checks the wrong action.
    it.each([
      ["add", { action: "add" }, "text"],
      ["get", { action: "get" }, "loopId"],
      ["edit", { action: "edit", text: "x" }, "loopId"],
      ["close", { action: "close" }, "loopId"],
      ["delete", { action: "delete", reason: "x".repeat(30) }, "loopId"],
    ])("refuses %s when a required field is missing, naming it", async (_name, args, field) => {
      const itemId = await seedItem();
      const error = await rejection(call("loop", { ...args, itemId }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain(field);
      // Names the field and says what to do — not a bare "invalid".
      expect(error.message).toContain(`\`${field}\``);
      expect(error.message.toLowerCase()).toContain("resend");
    });

    // Fails if the fold swallows the underlying operation's NotFoundError
    // or rewrites it — the refusal must arrive as the unfolded call's.
    it.each(["get", "close", "edit", "delete"])(
      "refuses action %s naming a loop that does not exist",
      async (action) => {
        const itemId = await seedItem();
        const error = await rejection(
          call("loop", {
            action,
            itemId,
            loopId: "no-such-loop",
            text: "text for the edit case",
            reason: "a reason long enough to pass the minimum length rule",
          }),
        );
        expect(error.code).toBe("not_found");
        expect(error.fields).toContain("loopId");
        expect(error.message).toContain("no-such-loop");
      },
    );

    // The deletion-reason steering is one of the refusals the fold promises
    // to deliver unchanged. Fails if `delete` stops dispatching to
    // `loop_delete` or starts validating the reason itself.
    it("delete still refuses a reason that describes a closure", async () => {
      const itemId = await seedItem();
      const added = await call<{ loopId: string }>("loop", {
        action: "add",
        itemId,
        text: "a real loose end",
      });
      const error = await rejection(
        call("loop", {
          action: "delete",
          itemId,
          loopId: added.loopId,
          reason: "this was resolved earlier in the week by another change",
        }),
      );
      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe("loops.delete_reason_is_not_a_closure");
      // Through the fold this message reaches an MCP caller verbatim, and
      // `loop_close` is waived off MCP — so the remedy has to name the
      // action the caller can actually send.
      expect(error.message).toContain('action "close"');
      expect(error.message).not.toContain("loop_close");
    });

    it("refuses an action that is not one of the six", async () => {
      const itemId = await seedItem();
      const error = await rejection(call("loop", { action: "archive", itemId }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("action");
    });
  });

  // ── Fold 2: the three creates ────────────────────────────────────────

  describe("create_work — each type reaches the operation it folds", () => {
    it("creates a project, a task under it, and a subtask under that", async () => {
      const project = await call<{ id: string }>("create_work", {
        type: "project",
        title: "A project for the fold tests",
        body: "b",
        area: "web",
        originType: "auto",
      });
      const task = await call<{ id: string }>("create_work", {
        type: "task",
        title: "A task under the project",
        body: "b",
        area: "web",
        originType: "auto",
        projectId: project.id,
      });
      const subtask = await call<{ id: string }>("create_work", {
        type: "subtask",
        title: "A subtask under the task",
        body: "b",
        area: "web",
        originType: "auto",
        taskId: task.id,
      });

      const rows = await prisma.item.findMany({
        where: { id: { in: [project.id, task.id, subtask.id] } },
        select: { id: true, kind: true, parentId: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // The kind the caller ASKED for is the kind it got — the property
      // `create_item` could not offer. Fails if a branch dispatches to the
      // wrong operation.
      expect(byId.get(project.id)!.kind).toBe("project");
      expect(byId.get(task.id)!.kind).toBe("task");
      expect(byId.get(subtask.id)!.kind).toBe("subtask");
      expect(byId.get(task.id)!.parentId).toBe(project.id);
      expect(byId.get(subtask.id)!.parentId).toBe(task.id);
    });

    it('accepts the literal "inbox" as a task\'s projectId', async () => {
      const task = await call<{ id: string }>("create_work", {
        type: "task",
        title: "A task filed in the inbox",
        body: "b",
        area: "web",
        originType: "auto",
        projectId: "inbox",
      });
      const row = await prisma.item.findUnique({
        where: { id: task.id },
        select: { kind: true, parentId: true },
      });
      expect(row!.kind).toBe("task");
      expect(row!.parentId).not.toBeNull();
    });
  });

  describe("create_work — a type/parent mismatch is refused by name", () => {
    const common = {
      title: "A title for the mismatch cases",
      body: "b",
      area: "web",
      originType: "auto",
    };

    // THE OTHER TRAP. Each case would, under `create_item`'s inference,
    // have silently produced an item of the wrong kind. Fails the moment
    // `assertTypeMatchesParent` stops throwing for any one of them.
    it("refuses type task with no projectId, naming projectId", async () => {
      const error = await rejection(call("create_work", { ...common, type: "task" }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["projectId"]);
      expect(error.message).toContain("`projectId`");
      // Says what was wrong, that nothing was created, and what to pass.
      expect(error.message).toContain("Nothing was created");
      expect(error.message).toContain("inbox");
      // And it must NOT have quietly created a project instead.
      expect(await prisma.item.count()).toBe(0);
    });

    it("refuses type subtask with no taskId, naming taskId", async () => {
      const error = await rejection(call("create_work", { ...common, type: "subtask" }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["taskId"]);
      expect(error.message).toContain("`taskId`");
      expect(error.message).toContain("Nothing was created");
      expect(await prisma.item.count()).toBe(0);
    });

    it("refuses type project with a projectId, naming it", async () => {
      const error = await rejection(
        call("create_work", { ...common, type: "project", projectId: "inbox" }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("projectId");
      expect(error.message).toContain("does not take one");
      expect(await prisma.item.count()).toBe(0);
    });

    it("refuses type task with a taskId, naming it and offering the other type", async () => {
      const project = await call<{ id: string }>("create_work", {
        ...common,
        type: "project",
        title: "A project",
      });
      const error = await rejection(
        call("create_work", {
          ...common,
          type: "task",
          projectId: project.id,
          taskId: project.id,
        }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("taskId");
      expect(error.message).toContain('set type to "subtask"');
    });

    it("refuses type subtask with a projectId", async () => {
      const error = await rejection(
        call("create_work", { ...common, type: "subtask", taskId: "x", projectId: "y" }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("projectId");
    });

    it("refuses a call with no type at all", async () => {
      const error = await rejection(call("create_work", { ...common }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("type");
    });

    // The underlying operations' own kind refusals must survive the fold —
    // this is the check that a task cannot be parented to a task.
    it("still refuses a projectId that names a task, not a project", async () => {
      const project = await call<{ id: string }>("create_work", {
        ...common,
        type: "project",
        title: "A project",
      });
      const task = await call<{ id: string }>("create_work", {
        ...common,
        type: "task",
        title: "A task",
        projectId: project.id,
      });
      const error = await rejection(
        call("create_work", { ...common, type: "task", projectId: task.id }),
      );
      expect(error.code).toBe("not_found");
      expect(error.fields).toContain("projectId");
      expect(error.message).toContain("create_subtask");
    });

    it("still refuses a taskId that names a project", async () => {
      const project = await call<{ id: string }>("create_work", {
        ...common,
        type: "project",
        title: "A project",
      });
      const error = await rejection(
        call("create_work", { ...common, type: "subtask", taskId: project.id }),
      );
      expect(error.code).toBe("not_found");
      expect(error.fields).toContain("taskId");
      expect(error.message).toContain("create_task");
    });
  });
});

// These need no database — they read the declarations themselves.
describe("the folded tools' declared surface", () => {
  it("folds exactly the six loop verbs", () => {
    expect([...LOOP_ACTIONS]).toEqual(["add", "get", "list", "edit", "close", "delete"]);
  });

  it("folds exactly the three creates", () => {
    expect([...CREATE_WORK_TYPES]).toEqual(["project", "task", "subtask"]);
  });
});
