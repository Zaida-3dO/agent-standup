// `delete_item` and the reads it hides from — MILESTONES.md #137,
// SCHEMA.md §1, §23.1.
//
// Two claims are under test and they are different in kind. The first is
// about one operation: that it refuses the four ways it says it does, and
// that a caller steering toward `cancelled` is actually steered. The second
// is a claim about *every* read — that an archived row is served by none of
// them — and a claim of that shape is only worth anything if it is checked
// against each read individually. A single "list_items hides it" assertion
// would leave the board, the detail tree, the counts and the hierarchy guard
// each free to regress silently, and each of those is a separate query with
// its own `WHERE`.
//
// Every rejection case names, in a comment above it, the single source
// change that would make it pass wrongly — so a test that cannot fail is
// visible as such rather than counted as coverage.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, listOperations, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { cancellationPhraseIn } from "@/lib/service/operations/delete-item";
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
  state: string;
  archivedAt: string | null;
  archivedReason: string | null;
  supersededById: string | null;
}

/** `delete_item`'s outcome envelope — the item plus what happened to it. */
interface DeleteOutcome {
  item: Created;
  archived: boolean;
  archivedAt: string;
  archivedReason: string | null;
  supersededById: string | null;
  effect: string;
}

/** One card from `get_projects`, with the rollup numbers this file asserts on. */
interface ProjectCard {
  id: string;
  total: number;
  childless: boolean;
  counts: Record<string, number>;
}

interface Rejection {
  code: string;
  fields?: string[];
  guard?: string;
  message: string;
  details?: { references?: { kind: string; id: string; detail: string }[] };
}

// `cancellationPhraseIn` is pure text, so it is tested without a database —
// the check most likely to be quietly weakened is the one whose list of
// phrases could be emptied with nothing else failing.
describe("cancellationPhraseIn — the wording that means cancel, not remove", () => {
  // Fails if CANCELLATION_PHRASES is emptied or the `includes` is inverted.
  it.each([
    "we decided not to do this after all",
    // external-ref-ok-next-line: a sample reason the check is asked to recognise, not prose about this repository
    "this is no longer needed by the team",
    "out of scope for the current milestone",
    "deprioritised in favour of the auth work",
  ])("recognises %j as describing a cancellation", (reason) => {
    expect(cancellationPhraseIn(reason)).toBeDefined();
  });

  // Fails if the matcher is widened to something that catches honest archive
  // reasons — the false positive that would teach callers to write worse
  // reasons to get past it.
  it.each([
    "duplicate of the session-registration task, created twice by the same sweep",
    "created by accident while testing the import path",
    "an exact copy of item 42, minted by a double-submitted form",
  ])("passes %j, which describes a row that should not exist", (reason) => {
    expect(cancellationPhraseIn(reason)).toBeUndefined();
  });

  // Fails if the comparison stops lowercasing — a caller writing normal
  // sentence case would slip straight past the check.
  it("matches regardless of case", () => {
    expect(cancellationPhraseIn("We DECIDED NOT TO ship it")).toBeDefined();
  });
});

