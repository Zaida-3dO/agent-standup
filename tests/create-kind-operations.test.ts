// `create_project` / `create_task` / `create_subtask` against a real
// Postgres — SCHEMA.md §1, §17.2, DECISIONS.md §13c.
//
// The behaviour under test is that the *kind* an item ends up with is
// decided by which operation was called, not by which optional field
// happened to be filled in — and that the consequence a caller actually
// cares about follows: a task created here can be transitioned, and a
// project cannot.
//
// The rejection cases are the point of the file. Each one names a single
// source change that would make it pass wrongly, in a comment above it, so
// a test that cannot fail is visible as such rather than counted as
// coverage.
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

interface Created {
  id: string;
  kind: string;
  parentId: string | null;
  state: string;
  area: string;
  title: string;
  /** Present only when the title departs from the convention (MILESTONES.md #131). */
  titleAdvice?: string;
}

interface Rejection {
  code: string;
  fields?: string[];
  guard?: string;
  message: string;
}

describeIfDb("explicit create operations", () => {
  const dbName = scratchDatabaseName("create_kinds");
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
  function base(title: string, area = "create-kinds") {
    return { title, body: "The brief.", area, originType: "auto" as const };
  }

  async function rejectionOf(name: string, input: unknown): Promise<Rejection> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await (runtime.call as any)(name, input).catch((e: unknown) => e);
    return error as Rejection;
  }

  async function call(name: string, input: unknown): Promise<Created> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(name, input)) as Created;
  }

  async function eventCount(itemId: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM "Event" WHERE "itemId" = $1`,
      itemId,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  describe("create_project", () => {
    it("creates a root with kind project, no parent, and one create event", async () => {
      const project = await call("create_project", base("A project"));

      expect(project.kind).toBe("project");
      expect(project.parentId).toBeNull();
      expect(project.state).toBe("on_deck");
      // Fails if the shared insert stops appending the create event —
      // change `appendEvent(...)` to a no-op in create-core.ts and this is 0.
      expect(await eventCount(project.id)).toBe(1);
    });

    // Fails if `.strict()` is dropped from create-project.ts's schema: the
    // key would be silently ignored and the call would succeed.
    //
    // Asserted on the *message*, not on `fields`: Zod reports an
    // `unrecognized_keys` issue with an empty path and the offending key in
    // its message, so `fields` is legitimately empty here. Asserting the
    // empty `fields` instead would pass on a schema that refused some
    // entirely different key, which is the assertion that proves nothing.
    it("refuses a parentId — a project has no parent to name", async () => {
      const rejection = await rejectionOf("create_project", {
        ...base("Project with a parent"),
        parentId: "anything",
      });
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.message).toContain("parentId");
    });

    // Same guard, the other spelling. A caller reaching for `create_project`
    // with the field `create_task` wants is the mistake most likely to
    // happen, and it must be told rather than silently accepted.
    it("refuses a projectId", async () => {
      const rejection = await rejectionOf("create_project", {
        ...base("Project under a project"),
        projectId: "anything",
      });
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.message).toContain("projectId");
    });

    // Fails if the `originPersonId`-required refinement is dropped when the
    // shape is spread into the new schemas — the refinement moved modules in
    // this change, which is exactly when a cross-field rule goes missing.
    it("still requires originPersonId when originType is person", async () => {
      const rejection = await rejectionOf("create_project", {
        ...base("Person-origin project"),
        originType: "person",
      });
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("originPersonId");
    });
  });

  describe("create_task", () => {
    it("creates a task under a project, with the project as its parent", async () => {
      const project = await call("create_project", base("Task's project"));
      const task = await call("create_task", {
        ...base("A task"),
        projectId: project.id,
      });

      expect(task.kind).toBe("task");
      expect(task.parentId).toBe(project.id);
    });

    // The whole point of the change, asserted end to end: the thing you get
    // from `create_task` is a thing the state machine will move. Fails if
    // `create_task` ever produces a project — e.g. if the handler passed
    // `{ id: null, depth: 0 }` to the shared insert.
    it("produces an item that CAN be transitioned", async () => {
      const project = await call("create_project", base("Transitionable"));
      const task = await call("create_task", {
        ...base("Movable"),
        projectId: project.id,
      });

      const moved = (await runtime.call("transition_item", {
        id: task.id,
        to: "planning",
      })) as { item: { state: string } };
      expect(moved.item.state).toBe("planning");
    });

    // The failure the original defect produced, now impossible to reach by
    // accident: a project refuses to move. `forbidden` rather than
    // `guard_rejected` because no guard runs at all — a project has no state
    // for one to read (`ProjectHasNoStateError`, DECISIONS.md §13c). Fails
    // if `state-machine/transition.ts`'s `kind === "project"` check is
    // removed.
    it("and a project CANNOT be transitioned", async () => {
      const project = await call("create_project", base("Immovable"));
      const rejection = await rejectionOf("transition_item", {
        id: project.id,
        to: "planning",
      });
      expect(rejection.code).toBe("forbidden");
      expect(rejection.message).toMatch(/is a project/i);
    });

    // Fails if `projectId` is made `.optional()` — the call would succeed
    // and mint something rather than being refused.
    it("refuses a task with no projectId", async () => {
      const rejection = await rejectionOf("create_task", base("Homeless"));
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("projectId");
    });

    // An empty string is a caller that filled the field with nothing, which
    // is not the same as filing to the inbox. Fails if `.min(1)` is dropped.
    it("refuses an empty projectId", async () => {
      const rejection = await rejectionOf("create_task", {
        ...base("Blank parent"),
        projectId: "   ",
      });
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("projectId");
    });

    // Fails if the `depth === undefined` branch is removed from the handler:
    // the insert would then run with a parent pointer nothing satisfies and
    // fail as a foreign-key error, or worse, succeed.
    it("refuses a projectId that does not exist", async () => {
      const rejection = await rejectionOf("create_task", {
        ...base("Pointing nowhere"),
        projectId: "no-such-project",
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toEqual(["projectId"]);
    });

    // Fails if the `depth !== 1` branch is removed: the create would succeed
    // and quietly return a subtask from an operation called `create_task`,
    // which is the original defect wearing a different name.
    it("refuses a projectId that names a task, and says what to call instead", async () => {
      const project = await call("create_project", base("Real project"));
      const task = await call("create_task", {
        ...base("Real task"),
        projectId: project.id,
      });

      const rejection = await rejectionOf("create_task", {
        ...base("Wrongly parented"),
        projectId: task.id,
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toEqual(["projectId"]);
      expect(rejection.message).toContain("create_subtask");
    });

    it("nothing is written when the parent is refused", async () => {
      const before = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "Item"`,
      );
      await rejectionOf("create_task", {
        ...base("Never lands", "rollback-area"),
        projectId: "no-such-project",
      });
      const after = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "Item"`,
      );
      expect(after[0]?.count).toBe(before[0]?.count);
      // The area resolves before the parent check in the shared insert, so
      // this also proves the refusal rolls the whole transaction back rather
      // than leaving a half-written area behind. Fails if the operation
      // stopped running inside one transaction.
      const areas = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Area" WHERE "id" = 'rollback-area'`,
      );
      expect(areas).toHaveLength(0);
    });
  });

  describe('create_task with projectId "inbox"', () => {
    it("creates the inbox project on first use and files the task under it", async () => {
      const task = await call("create_task", {
        ...base("Captured quickly", "inbox-area"),
        projectId: "inbox",
      });

      expect(task.kind).toBe("task");
      expect(task.parentId).not.toBeNull();

      const parent = await prisma.$queryRawUnsafe<{ title: string; kind: string }[]>(
        `SELECT "title", "kind" FROM "Item" WHERE "id" = $1`,
        task.parentId,
      );
      // The default `items.inbox_project` is "Inbox". Fails if the resolver
      // stops reading the setting and hardcodes something else.
      expect(parent[0]?.title).toBe("Inbox");
      expect(parent[0]?.kind).toBe("project");
    });

    // Fails if `resolveInboxProject` drops its SELECT and always inserts —
    // the two tasks would land under two different projects.
    it("reuses the same inbox project on a second capture", async () => {
      const first = await call("create_task", {
        ...base("First capture", "inbox-reuse"),
        projectId: "inbox",
      });
      const second = await call("create_task", {
        ...base("Second capture", "inbox-reuse"),
        projectId: "inbox",
      });

      expect(second.parentId).toBe(first.parentId);

      const inboxes = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "Item" WHERE "parentId" IS NULL AND "title" = 'Inbox'`,
      );
      expect(Number(inboxes[0]?.count)).toBe(1);
    });

    // Fails if the resolver reads a hardcoded "Inbox" rather than the
    // resolved setting — the default-only test above cannot tell the two
    // apart, which is why this one exists.
    it("honours a configured inbox title from the settings snapshot", async () => {
      const configured = new ServiceRuntime({
        transaction: prismaTransactionRunner(prisma),
        resolveSnapshot: async () =>
          resolveSettings({
            overrides: [{ key: "items.inbox_project", value: "Capture" }],
            revision: 1n,
          }),
      });

      const task = (await configured.call("create_task", {
        ...base("Into the configured inbox", "configured-inbox"),
        projectId: "inbox",
      })) as Created;

      const parent = await prisma.$queryRawUnsafe<{ title: string }[]>(
        `SELECT "title" FROM "Item" WHERE "id" = $1`,
        task.parentId,
      );
      expect(parent[0]?.title).toBe("Capture");
    });

    // The inbox is an item, so its creation is a ledger row like any other
    // (SCHEMA.md §3). Fails if the resolver's `appendEvent` call is removed.
    it("records the inbox project's creation in the event ledger", async () => {
      const task = await call("create_task", {
        ...base("Ledger check", "inbox-ledger-area"),
        projectId: "inbox",
      });
      // A fresh scratch DB shares one "Inbox" across this file, so the
      // parent may pre-date this call — assert it has an event, not that it
      // has exactly one from this call.
      expect(await eventCount(task.parentId!)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("create_subtask", () => {
    it("creates a subtask under a task", async () => {
      const project = await call("create_project", base("Subtask project"));
      const task = await call("create_task", {
        ...base("Subtask's task"),
        projectId: project.id,
      });
      const subtask = await call("create_subtask", {
        ...base("A subtask"),
        taskId: task.id,
      });

      expect(subtask.kind).toBe("subtask");
      expect(subtask.parentId).toBe(task.id);
    });

    // SCHEMA.md §1: "depth >= 2 — nesting is unbounded, so everything deeper
    // is still a subtask". Fails if the handler pinned depth to exactly 2.
    it("nests under another subtask, still as a subtask", async () => {
      const project = await call("create_project", base("Deep project"));
      const task = await call("create_task", { ...base("Deep task"), projectId: project.id });
      const subtask = await call("create_subtask", { ...base("Level one"), taskId: task.id });
      const deeper = await call("create_subtask", { ...base("Level two"), taskId: subtask.id });

      expect(deeper.kind).toBe("subtask");
      expect(deeper.parentId).toBe(subtask.id);
    });

    // Fails if `taskId` is made optional.
    it("refuses a subtask with no taskId", async () => {
      const rejection = await rejectionOf("create_subtask", base("Parentless subtask"));
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("taskId");
    });

    it("refuses a taskId that does not exist", async () => {
      const rejection = await rejectionOf("create_subtask", {
        ...base("Pointing nowhere"),
        taskId: "no-such-task",
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toEqual(["taskId"]);
    });

    // The mirror of `create_task`'s refusal. Fails if the `depth === 1`
    // branch is removed: a subtask under a project would silently be created
    // as a task.
    it("refuses a taskId that names a project, and says what to call instead", async () => {
      const project = await call("create_project", base("Not a task"));
      const rejection = await rejectionOf("create_subtask", {
        ...base("Wrongly parented"),
        taskId: project.id,
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toEqual(["taskId"]);
      expect(rejection.message).toContain("create_task");
    });

    // `items.max_depth` is enforced in the shared insert, so it has to still
    // fire from the new operations. Fails if the guard is dropped from
    // create-core.ts, or if `create_subtask` bypassed it.
    it("refuses to create past items.max_depth", async () => {
      const shallow = new ServiceRuntime({
        transaction: prismaTransactionRunner(prisma),
        resolveSnapshot: async () =>
          resolveSettings({ overrides: [{ key: "items.max_depth", value: 1 }], revision: 1n }),
      });

      const project = (await shallow.call("create_project", base("Shallow", "shallow"))) as Created;
      const task = (await shallow.call("create_task", {
        ...base("Depth one", "shallow"),
        projectId: project.id,
      })) as Created;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const error = await (shallow.call as any)("create_subtask", {
        ...base("Depth two", "shallow"),
        taskId: task.id,
      }).catch((e: unknown) => e);
      expect((error as Rejection).code).toBe("guard_rejected");
      expect((error as Rejection).guard).toBe("items.max_depth");
    });
  });

  // MILESTONES.md #126 — `needsVisualReview` inherits from the repo unless
  // the caller says otherwise. `create_item` proved this once, against the
  // single insert it used to own; now that all four creates share
  // `insertItem` (create-core.ts), the same guarantee has to hold for each
  // of the three explicit operations too, or moving the logic into the
  // shared core silently narrowed it back to just one caller. Each case
  // asserts on the create RESPONSE, exactly as items-operations.test.ts does
  // for create_item — the defect this proves against is the response
  // staying silent about the inherited value.
  describe("needsVisualReview inheritance across the three explicit creates", () => {
    async function repoWith(id: string, needsVisualReview: boolean): Promise<void> {
      await runtime.call("create_repo", {
        id,
        displayName: id,
        defaultBranch: "main",
        needsVisualReview,
      });
    }

    it("create_project inherits true from the repo", async () => {
      await repoWith("nvr-project-true", true);
      const project = (await call("create_project", {
        ...base("Inherits true"),
        repo: "nvr-project-true",
      })) as Created & { needsVisualReview: boolean };
      expect(project.needsVisualReview).toBe(true);
    });

    it("create_project: an explicit false overrides an inherited true", async () => {
      await repoWith("nvr-project-override", true);
      const project = (await call("create_project", {
        ...base("Override false"),
        repo: "nvr-project-override",
        needsVisualReview: false,
      })) as Created & { needsVisualReview: boolean };
      expect(project.needsVisualReview).toBe(false);
    });

    it("create_task inherits true from the repo", async () => {
      await repoWith("nvr-task-true", true);
      const project = await call("create_project", base("Task's project", "nvr-task"));
      const task = (await call("create_task", {
        ...base("Inherits true", "nvr-task"),
        projectId: project.id,
        repo: "nvr-task-true",
      })) as Created & { needsVisualReview: boolean };
      expect(task.needsVisualReview).toBe(true);
    });

    it("create_task: an explicit false overrides an inherited true", async () => {
      await repoWith("nvr-task-override", true);
      const project = await call("create_project", base("Task's project 2", "nvr-task-2"));
      const task = (await call("create_task", {
        ...base("Override false", "nvr-task-2"),
        projectId: project.id,
        repo: "nvr-task-override",
        needsVisualReview: false,
      })) as Created & { needsVisualReview: boolean };
      expect(task.needsVisualReview).toBe(false);
    });

    it("create_subtask inherits true from the repo", async () => {
      await repoWith("nvr-subtask-true", true);
      const project = await call("create_project", base("Subtask's project", "nvr-subtask"));
      const task = await call("create_task", {
        ...base("Subtask's task", "nvr-subtask"),
        projectId: project.id,
      });
      const subtask = (await call("create_subtask", {
        ...base("Inherits true", "nvr-subtask"),
        taskId: task.id,
        repo: "nvr-subtask-true",
      })) as Created & { needsVisualReview: boolean };
      expect(subtask.needsVisualReview).toBe(true);
    });

    it("create_subtask: an explicit false overrides an inherited true", async () => {
      await repoWith("nvr-subtask-override", true);
      const project = await call("create_project", base("Subtask's project 2", "nvr-subtask-2"));
      const task = await call("create_task", {
        ...base("Subtask's task 2", "nvr-subtask-2"),
        projectId: project.id,
      });
      const subtask = (await call("create_subtask", {
        ...base("Override false", "nvr-subtask-2"),
        taskId: task.id,
        repo: "nvr-subtask-override",
        needsVisualReview: false,
      })) as Created & { needsVisualReview: boolean };
      expect(subtask.needsVisualReview).toBe(false);
    });

    it("create_project defaults to false with no repo at all", async () => {
      const project = (await call("create_project", base("No repo"))) as Created & {
        needsVisualReview: boolean;
      };
      expect(project.needsVisualReview).toBe(false);
    });
  });

  // #139 — `title` is normalised the same way on every write path. Proven
  // once per operation, not exhaustively per em-dash position, because the
  // normalisation itself (`normalizeEmDash`) already has its own unit
  // coverage; what matters here is that each of the three explicit creates
  // actually routes `title` through it via the shared `commonCreateShape`.
  describe("title em-dash normalisation on the three explicit creates", () => {
    it("create_project normalises an em dash in title to a hyphen", async () => {
      const project = await call("create_project", base("Fix the bug — for real this time"));
      expect(project.title).toBe("Fix the bug - for real this time");
    });

    it("create_task normalises an em dash in title to a hyphen", async () => {
      const project = await call("create_project", base("Dash task project", "nvr-dash-task"));
      const task = await call("create_task", {
        ...base("Ship it — quietly", "nvr-dash-task"),
        projectId: project.id,
      });
      expect(task.title).toBe("Ship it - quietly");
    });

    it("create_subtask normalises an em dash in title to a hyphen", async () => {
      const project = await call("create_project", base("Dash subtask project", "nvr-dash-sub"));
      const task = await call("create_task", {
        ...base("Dash subtask task", "nvr-dash-sub"),
        projectId: project.id,
      });
      const subtask = await call("create_subtask", {
        ...base("Rebase — resolve conflicts", "nvr-dash-sub"),
        taskId: task.id,
      });
      expect(subtask.title).toBe("Rebase - resolve conflicts");
    });
  });

  // The route handlers, driven directly (SCHEMA.md §22 — "call the route
  // handler directly"). They are thin shells, so what is worth proving is
  // that each shell is wired to the operation its path claims, and that a
  // rejection from the service comes back as the right status rather than as
  // a 500. A shell wired to the wrong operation is the failure a unit test
  // of the operation cannot see.
  describe("the HTTP routes", () => {
    let routes: {
      projects: typeof import("@/app/api/projects/route");
      tasks: typeof import("@/app/api/tasks/route");
      subtasks: typeof import("@/app/api/subtasks/route");
    };

    beforeAll(async () => {
      process.env.DATABASE_URL = scratchUrl;
      routes = {
        projects: await import("@/app/api/projects/route"),
        tasks: await import("@/app/api/tasks/route"),
        subtasks: await import("@/app/api/subtasks/route"),
      };
    }, 60_000);

    function post(path: string, body: unknown): Request {
      return new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("POST /api/projects creates a project", async () => {
      const response = await routes.projects.POST(
        post("/api/projects", base("Routed project", "route-area")),
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { item: Created };
      expect(payload.item.kind).toBe("project");
    });

    it("POST /api/tasks creates a task under the named project", async () => {
      const projectResponse = await routes.projects.POST(
        post("/api/projects", base("Routed task's project", "route-area")),
      );
      const project = ((await projectResponse.json()) as { item: Created }).item;

      const response = await routes.tasks.POST(
        post("/api/tasks", { ...base("Routed task", "route-area"), projectId: project.id }),
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { item: Created };
      // Fails if the tasks route were wired to `create_project` — the status
      // would still be 201 and only the kind would give it away.
      expect(payload.item.kind).toBe("task");
      expect(payload.item.parentId).toBe(project.id);
    });

    it("POST /api/subtasks creates a subtask under the named task", async () => {
      const projectResponse = await routes.projects.POST(
        post("/api/projects", base("Routed subtask's project", "route-area")),
      );
      const project = ((await projectResponse.json()) as { item: Created }).item;
      const taskResponse = await routes.tasks.POST(
        post("/api/tasks", {
          ...base("Routed subtask's task", "route-area"),
          projectId: project.id,
        }),
      );
      const task = ((await taskResponse.json()) as { item: Created }).item;

      const response = await routes.subtasks.POST(
        post("/api/subtasks", { ...base("Routed subtask", "route-area"), taskId: task.id }),
      );
      expect(response.status).toBe(201);
      expect(((await response.json()) as { item: Created }).item.kind).toBe("subtask");
    });

    // Fails if a route stopped funnelling through `serviceErrorResponse` —
    // an unmapped throw would surface as a 500, which tells a caller its
    // input was fine and the server broke.
    it("maps a missing required parent to 400, not 500", async () => {
      const response = await routes.tasks.POST(post("/api/tasks", base("No parent", "route-area")));
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("invalid_input");
    });

    it("maps an unknown parent to 404", async () => {
      const response = await routes.tasks.POST(
        post("/api/tasks", { ...base("Bad parent", "route-area"), projectId: "nope" }),
      );
      expect(response.status).toBe(404);
    });

    it("refuses a body that is not JSON at all", async () => {
      const response = await routes.projects.POST(
        new Request("http://localhost/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("create_item, deprecated", () => {
    // The compatibility promise, asserted rather than assumed. Fails if the
    // shim's parentless branch stopped producing a root.
    it("still creates a project when parentId is omitted", async () => {
      const item = await call("create_item", base("Legacy root", "legacy"));
      expect(item.kind).toBe("project");
      expect(item.parentId).toBeNull();
    });

    it("still creates a task when parentId names a project", async () => {
      const project = await call("create_item", base("Legacy project", "legacy"));
      const item = await call("create_item", {
        ...base("Legacy task", "legacy"),
        parentId: project.id,
      });
      expect(item.kind).toBe("task");
    });

    // The original rejection, unchanged — the shim must not have quietly
    // changed which field an unknown parent is blamed on.
    it("still refuses a parent that does not exist, blaming parentId", async () => {
      const rejection = await rejectionOf("create_item", {
        ...base("Legacy orphan", "legacy"),
        parentId: "no-such-item",
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toEqual(["parentId"]);
    });

    // Fails if the deprecation notice is dropped from the summary — the
    // summary is the only channel an MCP client shows a caller, so it is the
    // whole of the deprecation.
    it("says it is deprecated in the summary a client reads", async () => {
      const { OPERATION_REGISTRY } = await import("@/lib/service/registry");
      expect(OPERATION_REGISTRY.create_item.summary.toLowerCase()).toContain("deprecated");
      expect(OPERATION_REGISTRY.create_item.summary).toContain("create_task");
    });
  });
  // ── The title convention, on the way out (MILESTONES.md #131) ──────────
  //
  // The advice rides on a create that SUCCEEDED, which is the design
  // decision worth pinning: `item-title.ts` argues at length that no
  // predicate is right about every title, so the convention advises rather
  // than refuses. A test that asserted a rejection here would be asserting
  // the opposite feature.
  describe("the title convention", () => {
    // Fails if `insertItem` stops attaching the advice — the whole feature
    // reduces to a pure function nothing calls.
    it("answers a work-order title with a note, on every create surface", async () => {
      const project = await call(
        "create_project",
        base("agent-standup #102 - route writes", "titles"),
      );
      expect(project.titleAdvice).toBeDefined();
      expect(project.titleAdvice).toContain("body");

      const task = await call("create_task", {
        ...base("fix appendEvent for #102", "titles"),
        projectId: project.id,
      });
      expect(task.titleAdvice).toBeDefined();

      const subtask = await call("create_subtask", {
        ...base("patch src/lib/events", "titles"),
        taskId: task.id,
      });
      expect(subtask.titleAdvice).toBeDefined();
    });

    // The other half, and the one that keeps the feature tolerable: a good
    // title gets no key at all. Fails if the advice is attached
    // unconditionally, which would put a note on every create ever made.
    it("says nothing at all about a title that reads well", async () => {
      const item = await call(
        "create_project",
        base("Let people reset a forgotten password", "titles"),
      );
      expect(item.titleAdvice).toBeUndefined();
    });

    // The item is created either way — the advisory posture, asserted as
    // behaviour rather than as prose. Fails if the convention is ever
    // promoted to a refusal.
    it("creates the item regardless, because the judgement is the author's", async () => {
      const item = await call("create_project", base("#42", "titles"));
      expect(item.id).toBeTruthy();
      expect(item.state).toBe("on_deck");
      expect(item.title).toBe("#42");
    });

    // The convention has to be reachable by a caller, not merely enforced.
    // Fails if the rule is dropped from a create's contract, which is what
    // `describe_tool` and every refusal's pointer serve.
    it("states the convention in every create's contract", async () => {
      const { OPERATION_REGISTRY } = await import("@/lib/service/registry");
      for (const name of ["create_project", "create_task", "create_subtask", "create_item"]) {
        const rules = OPERATION_REGISTRY[name as "create_project"].contract?.rules ?? [];
        const titleRule = rules.find((rule) => rule.fields.includes("title"));
        expect(titleRule, `${name} states the title convention`).toBeDefined();
        expect(titleRule?.rule).toContain("body");
      }
    });
  });
});
