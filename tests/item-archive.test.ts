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
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
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

  describe("an archived item is served by no ordinary read", () => {
    // Each of these is a separate query with its own WHERE clause, so each
    // is asserted separately — see this file's header.

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
            shipped: ["Nothing shipped."],
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
            shipped: ["Nothing shipped."],
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