describeIfDb("delete_item", () => {
  const dbName = scratchDatabaseName("item_archive");
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

  /** A reason that clears every check, so a case shows only what it varies. */
  const GOOD_REASON = "duplicate of the import sweep task, minted twice in one run";

  function base(title: string, area = "archive") {
    return { title, body: "The brief.", area, originType: "auto" as const };
  }

  async function call<T>(name: string, input: unknown): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(name, input)) as T;
  }

  async function rejectionOf(name: string, input: unknown): Promise<Rejection> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await (runtime.call as any)(name, input).catch((e: unknown) => e);
    return error as Rejection;
  }

  /** A project with one task under it — the shape most cases need. */
  async function projectWithTask(label: string): Promise<{ projectId: string; taskId: string }> {
    const project = await call<Created>("create_project", base(`${label} project`));
    const task = await call<Created>("create_task", {
      ...base(`${label} task`),
      projectId: project.id,
    });
    return { projectId: project.id, taskId: task.id };
  }

  describe("the refusals that steer a caller toward cancel", () => {
    // Fails if `reason` loses its `.min(1)` — an empty reason would then be
    // accepted and the operation's main defence would be gone.
    it("refuses a call with no reason at all", async () => {
      const { taskId } = await projectWithTask("no-reason");
      const rejection = await rejectionOf("delete_item", { id: taskId });
      expect(rejection.code).toBe("invalid_input");
      expect(rejection.fields).toContain("reason");
    });

    // Fails if ARCHIVE_REASON_MIN_CHARS is lowered to 0 or the length check
    // is removed — "dupe" would then clear it.
    it("refuses a reason too short to name which accident", async () => {
      const { taskId } = await projectWithTask("short-reason");
      const rejection = await rejectionOf("delete_item", { id: taskId, reason: "dupe" });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.fields).toContain("reason");
    });

    // The one that actually fires in practice. Fails if the cancellation
    // check is deleted from the handler — the call would then succeed and
    // quietly remove an item that should have been cancelled.
    it("refuses a reason describing a cancellation, and names cancelled as the way out", async () => {
      const { taskId } = await projectWithTask("cancel-shaped");
      const rejection = await rejectionOf("delete_item", {
        id: taskId,
        reason: "we decided not to do this piece of work after all",
      });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.fields).toContain("reason");
      // The refusal has to name the call to make instead — a refusal that
      // only blocks costs the round trip a good one saves.
      expect(rejection.message).toContain("cancelled");
    });

    // Fails if the short-reason check is moved after the cancellation check:
    // this reason is both short AND cancellation-shaped, and a caller should
    // be told the more specific thing.
    it("leaves the item untouched when it refuses", async () => {
      const { taskId } = await projectWithTask("untouched");
      // external-ref-ok-next-line: a sample reason fed to the operation, not prose about this repository
      await rejectionOf("delete_item", { id: taskId, reason: "no longer needed at all here" });
      const after = await call<Created>("get_item", { id: taskId, full: true });
      expect(after.archivedAt).toBeNull();
      expect(after.archivedReason).toBeNull();
    });

    // Fails if the self-supersession check is dropped — the row would point
    // at itself as its own replacement, which resolves to nothing useful.
    it("refuses supersededById naming the item being removed", async () => {
      const { taskId } = await projectWithTask("self-supersede");
      const rejection = await rejectionOf("delete_item", {
        id: taskId,
        reason: GOOD_REASON,
        supersededById: taskId,
      });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.fields).toContain("supersededById");
    });

    // Fails if the replacement-exists lookup is removed — a typo'd id would
    // be written as a pointer to nothing.
    it("refuses a supersededById that names no item", async () => {
      const { taskId } = await projectWithTask("missing-supersede");
      const rejection = await rejectionOf("delete_item", {
        id: taskId,
        reason: GOOD_REASON,
        supersededById: "does-not-exist",
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toContain("supersededById");
    });

    // Fails if the id lookup is dropped from the handler.
    it("refuses an id that names no item", async () => {
      const rejection = await rejectionOf("delete_item", {
        id: "no-such-item",
        reason: GOOD_REASON,
      });
      expect(rejection.code).toBe("not_found");
      expect(rejection.fields).toContain("id");
    });
  });

  describe("inbound references are surfaced before anything is hidden", () => {
    // Fails if `inboundReferences` stops querying children, or if the
    // `references.length > 0` refusal is removed — the parent would be
    // archived and its live child left unreachable through the tree.
    it("refuses a parent with a live child, and says what points at it", async () => {
      const { projectId, taskId } = await projectWithTask("has-child");
      const rejection = await rejectionOf("delete_item", {
        id: projectId,
        reason: GOOD_REASON,
      });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.fields).toContain("acknowledgeReferences");
      // The refusal lists the reference rather than merely counting it —
      // a caller has to be able to go and look without a second call.
      expect(rejection.message).toContain(taskId);
      expect(rejection.details?.references?.[0]?.kind).toBe("child");
    });

    // Fails if `acknowledgeReferences` stops being consulted — the refusal
    // would become unconditional and the escape hatch would not exist.
    it("proceeds once the caller acknowledges them", async () => {
      const { projectId } = await projectWithTask("ack-child");
      const archived = await call<Created>("delete_item", {
        id: projectId,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });
      expect(archived.archivedAt).not.toBeNull();
    });

    // Fails if the assignment query is dropped from `inboundReferences` —
    // an item would go quiet underneath the session working it, with the
    // holder finding out only when every read started denying the row.
    it("refuses an item a session is still holding, and names the holder", async () => {
      const { taskId } = await projectWithTask("held");
      await call("claim", {
        itemId: taskId,
        sessionId: "holder-session",
        machine: "test-machine",
        role: "builder",
        holderType: "agent",
        holderId: "holder-agent",
      });

      const rejection = await rejectionOf("delete_item", { id: taskId, reason: GOOD_REASON });
      expect(rejection.code).toBe("guard_rejected");
      expect(rejection.fields).toContain("acknowledgeReferences");
      expect(rejection.message).toContain("holder-agent");
      expect(rejection.details?.references?.some((r) => r.kind === "live_claim")).toBe(true);
    });

    // A released claim is history rather than a live dependency, so it must
    // NOT be reported — otherwise every item ever worked on would refuse,
    // and `acknowledgeReferences` would become a field callers pass
    // reflexively, which is the failure that makes the guard decorative.
    it("does not count a released claim as a reference", async () => {
      const { taskId } = await projectWithTask("released");
      await call("claim", {
        itemId: taskId,
        sessionId: "past-session",
        machine: "test-machine",
        role: "builder",
        holderType: "agent",
        holderId: "past-agent",
      });
      await call("release", { itemId: taskId, sessionId: "past-session" });

      const archived = await call<Created>("delete_item", { id: taskId, reason: GOOD_REASON });
      expect(archived.archivedAt).not.toBeNull();
    });

    // Fails if the child query stops filtering on `archivedAt IS NULL` — an
    // already-archived child would keep refusing its parent's archive
    // forever, on the strength of a row nobody can see.
    it("does not count an already-archived child as a reference", async () => {
      const { projectId, taskId } = await projectWithTask("archived-child");
      await call("delete_item", { id: taskId, reason: GOOD_REASON });

      const archived = await call<Created>("delete_item", {
        id: projectId,
        reason: GOOD_REASON,
      });
      expect(archived.archivedAt).not.toBeNull();
    });
  });

  describe("what the write records", () => {
    it("stores the reason and the replacement, and never removes the row", async () => {
      const { taskId } = await projectWithTask("records");
      const replacement = await call<Created>("create_project", base("The survivor"));

      const archived = await call<Created>("delete_item", {
        id: taskId,
        reason: GOOD_REASON,
        supersededById: replacement.id,
      });

      expect(archived.archivedAt).not.toBeNull();
      expect(archived.archivedReason).toBe(GOOD_REASON);
      expect(archived.supersededById).toBe(replacement.id);

      // The whole premise: it is called delete and it never deletes. Fails
      // if the UPDATE is ever changed to a DELETE — every other assertion in
      // this file would still pass, because a deleted row is also absent
      // from every read.
      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Item" WHERE "id" = $1`,
        taskId,
      );
      expect(rows).toHaveLength(1);
    });

    // Fails if the `appendEvent` call is removed — the row would go quiet
    // with nothing in the ledger explaining why.
    it("appends an event carrying the reason", async () => {
      const { taskId } = await projectWithTask("event");
      await call("delete_item", { id: taskId, reason: GOOD_REASON });

      const rows = await prisma.$queryRawUnsafe<{ body: string | null; payload: unknown }[]>(
        `SELECT "body", "payload" FROM "Event"
         WHERE "itemId" = $1 AND "payload"->>'field' = 'archivedAt'`,
        taskId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe(GOOD_REASON);
    });

    // Fails if the already-archived early return is removed: the second call
    // would overwrite the first reason, losing why it originally happened.
    it("keeps the original reason when archived twice", async () => {
      const { taskId } = await projectWithTask("twice");
      await call("delete_item", { id: taskId, reason: GOOD_REASON });

      const second = await call<Created>("delete_item", {
        id: taskId,
        reason: "a completely different second reason for removing this",
      });
      expect(second.archivedReason).toBe(GOOD_REASON);
    });
  });

  // The response has to *say* what happened. Archiving used to hand back an
  // ordinary item whose only evidence of the archive was two changed fields
  // out of thirty, and a session reading that response reasonably concluded
  // nothing had happened — the incident this envelope exists to prevent.
  describe("the response says what happened, rather than requiring two fields to be spotted", () => {
    // Fails if `archived` is hardcoded to either constant: the fresh-archive
    // case below and the no-op case beneath it assert opposite values, so no
    // single literal satisfies both.
    it("reports archived true, and states the effect on reads in words", async () => {
      const { taskId } = await projectWithTask("legible");

      const result = await call<DeleteOutcome>("delete_item", {
        id: taskId,
        reason: GOOD_REASON,
      });

      expect(result.archived).toBe(true);
      expect(result.archivedReason).toBe(GOOD_REASON);
      expect(result.archivedAt).not.toBe("");
      // The effect names both halves of the truth — hidden from the ordinary
      // reads, still reachable by id. Fails if the sentence stops mentioning
      // either — a description that states only half of this is what teaches
      // a caller to expect the wrong thing.
      expect(result.effect).toContain("get_projects");
      expect(result.effect).toContain("get_item");
      // The full row still rides along for callers that want the record.
      expect(result.item.id).toBe(taskId);
      expect(result.item.archivedAt).not.toBeNull();
    });

    // Both calls succeed, so `archived` is the only thing telling them
    // apart. Fails if the already-archived branch stops reporting
    // `archived: false`.
    it("distinguishes a no-op second archive from the one that did the work", async () => {
      const { taskId } = await projectWithTask("noop");
      const first = await call<DeleteOutcome>("delete_item", { id: taskId, reason: GOOD_REASON });

      const second = await call<DeleteOutcome>("delete_item", {
        id: taskId,
        reason: "a completely different second reason for removing this",
      });

      expect(first.archived).toBe(true);
      expect(second.archived).toBe(false);
      // The no-op reports the ORIGINAL archive time, not this call's.
      expect(second.archivedAt).toBe(first.archivedAt);
    });

    // Fails if the replacement stops being named in the effect sentence —
    // the one thing a caller chasing a stale link most needs told.
    it("names the replacement in the effect when one was given", async () => {
      const { taskId } = await projectWithTask("superseded-effect");
      const replacement = await call<Created>("create_project", base("The survivor"));

      const result = await call<DeleteOutcome>("delete_item", {
        id: taskId,
        reason: GOOD_REASON,
        supersededById: replacement.id,
      });

      expect(result.supersededById).toBe(replacement.id);
      expect(result.effect).toContain(replacement.id);
    });
  });

  describe("an archived item is served by no ordinary read", () => {
    // Each of these is a separate query with its own WHERE clause, so each
    // is asserted separately — see this file's header. The sweep at the end
    // of this block is what makes the set complete rather than merely long.

    // Fails if NOT_ARCHIVED_CONDITION is dropped from list-items.ts.
    it("is absent from list_items", async () => {
      const { taskId } = await projectWithTask("list-hidden");
      const before = await call<{ items: { id: string }[] }>("list_items", { area: "archive" });
      expect(before.items.map((i) => i.id)).toContain(taskId);

      await call("delete_item", { id: taskId, reason: GOOD_REASON });

      const after = await call<{ items: { id: string }[] }>("list_items", { area: "archive" });
      expect(after.items.map((i) => i.id)).not.toContain(taskId);
    });

    // Fails if NOT_ARCHIVED_CONDITION is dropped from get-board.ts's
    // `shared` — this asserts the *page*.
    it("is absent from the board's entries", async () => {
      const project = await call<Created>("create_project", base("Board page", "archive-board"));
      const task = await call<Created>("create_task", {
        ...base("Board task", "archive-board"),
        projectId: project.id,
      });
      await call("delete_item", { id: task.id, reason: GOOD_REASON });

      // Every column, not only the default open slice — an archived task in
      // a column this read happened not to page would be a pass that proved
      // nothing.
      for (const column of ["backlog", "in_progress", "waiting", "completed"]) {
        const board = await call<{
          columns: Record<string, { entries: { item: { id: string } }[] }>;
        }>("get_board", { area: "archive-board", column });
        const ids = board.columns[column]!.entries.map((entry) => entry.item.id);
        expect(ids).not.toContain(task.id);
      }
    });

    // The count is a separate query from the page and would regress
    // independently. Fails if `shared` is not reused by `countWhere` — the
    // column would report a total larger than anything it can show.
    it("is not counted in a board column's total", async () => {
      const project = await call<Created>("create_project", base("Count", "archive-count"));
      const keep = await call<Created>("create_task", {
        ...base("Kept task", "archive-count"),
        projectId: project.id,
      });
      const drop = await call<Created>("create_task", {
        ...base("Dropped task", "archive-count"),
        projectId: project.id,
      });
      // Both start in the backlog column; read it explicitly so the total
      // being asserted is the one these two tasks are in.
      const before = await call<{ columns: Record<string, { total: number }> }>("get_board", {
        area: "archive-count",
        column: "backlog",
      });
      await call("delete_item", { id: drop.id, reason: GOOD_REASON });
      const after = await call<{
        columns: Record<string, { total: number; entries: { item: { id: string } }[] }>;
      }>("get_board", { area: "archive-count", column: "backlog" });

      expect(after.columns.backlog!.total).toBe(before.columns.backlog!.total - 1);
      // And the survivor is still there, so the drop is not a filter that
      // emptied the column wholesale.
      expect(after.columns.backlog!.entries.map((e) => e.item.id)).toContain(keep.id);
    });

    // Fails if either arm of get-item-detail.ts's recursive CTE loses the
    // condition.
    it("is absent from an item's subtask tree", async () => {
      const { projectId, taskId } = await projectWithTask("detail");
      await call("delete_item", { id: taskId, reason: GOOD_REASON });

      const detail = await call<{ subtasks: { id: string }[] }>("get_item_detail", {
        id: projectId,
      });
      expect(detail.subtasks.map((s) => s.id)).not.toContain(taskId);
    });

    // ── get_projects: the read the reported incident actually hit ────────
    //
    // A childless root was archived, `delete_item` reported success, and the
    // grid still showed it — because this operation's `roots` CTE had no
    // archive predicate at all. The counting half had the same hole one
    // level down, so these assert the grid and the numbers separately: a fix
    // to either alone leaves a card whose `total` disagrees with its tree.
    //
    // Fails if the predicate is dropped from the `roots` CTE in
    // get-projects.ts — the exact state of `main` before this change.
    it("is absent from the projects grid, which is where the ghost was seen", async () => {
      const project = await call<Created>("create_project", base("Ghost root", "archive-grid"));
      await call("delete_item", { id: project.id, reason: GOOD_REASON });

      const grid = await call<{ projects: ProjectCard[]; childlessCount: number }>("get_projects", {
        area: "archive-grid",
      });
      expect(grid.projects.map((p) => p.id)).not.toContain(project.id);
    });

    // `childlessCount` is the number rendered as "N with no work under
    // them", and a childless archived root is precisely the shape that was
    // reported. Fails alongside the assertion above if the roots predicate
    // is dropped.
    it("is not counted in childlessCount", async () => {
      const live = await call<Created>("create_project", base("Live root", "archive-childless"));
      const ghost = await call<Created>("create_project", base("Ghost root", "archive-childless"));
      await call("delete_item", { id: ghost.id, reason: GOOD_REASON });

      const grid = await call<{ projects: ProjectCard[]; childlessCount: number }>("get_projects", {
        area: "archive-childless",
      });
      // Exactly the one live childless root — not two.
      expect(grid.childlessCount).toBe(1);
      expect(grid.projects.map((p) => p.id)).toEqual([live.id]);
    });

    // The counting half, which the grid assertions above cannot see: the
    // project itself is live, so it is returned either way — what changes is
    // whether its archived child inflates the rollup. Fails if the
    // descendant filter is dropped from the `subtree` CTE, which would leave
    // a card counting work the installation has said should not exist.
    it("is not counted in a project's rollup total or state counts", async () => {
      const { projectId, taskId } = await (async () => {
        const project = await call<Created>("create_project", base("Rollup root", "archive-roll"));
        const task = await call<Created>("create_task", {
          ...base("Rollup child", "archive-roll"),
          projectId: project.id,
        });
        return { projectId: project.id, taskId: task.id };
      })();

      const before = await call<{ projects: ProjectCard[] }>("get_projects", {
        area: "archive-roll",
      });
      expect(before.projects[0]?.total).toBe(1);

      await call("delete_item", { id: taskId, reason: GOOD_REASON });

      const after = await call<{ projects: ProjectCard[] }>("get_projects", {
        area: "archive-roll",
      });
      const card = after.projects.find((p) => p.id === projectId);
      expect(card?.total).toBe(0);
      // The state-count columns must agree with `total` — the `count(*)
      // FILTER (...)` list is a separate mechanism from `count(d."id")`, so
      // a fix to one and not the other is a real and silent possibility.
      expect(Object.values(card?.counts ?? {}).reduce((a, b) => a + b, 0)).toBe(0);
      // Its only child is archived, so it is now structurally childless —
      // the honest report, and what makes it visible to a repair sweep.
      expect(card?.childless).toBe(true);
    });

    // The recursive arm of the `subtree` CTE, which the two-level fixture
    // above cannot reach. Its filter only ever fires on a row found by the
    // recursion rather than the seed — so it needs a live child standing
    // between the project and the archived row.
    //
    // Fails if the descendant filter is dropped from the recursive arm of
    // the `subtree` CTE in get-projects.ts (the `UNION ALL` half), which is
    // the mutant all 37 of the other tests in this file survive.
    it("does not count an archived grandchild under a live child", async () => {
      const project = await call<Created>("create_project", base("Deep root", "archive-deep"));
      const task = await call<Created>("create_task", {
        ...base("Live child", "archive-deep"),
        projectId: project.id,
      });
      const subtask = await call<Created>("create_subtask", {
        ...base("Archived grandchild", "archive-deep"),
        taskId: task.id,
      });

      const before = await call<{ projects: ProjectCard[] }>("get_projects", {
        area: "archive-deep",
      });
      expect(before.projects.find((p) => p.id === project.id)?.total).toBe(2);

      await call("delete_item", { id: subtask.id, reason: GOOD_REASON });

      const after = await call<{ projects: ProjectCard[] }>("get_projects", {
        area: "archive-deep",
      });
      const card = after.projects.find((p) => p.id === project.id);
      // The live child still counts; only the archived grandchild drops.
      // Seed-only filtering leaves this at 2, because the grandchild is
      // reached by the recursion and never passes through the seed.
      expect(card?.total).toBe(1);
      expect(Object.values(card?.counts ?? {}).reduce((a, b) => a + b, 0)).toBe(1);
      // Still has a live descendant, so it is not structurally childless.
      expect(card?.childless).toBe(false);
    });

    // The escape hatch, asserted in both halves so it cannot regress into
    // widening the grid while leaving the counts filtered (or vice versa).
    // Fails if `includeArchived` stops being threaded to either CTE.
    it("returns archived roots and archived descendants when includeArchived is passed", async () => {
      const project = await call<Created>("create_project", base("Audit root", "archive-audit"));
      const task = await call<Created>("create_task", {
        ...base("Audit child", "archive-audit"),
        projectId: project.id,
      });
      await call("delete_item", { id: task.id, reason: GOOD_REASON });

      const audited = await call<{ projects: ProjectCard[] }>("get_projects", {
        area: "archive-audit",
        includeArchived: true,
      });
      const card = audited.projects.find((p) => p.id === project.id);
      expect(card?.total).toBe(1);
      expect(card?.childless).toBe(false);

      // And the archived root itself comes back, which the default read
      // above proved it does not.
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });
      const withRoot = await call<{ projects: ProjectCard[] }>("get_projects", {
        area: "archive-audit",
        includeArchived: true,
      });
      expect(withRoot.projects.map((p) => p.id)).toContain(project.id);
    });

    // ── get_project_detail: the same leak one level down ─────────────────
    //
    // This read is in `EXEMPT` below, and correctly so — it resolves one
    // project **by id**, the same shape and reason as `get_item_detail`. But
    // the sweep's exemption is about *resolvability*, and these are about
    // *counting*: a page that resolves an archived project is right, while
    // one reporting twelve children when three are archived is not.
    //
    // Because the sweep skips this operation entirely, none of the
    // assertions below are covered by it. They are the only thing standing
    // between these four queries and a silent regression, so each one names
    // the single predicate whose removal makes it fail — and each targets a
    // *different* predicate, since a single "detail hides it" assertion
    // would let three of the four regress unnoticed.
    //
    // Fails if the descendant filter is dropped from either arm of the
    // rollup CTE in get-project-detail.ts.
    it("does not count an archived descendant in get_project_detail's rollup", async () => {
      const project = await call<Created>("create_project", base("Detail root", "archive-pd-roll"));
      const task = await call<Created>("create_task", {
        ...base("Detail child", "archive-pd-roll"),
        projectId: project.id,
      });

      const before = await call<{ total: number; counts: Record<string, number> }>(
        "get_project_detail",
        { id: project.id },
      );
      expect(before.total).toBe(1);

      await call("delete_item", { id: task.id, reason: GOOD_REASON });

      const after = await call<{
        total: number;
        childless: boolean;
        progress: number | null;
        derived: { counts: Record<string, number> };
      }>("get_project_detail", { id: project.id });
      expect(after.total).toBe(0);
      // The `count(*) FILTER (...)` columns are a separate mechanism from
      // `count(d."id")`, so a fix to one and not the other is real and
      // silent — the same pairing #241 asserts on the grid.
      expect(Object.values(after.derived.counts).reduce((a, b) => a + b, 0)).toBe(0);
      // Its only child is archived, so the project is now honestly childless
      // and `progress` is null rather than a ratio of nothing.
      expect(after.childless).toBe(true);
      expect(after.progress).toBeNull();
    });

    // The grandchild case, which the assertion above cannot see: it is what
    // separates a predicate on *both* arms from one on the seed only.
    // Archiving the middle child must remove the grandchild from the count
    // too, because the recursion should never descend through an archived
    // row. Fails if the filter is dropped from the recursive arm alone.
    it("does not count the children of an archived child in get_project_detail", async () => {
      const project = await call<Created>("create_project", base("Deep root", "archive-pd-deep"));
      const middle = await call<Created>("create_task", {
        ...base("Deep middle", "archive-pd-deep"),
        projectId: project.id,
      });
      await call<Created>("create_subtask", {
        ...base("Deep leaf", "archive-pd-deep"),
        taskId: middle.id,
      });

      const before = await call<{ total: number }>("get_project_detail", { id: project.id });
      expect(before.total).toBe(2);

      await call("delete_item", {
        id: middle.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });

      // Both the archived child AND its surviving leaf are gone from the
      // count: the leaf is only reachable through an archived parent, so a
      // walk that still descends through it reports 1 here.
      const after = await call<{ total: number }>("get_project_detail", { id: project.id });
      expect(after.total).toBe(0);
    });

    // The recursive arm of the rollup, isolated from its seed.
    //
    // The grandchild case above archives the *middle* row, which the seed
    // predicate alone already stops the walk at — so it does not distinguish
    // the two arms, and the recursive one could be dropped with every
    // assertion so far still green (confirmed by running that mutant). Here
    // the archived row is the **grandchild**, reached through a live child:
    // the seed never sees it, so only the recursive arm's predicate can
    // exclude it. Fails if that arm loses the filter.
    it("does not count an archived grandchild reached through a live child", async () => {
      const project = await call<Created>("create_project", base("Arm root", "archive-pd-arm"));
      const child = await call<Created>("create_task", {
        ...base("Arm child", "archive-pd-arm"),
        projectId: project.id,
      });
      const grandchild = await call<Created>("create_subtask", {
        ...base("Arm grandchild", "archive-pd-arm"),
        taskId: child.id,
      });

      const before = await call<{ total: number }>("get_project_detail", { id: project.id });
      expect(before.total).toBe(2);

      await call("delete_item", { id: grandchild.id, reason: GOOD_REASON });

      // The live child remains counted; only the archived grandchild goes.
      const after = await call<{ total: number }>("get_project_detail", { id: project.id });
      expect(after.total).toBe(1);
    });

    // The children *list* is a second statement with its own `WHERE`, so it
    // regresses independently of the rollup above. Fails if `childFilter` is
    // dropped from the direct-child SELECT in get-project-detail.ts.
    it("does not list an archived direct child in get_project_detail's children", async () => {
      const project = await call<Created>("create_project", base("List root", "archive-pd-list"));
      const keep = await call<Created>("create_task", {
        ...base("List keeper", "archive-pd-list"),
        projectId: project.id,
      });
      const ghost = await call<Created>("create_task", {
        ...base("List ghost", "archive-pd-list"),
        projectId: project.id,
      });
      await call("delete_item", { id: ghost.id, reason: GOOD_REASON });

      const detail = await call<{ children: { id: string }[] }>("get_project_detail", {
        id: project.id,
      });
      const ids = detail.children.map((c) => c.id);
      expect(ids).not.toContain(ghost.id);
      // The survivor is still listed, so this is a predicate and not a
      // filter that emptied the list wholesale.
      expect(ids).toContain(keep.id);
    });

    // A child's own `total`/`merged` come from the `descendants` CTE, which
    // is a third mechanism again — the row stays listed while its numbers go
    // wrong. Fails if the filter is dropped from either arm of that CTE.
    it("does not inflate a listed child's own subtree count in get_project_detail", async () => {
      const project = await call<Created>("create_project", base("Nest root", "archive-pd-nest"));
      const child = await call<Created>("create_task", {
        ...base("Nest child", "archive-pd-nest"),
        projectId: project.id,
      });
      const grandchild = await call<Created>("create_subtask", {
        ...base("Nest grandchild", "archive-pd-nest"),
        taskId: child.id,
      });

      const before = await call<{ children: { id: string; total: number }[] }>(
        "get_project_detail",
        { id: project.id },
      );
      expect(before.children.find((c) => c.id === child.id)?.total).toBe(1);

      await call("delete_item", { id: grandchild.id, reason: GOOD_REASON });

      const after = await call<{ children: { id: string; total: number }[] }>(
        "get_project_detail",
        { id: project.id },
      );
      // The child is still listed — only its rolled-up count changes.
      expect(after.children.map((c) => c.id)).toContain(child.id);
      expect(after.children.find((c) => c.id === child.id)?.total).toBe(0);
    });

    // The recursive arm of the per-child `descendants` CTE, isolated from
    // its seed for the same reason as the rollup arm above: the test before
    // this one archives a row the seed already excludes, so the recursive
    // arm could be dropped and stay green. Here the archived row sits one
    // level deeper again — a great-grandchild of the project, reached
    // through a live grandchild — so only the recursive arm can exclude it.
    // Fails if that arm loses the filter.
    it("does not inflate a child's subtree count via an archived great-grandchild", async () => {
      const project = await call<Created>("create_project", base("Deep arm", "archive-pd-deeparm"));
      const child = await call<Created>("create_task", {
        ...base("Deep arm child", "archive-pd-deeparm"),
        projectId: project.id,
      });
      const grandchild = await call<Created>("create_subtask", {
        ...base("Deep arm grandchild", "archive-pd-deeparm"),
        taskId: child.id,
      });
      const greatGrandchild = await call<Created>("create_subtask", {
        ...base("Deep arm great-grandchild", "archive-pd-deeparm"),
        taskId: grandchild.id,
      });

      const before = await call<{ children: { id: string; total: number }[] }>(
        "get_project_detail",
        { id: project.id },
      );
      expect(before.children.find((c) => c.id === child.id)?.total).toBe(2);

      await call("delete_item", { id: greatGrandchild.id, reason: GOOD_REASON });

      const after = await call<{ children: { id: string; total: number }[] }>(
        "get_project_detail",
        { id: project.id },
      );
      // The live grandchild is still counted; only the archived row below it
      // is gone — 1, not 2 and not 0.
      expect(after.children.find((c) => c.id === child.id)?.total).toBe(1);
    });

    // The activity feed is a fifth statement, and the only one whose seed is
    // deliberately left unfiltered — it is seeded with the project's OWN row
    // (`"id" = $1`), so filtering it would stop an archived project's feed
    // resolving, which is the by-id guarantee this read keeps. Its recursive
    // arm is filtered, so a descendant's events drop out. Fails if that arm
    // loses the filter.
    it("does not report an archived descendant's events in the activity feed", async () => {
      const project = await call<Created>("create_project", base("Feed root", "archive-pd-feed"));
      const task = await call<Created>("create_task", {
        ...base("Feed child", "archive-pd-feed"),
        projectId: project.id,
      });
      // A note gives the child an event of its own that is unmistakably
      // attributable — the creation event alone would also work, but this
      // makes what is being excluded explicit.
      await call("note", { itemId: task.id, body: "an event on a row about to be archived" });

      const before = await call<{ activity: { itemId: string }[] }>("get_project_detail", {
        id: project.id,
        activityLimit: 200,
      });
      expect(before.activity.map((a) => a.itemId)).toContain(task.id);

      await call("delete_item", { id: task.id, reason: GOOD_REASON });

      const after = await call<{ activity: { itemId: string }[] }>("get_project_detail", {
        id: project.id,
        activityLimit: 200,
      });
      expect(after.activity.map((a) => a.itemId)).not.toContain(task.id);
      // The project's own events are still there — the seed is unfiltered,
      // so this is a predicate on descendants and not a feed that emptied.
      expect(after.activity.map((a) => a.itemId)).toContain(project.id);
    });

    // `blockedChildren` is the question the page is opened to answer, and it
    // is a fourth statement with its own `WHERE`. An archived blocked row is
    // the worst one to show: it sends a reader to chase work the
    // installation has said should not exist. Fails if `blockedFilter` is
    // dropped from the blocked-descendant query.
    it("does not report an archived descendant as a blocked child", async () => {
      const project = await call<Created>("create_project", base("Block root", "archive-pd-block"));
      const task = await call<Created>("create_task", {
        ...base("Block child", "archive-pd-block"),
        projectId: project.id,
      });
      await call("transition_item", {
        id: task.id,
        to: "blocked",
        fields: {
          blocked_reason: "waiting on an upstream decision that never arrived",
          blocked_on_type: "external_process",
        },
      });

      const before = await call<{ blockedChildren: { id: string }[] }>("get_project_detail", {
        id: project.id,
      });
      expect(before.blockedChildren.map((b) => b.id)).toContain(task.id);

      await call("delete_item", { id: task.id, reason: GOOD_REASON });

      const after = await call<{ blockedChildren: { id: string }[] }>("get_project_detail", {
        id: project.id,
      });
      expect(after.blockedChildren.map((b) => b.id)).not.toContain(task.id);
    });

    // The recursive arm of the blocked walk, isolated from its seed — the
    // third and last arm needing its own case, for the reason the two above
    // do: the test before this archives a *direct* child, which the seed
    // already excludes, so the recursive arm could be dropped and stay
    // green. Here the archived blocked row is a **grandchild** under a live
    // child, so only the recursive arm can exclude it. Fails if that arm
    // loses the filter.
    it("does not report an archived blocked grandchild under a live child", async () => {
      const project = await call<Created>(
        "create_project",
        base("Deep block", "archive-pd-dblock"),
      );
      const child = await call<Created>("create_task", {
        ...base("Deep block child", "archive-pd-dblock"),
        projectId: project.id,
      });
      const grandchild = await call<Created>("create_subtask", {
        ...base("Deep block grandchild", "archive-pd-dblock"),
        taskId: child.id,
      });
      await call("transition_item", {
        id: grandchild.id,
        to: "blocked",
        fields: {
          blocked_reason: "waiting on an upstream decision that never arrived",
          blocked_on_type: "external_process",
        },
      });

      const before = await call<{ blockedChildren: { id: string }[] }>("get_project_detail", {
        id: project.id,
      });
      expect(before.blockedChildren.map((b) => b.id)).toContain(grandchild.id);

      await call("delete_item", { id: grandchild.id, reason: GOOD_REASON });

      const after = await call<{ blockedChildren: { id: string }[] }>("get_project_detail", {
        id: project.id,
      });
      expect(after.blockedChildren.map((b) => b.id)).not.toContain(grandchild.id);
    });

    // The escape hatch, asserted on the list and the counts together so it
    // cannot regress into widening one while leaving the other filtered.
    // Fails if `includeArchived` stops being threaded to the CTEs.
    it("returns archived descendants from get_project_detail when includeArchived is passed", async () => {
      const project = await call<Created>("create_project", base("Audit root", "archive-pd-audit"));
      const task = await call<Created>("create_task", {
        ...base("Audit child", "archive-pd-audit"),
        projectId: project.id,
      });
      await call("delete_item", { id: task.id, reason: GOOD_REASON });

      const audited = await call<{
        total: number;
        childless: boolean;
        children: { id: string }[];
      }>("get_project_detail", { id: project.id, includeArchived: true });
      expect(audited.total).toBe(1);
      expect(audited.childless).toBe(false);
      expect(audited.children.map((c) => c.id)).toContain(task.id);
    });

    // The counterpart to the `get_item` assertion below, and the reason this
    // read is exempt from the sweep: the aggregates are filtered, but the
    // project itself must still resolve by id. Fails if a
    // `NOT_ARCHIVED_CONDITION` is ever added to the top-level lookup in
    // get-project-detail.ts — the one change this row explicitly must not
    // make.
    it("still resolves an archived project by id, which is why it is sweep-exempt", async () => {
      const project = await call<Created>("create_project", base("Gone root", "archive-pd-byid"));
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });

      const detail = await call<{ project: { id: string } }>("get_project_detail", {
        id: project.id,
      });
      expect(detail.project.id).toBe(project.id);
    });

    // `get_item` by id is the deliberate exception, and it is asserted
    // rather than left implied: the row is kept so that a stale link still
    // resolves, and a read that refused would defeat the reason for keeping
    // it. Fails if a `NOT_ARCHIVED_CONDITION` is added to get-item.ts.
    it("is still reachable by get_item, which is how a stale link resolves", async () => {
      const { taskId } = await projectWithTask("by-id");
      await call("delete_item", { id: taskId, reason: GOOD_REASON });

      const item = await call<Created>("get_item", { id: taskId, full: true });
      expect(item.id).toBe(taskId);
      expect(item.archivedAt).not.toBeNull();
      expect(item.archivedReason).toBe(GOOD_REASON);
    });
    // The test that makes the claim structural rather than a list.
    //
    // Every assertion above names one read, which certifies exactly the
    // reads somebody thought to name — and a read added later inherits
    // nothing from them. That is the gap this file's own header warns
    // about ("a check written against a fixed set of known shapes can only
    // certify the absence of those shapes"), applied to itself: the reads
    // are enumerated from the operation registry, so a new one that serves
    // archived rows fails here on the day it is written rather than on the
    // day somebody notices a ghost on their board.
    //
    // Reads are driven with the arguments each needs, and a read this sweep
    // cannot construct arguments for is **refused rather than skipped** —
    // silently passing over an operation is exactly how a gap survives a
    // green run. `get_item` is the one deliberate exemption, named with its
    // reason, because resolving an archived item by id is the behaviour that
    // makes keeping the row worth anything.
    it("is absent from every registered read, enumerated from the registry", async () => {
      const project = await call<Created>("create_project", base("Sweep root", "archive-sweep"));
      const task = await call<Created>("create_task", {
        ...base("Sweep ghost zebrafish", "archive-sweep"),
        projectId: project.id,
      });
      // Claimed before archiving, so the assignment-shaped reads
      // (`my_work`, `progress_report`) have something to return and are
      // genuinely exercised rather than trivially empty.
      await call("claim", {
        itemId: task.id,
        sessionId: "sweep-session",
        machine: "test-machine",
        role: "builder",
        holderType: "agent",
        holderId: "sweep-agent",
      });
      await call("delete_item", {
        id: task.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });

      // The deliberate exemptions, each named with its reason rather than
      // left out of `argsFor` — a read omitted quietly is indistinguishable
      // from one nobody thought about, which is the failure mode this sweep
      // exists to close.
      //
      //   - `get_item` / `get_item_detail` resolve an archived item **by
      //     id**, asserted directly above. That is the behaviour that makes
      //     keeping the row worth anything: a stale link still lands
      //     somewhere real and finds the replacement.
      //   - `get_events` reads the append-only ledger, which is history
      //     rather than an item read. An archived item's events stay
      //     readable on purpose — the row is withheld from item reads, not
      //     erased from history — and the archive event itself, carrying the
      //     reason, is the single most useful row in it.
      //   - `describe_tool` describes operations and ranges over no items at
      //     all.
      //   - `get_account` reads one row of the `Account` table by id. Like
      //     `describe_tool` it ranges over no items, so there is nothing
      //     here for it to leak. Named rather than skipped — it was found by
      //     the `toBeDefined` guard below the moment that guard replaced a
      //     silent `continue`.
      //   - `get_account`, `get_area`, `get_machine`, `get_repo`,
      //     `get_setting` each read one row of their own table by id, and
      //     `readiness`, `get_session_shape`, `hook_decision`, `kill_guard`
      //     and `get_costs` range over sessions, processes and run totals.
      //     None of them return items at all, so — like `describe_tool` —
      //     there is nothing here for them to leak.
      //   - `get_project_detail` resolves one project **by id**, the same
      //     shape and the same reason as `get_item_detail` beside it.
      //
      // Membership here is a claim that has to be argued, not a way to make
      // the sweep quiet: the guard below refuses any read that is neither
      // exempt nor given arguments, so the cost of adding a name is writing
      // the reason above it.
      const EXEMPT = new Set([
        "get_item",
        "get_item_detail",
        "get_project_detail",
        "get_events",
        "describe_tool",
        "get_account",
        "get_area",
        "get_machine",
        "get_repo",
        "get_setting",
        "get_costs",
        "get_session_shape",
        "hook_decision",
        "kill_guard",
        "readiness",
        // Resolves one open loop by `loopId`, not an item — the same by-id
        // shape as the detail reads above. `loop_list`, which does range
        // over an item's loops, is swept rather than exempted.
        "loop_get",
        // Aggregates intervention firings per catalogue entry. It ranges
        // over `intervention_events` and `intervention_scores` and returns
        // counts keyed by entry id — the same "ranges over no items" reason
        // as `get_costs` beside it. `item_id` is recorded on a firing, but
        // it is never selected, joined to `Item`, or used to narrow the
        // report: an entry's score is a fact about the guard, not about the
        // work that happened to be in play when it fired. So an archived
        // item cannot leak through it, and — the direction that would
        // matter more — an archived item's firings must still count toward
        // its entry's score, because the guard fired and was rated whatever
        // later became of the row.
        "get_intervention_scores",
      ]);

      // Arguments per read. A read absent from this map fails the guard
      // below rather than being skipped.
      const argsFor: Record<string, unknown> = {
        list_items: { area: "archive-sweep", includeTerminal: true },
        get_board: { area: "archive-sweep", includeTerminal: true },
        search: { query: "zebrafish" },
        my_work: { sessionId: "sweep-session" },
        orientation: { itemId: project.id },
        progress_report: { sessionId: "sweep-session", includeCompleted: true },
        repair_stuck_projects: { projectId: "inbox", area: "archive-sweep", apply: false },
        get_projects: { area: "archive-sweep", includeCompleted: true },
        // Range over items rather than their own tables, so they are swept
        // rather than exempted. `get_fleet` returns live assignments — the
        // archived task here was deliberately claimed before archiving, so
        // this is a real check and not a trivially empty one.
        get_fleet: {},
        loop_list: { itemId: project.id },
        list_areas: {},
        list_repos: {},
        list_people: {},
        list_machines: {},
        list_processes: {},
        list_accounts: {},
        get_settings: {},
        service_info: {},
      };

      // Registered `read` operations, plus the writes whose *response* still
      // ranges over items. `repair_stuck_projects` is declared a write
      // because it can reparent, but its dry run returns a list of items and
      // its live run acts on that same list — so a leak there is worse than
      // a read's, not exempt from being one.
      const reads = listOperations().filter(
        (operation) => operation.kind === "read" || operation.name === "repair_stuck_projects",
      );
      const swept: string[] = [];
      for (const operation of reads) {
        if (EXEMPT.has(operation.name)) continue;
        const args = argsFor[operation.name];
        // **A read absent from `argsFor` fails here rather than being
        // skipped**, which is what makes this sweep a completeness check
        // rather than a long list. Skipping an unmapped read is
        // indistinguishable, in a green run, from checking it and finding
        // it clean — so a read serving archived rows could sit behind a
        // passing test indefinitely purely by never being added to the map.
        // Failing here means a new read is checked on the day it is
        // written.
        expect(
          args,
          `${operation.name} is a read with no arguments in argsFor, so the archive sweep never checked it — add it to the map, or to EXEMPT with a reason`,
        ).toBeDefined();
        // A refusal fails the sweep rather than passing it. An operation
        // given arguments it rejects returns nothing, and "nothing" trivially
        // does not contain the archived id — so a wrong argument here would
        // read as a read that was checked and found clean, which is the
        // worst possible failure mode for a test whose whole job is
        // completeness.
        const outcome = await call<unknown>(operation.name, args).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        expect(
          "error" in outcome ? String((outcome.error as Error)?.message) : null,
          `${operation.name} refused the sweep's arguments, so it was not actually checked`,
        ).toBeNull();
        // Serialised whole: a leak is the archived id appearing anywhere in
        // the response, at any depth, in any field.
        expect(
          JSON.stringify((outcome as { value: unknown }).value),
          `${operation.name} served the archived item`,
        ).not.toContain(task.id);
        swept.push(operation.name);
      }

      // The reads that actually range over items. Named explicitly so that
      // dropping one from `argsFor` — the easy way to make this test pass by
      // covering less — fails instead of silently shrinking the sweep.
      for (const name of [
        "list_items",
        "get_board",
        "search",
        "my_work",
        "orientation",
        "progress_report",
        "repair_stuck_projects",
      ]) {
        expect(swept, `${name} was not swept`).toContain(name);
      }
    });
  });

  describe("an archived child does not hold its parent open", () => {
    // The hierarchy guard is not a read, but it asks the same question, and
    // getting it wrong is the worst outcome in this change: a parent that
    // can never be completed, citing a child nobody can see or move.
    //
    // Fails if NOT_ARCHIVED_CONDITION is dropped from hierarchy.ts —
    // `hasActionableChild` would return true forever.
    it("lets a task complete when its only remaining subtask is archived", async () => {
      const project = await call<Created>("create_project", base("Parent", "archive-guard"));
      const task = await call<Created>("create_task", {
        ...base("Parent task", "archive-guard"),
        projectId: project.id,
      });
      const subtask = await call<Created>("create_subtask", {
        ...base("Ghost subtask", "archive-guard"),
        taskId: task.id,
      });

      // With the subtask live, finishing the parent is refused — this half
      // proves the guard is actually running, so the half below is not
      // passing merely because nothing was checked.
      const blocked = await rejectionOf("transition_item", {
        id: task.id,
        to: "cancelled",
        fields: {
          summary: {
            // A cancellation asserts that nothing was delivered, so it
            // carries a decision rather than a list of outcomes — writing
            // "nothing shipped" into `shipped` would be putting a
            // non-delivery in the field that means the opposite.
            shipped: [],
            decision: "Superseded by the replacement task, so this one is not worth finishing.",
            not_done: [],
            user_facing: false,
            how_verified: "Checked the item tree by hand before cancelling.",
            watch_for: [],
          },
        },
      });
      expect(blocked.code).toBe("guard_rejected");

      await call("delete_item", { id: subtask.id, reason: GOOD_REASON });

      const done = await call<{ item: Created }>("transition_item", {
        id: task.id,
        to: "cancelled",
        fields: {
          summary: {
            // A cancellation asserts that nothing was delivered, so it
            // carries a decision rather than a list of outcomes — writing
            // "nothing shipped" into `shipped` would be putting a
            // non-delivery in the field that means the opposite.
            shipped: [],
            decision: "Superseded by the replacement task, so this one is not worth finishing.",
            not_done: [],
            user_facing: false,
            how_verified: "Checked the item tree by hand before cancelling.",
            watch_for: [],
          },
        },
      });
      expect(done.item.state).toBe("cancelled");
    });
  });
});
