// `restore_item` — the inverse `delete_item` never had.
//
// Two claims are under test, and the second is the one worth the file.
//
// The first is that a restore works: `archivedAt` and `archivedReason` are
// cleared, the row comes back to every ordinary read, and the item lands in
// the state it held when it was archived rather than being moved.
//
// The second is that it **refuses to resurrect a row into a tree that cannot
// hold it**. That is where a restore can quietly do damage: an item put back
// under an archived parent, or into an archived area, is live in the database
// and invisible in the product — worse than staying archived, because
// nothing then reports it as either.
//
// Every rejection case names, in a comment above it, the single source change
// that would make it pass wrongly — so a test that cannot fail is visible as
// such rather than counted as coverage.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  RESTORE_CONTEXT_GUARD,
  RESTORE_SUPERSEDED_GUARD,
} from "@/lib/service/operations/restore-item";
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

interface RestoreOutcome {
  item: Created;
  restored: boolean;
  clearedReason: string | null;
  effect: string;
}

interface Rejection {
  code: string;
  fields?: string[];
  guard?: string;
  message: string;
  details?: { blockers?: string[]; supersededById?: string };
}

describeIfDb("restore_item", () => {
  const dbName = scratchDatabaseName("item_restore");
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

  const GOOD_REASON = "duplicate of the import sweep task, minted twice in one run";

  function base(title: string, area = "restore") {
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

  /** An archived task, which is what most cases start from. */
  async function archivedTask(
    label: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ projectId: string; taskId: string }> {
    const project = await call<Created>("create_project", base(`${label} project`));
    const task = await call<Created>("create_task", {
      ...base(`${label} task`),
      projectId: project.id,
    });
    await call("delete_item", {
      id: task.id,
      reason: GOOD_REASON,
      acknowledgeReferences: true,
      ...extra,
    });
    return { projectId: project.id, taskId: task.id };
  }

  describe("what the write does", () => {
    // Fails if the UPDATE stops setting `archivedAt` to NULL — the single
    // thing this operation exists to do.
    it("clears archivedAt, so the row is live again", async () => {
      const { taskId } = await archivedTask("clears");

      const outcome = await call<RestoreOutcome>("restore_item", { id: taskId });

      expect(outcome.restored).toBe(true);
      expect(outcome.item.archivedAt).toBeNull();
    });

    // Fails if the UPDATE clears `archivedAt` but leaves `archivedReason`
    // behind, which would leave the row live and still carrying a
    // justification for being hidden — visibly contradictory to anyone
    // reading it.
    it("clears archivedReason too", async () => {
      const { taskId } = await archivedTask("clears reason");

      const outcome = await call<RestoreOutcome>("restore_item", { id: taskId });

      expect(outcome.item.archivedReason).toBeNull();
      // ...and returns it, so a caller can say what it undid.
      expect(outcome.clearedReason).toBe(GOOD_REASON);
    });

    // Fails if the row is read back through a path that special-cases
    // archived rows. Asserted against the DATABASE rather than the response,
    // because the response is built by the same code under test: an
    // operation that returned a well-formed record while writing nothing
    // would satisfy every assertion above and fail this one.
    it("really writes it, as seen from outside the operation", async () => {
      const { taskId } = await archivedTask("persisted");

      await call("restore_item", { id: taskId });

      const rows = await prisma.$queryRawUnsafe<
        { archivedAt: Date | null; archivedReason: string | null }[]
      >(`SELECT "archivedAt", "archivedReason" FROM "Item" WHERE "id" = $1`, taskId);
      expect(rows[0]!.archivedAt).toBeNull();
      expect(rows[0]!.archivedReason).toBeNull();
    });

    // Fails if a restore is implemented as a transition to some default
    // state. The item is moved to `executing` before archiving, so a restore
    // that reset it to `on_deck` — the state a fresh task starts in, and the
    // most likely wrong answer — is caught. This is the assertion behind
    // modelling the undo step as a restore rather than a transition.
    it("leaves the item in the state it held when it was archived", async () => {
      const project = await call<Created>("create_project", base("state project"));
      const task = await call<Created>("create_task", {
        ...base("state task"),
        projectId: project.id,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "state" = 'executing'::"ItemState" WHERE "id" = $1`,
        task.id,
      );
      await call("delete_item", { id: task.id, reason: GOOD_REASON, acknowledgeReferences: true });

      const outcome = await call<RestoreOutcome>("restore_item", { id: task.id });

      expect(outcome.item.state).toBe("executing");
    });

    // Fails if the event append is dropped, or if it records the restore as
    // an archive. The ledger is how "why is this row back" is answerable
    // later, and it is the half most easily forgotten because nothing else
    // reads it.
    it("appends an event recording the restore", async () => {
      const { taskId } = await archivedTask("event");

      await call("restore_item", { id: taskId });

      const events = await prisma.$queryRawUnsafe<{ type: string; payload: unknown }[]>(
        `SELECT "type", "payload" FROM "Event" WHERE "itemId" = $1 ORDER BY "ts" DESC, "id" DESC LIMIT 1`,
        taskId,
      );
      const payload = events[0]!.payload as {
        field: string;
        from: unknown;
        to: unknown;
        clearedReason: string | null;
      };
      expect(events[0]!.type).toBe("field_change");
      expect(payload.field).toBe("archivedAt");
      // Directional, not merely present: an event saying the row was
      // archived would be worse than none, and swapping these two is the
      // most plausible way to get it wrong.
      expect(payload.from).toBe("archived");
      expect(payload.to).toBeNull();
      expect(payload.clearedReason).toBe(GOOD_REASON);
    });
  });

  describe("restoring something that is not archived", () => {
    // Fails if the not-archived branch throws instead of reporting. A
    // refusal here would turn a second undo press — or any retry — into an
    // error a person has to interpret, for an outcome already achieved.
    it("is not an error, and reports that it did nothing", async () => {
      const project = await call<Created>("create_project", base("live project"));

      const outcome = await call<RestoreOutcome>("restore_item", { id: project.id });

      expect(outcome.restored).toBe(false);
      expect(outcome.item.archivedAt).toBeNull();
    });

    // Fails if `restored` is hardcoded true, which every assertion above
    // would still pass. The two calls differ only in that the first did the
    // work, and that difference has to show.
    it("distinguishes the call that did the work from the one that found it done", async () => {
      const { taskId } = await archivedTask("second call");

      const first = await call<RestoreOutcome>("restore_item", { id: taskId });
      const second = await call<RestoreOutcome>("restore_item", { id: taskId });

      expect(first.restored).toBe(true);
      expect(second.restored).toBe(false);
    });

    // Fails if the no-op branch appends an event anyway, which would make
    // the ledger narrate a restore that did not happen — the same class of
    // defect `inverseOf` refuses a no-op move for.
    it("writes no event when there was nothing to restore", async () => {
      const { taskId } = await archivedTask("no second event");
      await call("restore_item", { id: taskId });
      const before = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*) AS "count" FROM "Event" WHERE "itemId" = $1`,
        taskId,
      );

      await call("restore_item", { id: taskId });

      const after = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*) AS "count" FROM "Event" WHERE "itemId" = $1`,
        taskId,
      );
      expect(after[0]!.count).toBe(before[0]!.count);
    });

    // Fails if the id lookup stops throwing — restoring a row that does not
    // exist must not be quietly reported as a successful no-op, which is
    // exactly what the "already live" branch above would do to it.
    it("refuses an id that names no item", async () => {
      const rejection = await rejectionOf("restore_item", { id: "no-such-item" });

      expect(rejection.code).toBe("not_found");
    });
  });

  describe("a superseded row is a different act, and is refused by default", () => {
    async function supersededPair(label: string) {
      const project = await call<Created>("create_project", base(`${label} project`));
      const survivor = await call<Created>("create_task", {
        ...base(`${label} survivor`),
        projectId: project.id,
      });
      const duplicate = await call<Created>("create_task", {
        ...base(`${label} duplicate`),
        projectId: project.id,
      });
      await call("delete_item", {
        id: duplicate.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
        supersededById: survivor.id,
      });
      return { survivorId: survivor.id, duplicateId: duplicate.id };
    }

    // Fails if the supersededById check is dropped, or if
    // `acknowledgeSuperseded` defaults to true. Either would let a caller
    // silently put a second row for the same work back on the board — the
    // duplicate the archive was used to resolve.
    it("refuses a row that was archived in favour of another", async () => {
      const { duplicateId } = await supersededPair("refuses");

      const rejection = await rejectionOf("restore_item", { id: duplicateId });

      expect(rejection.guard).toBe(RESTORE_SUPERSEDED_GUARD);
    });

    // Fails if the message stops naming the replacement. A caller deciding
    // whether to override needs the id of the row that took the work up, or
    // the refusal tells them to make a judgement without showing them what
    // to judge it against.
    it("names the replacement, so the caller can go and look at it", async () => {
      const { survivorId, duplicateId } = await supersededPair("names");

      const rejection = await rejectionOf("restore_item", { id: duplicateId });

      expect(rejection.message).toContain(survivorId);
      expect(rejection.details?.supersededById).toBe(survivorId);
    });

    // Fails if the refusal is implemented as a hard block. Superseding is a
    // judgement, and judgements are sometimes wrong; a person who has looked
    // at both rows must not have to reach for SQL.
    it("restores it when the caller acknowledges the supersede", async () => {
      const { duplicateId } = await supersededPair("acknowledged");

      const outcome = await call<RestoreOutcome>("restore_item", {
        id: duplicateId,
        acknowledgeSuperseded: true,
      });

      expect(outcome.restored).toBe(true);
      expect(outcome.item.archivedAt).toBeNull();
    });

    // Fails if the restore clears `supersededById` along with the archive
    // fields. It records a judgement that WAS made, and the caller said the
    // rows are different work — not that nobody ever decided otherwise.
    // Clearing it would erase the only durable trace of why the row was
    // archived.
    it("keeps supersededById, because the judgement was still made", async () => {
      const { survivorId, duplicateId } = await supersededPair("keeps pointer");

      const outcome = await call<RestoreOutcome>("restore_item", {
        id: duplicateId,
        acknowledgeSuperseded: true,
      });

      expect(outcome.item.supersededById).toBe(survivorId);
    });

    // Fails if the flag is read as a general override that also waives the
    // tree guards below. The two refusals answer different questions — "did
    // you mean to" versus "can this row exist here" — and one acknowledgement
    // must not silence the other.
    it("does not waive the archived-parent guard as well", async () => {
      const project = await call<Created>("create_project", base("both project"));
      const survivor = await call<Created>("create_task", {
        ...base("both survivor"),
        projectId: project.id,
      });
      const duplicate = await call<Created>("create_task", {
        ...base("both duplicate"),
        projectId: project.id,
      });
      await call("delete_item", {
        id: duplicate.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
        supersededById: survivor.id,
      });
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });

      const rejection = await rejectionOf("restore_item", {
        id: duplicate.id,
        acknowledgeSuperseded: true,
      });

      expect(rejection.guard).toBe(RESTORE_CONTEXT_GUARD);
    });
  });

  describe("it refuses to resurrect a row into a tree that cannot hold it", () => {
    // Fails if the parent check is dropped. A row restored under an archived
    // parent is live in the database and reachable by no ordinary read,
    // because every hierarchy read stops at the archived parent — worse than
    // staying archived, since nothing reports it as either.
    it("refuses when the parent is itself archived", async () => {
      const project = await call<Created>("create_project", base("archived parent project"));
      const task = await call<Created>("create_task", {
        ...base("archived parent task"),
        projectId: project.id,
      });
      await call("delete_item", { id: task.id, reason: GOOD_REASON, acknowledgeReferences: true });
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });

      const rejection = await rejectionOf("restore_item", { id: task.id });

      expect(rejection.guard).toBe(RESTORE_CONTEXT_GUARD);
      // Says what to do about it, rather than only that it refused.
      expect(rejection.message).toContain("restore the parent first");
    });

    // Fails if the guard is written to refuse whenever a parent EXISTS
    // rather than when it is archived — which would refuse almost every
    // restore and would still pass the case above.
    it("allows it when the parent is live", async () => {
      const { taskId } = await archivedTask("live parent");

      const outcome = await call<RestoreOutcome>("restore_item", { id: taskId });

      expect(outcome.restored).toBe(true);
    });

    // Fails if the parent join is an INNER JOIN, which would return no rows
    // for a top-level project and make every such restore look like a
    // missing item. `parentId` is genuinely null for a project.
    it("allows a top-level project, which has no parent at all", async () => {
      const project = await call<Created>("create_project", base("top level"));
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });

      const outcome = await call<RestoreOutcome>("restore_item", { id: project.id });

      expect(outcome.restored).toBe(true);
      expect(outcome.item.archivedAt).toBeNull();
    });

    // Fails if the area check is dropped. `reparent-core.ts` already refuses
    // a move into an archived area for the same reason, and a restore is the
    // same act by another name: it puts a row somewhere and the row has to
    // be visible when it lands.
    it("refuses when the item's area has since been archived", async () => {
      const project = await call<Created>("create_project", base("area project", "doomed-area"));
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "Area" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        "doomed-area",
      );

      const rejection = await rejectionOf("restore_item", { id: project.id });

      expect(rejection.guard).toBe(RESTORE_CONTEXT_GUARD);
      expect(rejection.message).toContain("doomed-area");
    });

    // Fails if the repo check is dropped, or if it fires on a null repo.
    it("refuses when the item's repo has since been archived", async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Repo" ("id", "displayName") VALUES ($1, $2)`,
        "doomed-repo",
        "Doomed repo",
      );
      const project = await call<Created>("create_project", {
        ...base("repo project"),
        repo: "doomed-repo",
      });
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "Repo" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        "doomed-repo",
      );

      const rejection = await rejectionOf("restore_item", { id: project.id });

      expect(rejection.guard).toBe(RESTORE_CONTEXT_GUARD);
      expect(rejection.message).toContain("doomed-repo");
    });

    // Fails if the repo condition is widened from `&&` to `||`, which would
    // refuse every item that merely HAS a repo — the archived-repo case
    // above passes either way, so without this the operator is unpinned.
    it("allows it when the repo is live", async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Repo" ("id", "displayName") VALUES ($1, $2)`,
        "live-repo",
        "Live repo",
      );
      const project = await call<Created>("create_project", {
        ...base("live repo project"),
        repo: "live-repo",
      });
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });

      const outcome = await call<RestoreOutcome>("restore_item", { id: project.id });

      expect(outcome.restored).toBe(true);
    });

    // The same pinning for the parent condition: `&&` widened to `||` would
    // refuse a top-level project, whose `parentId` is null and whose
    // `parentArchivedAt` is therefore null too. Distinct from the top-level
    // case above, which exercises the JOIN rather than the operator.
    it("allows a live child whose area and repo are also live", async () => {
      const { taskId } = await archivedTask("all live");

      const outcome = await call<RestoreOutcome>("restore_item", { id: taskId });

      expect(outcome.restored).toBe(true);
      expect(outcome.item.archivedAt).toBeNull();
    });

    // Fails if the guards throw on the first blocker they find. A caller
    // sent round the loop once per broken reference has to discover the
    // second problem only after fixing the first, which is the failure mode
    // collecting them exists to avoid.
    it("names every blocker at once, not just the first", async () => {
      const project = await call<Created>("create_project", base("multi project", "multi-area"));
      const task = await call<Created>("create_task", {
        ...base("multi task", "multi-area"),
        projectId: project.id,
      });
      await call("delete_item", { id: task.id, reason: GOOD_REASON, acknowledgeReferences: true });
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "Area" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        "multi-area",
      );

      const rejection = await rejectionOf("restore_item", { id: task.id });

      expect(rejection.details?.blockers).toHaveLength(2);
      expect(rejection.message).toContain(project.id);
      expect(rejection.message).toContain("multi-area");
    });

    // Fails if a refused restore writes anyway — a guard that reports a
    // refusal while the UPDATE has already run is worse than no guard, and
    // nothing above would catch it.
    it("leaves the row archived when it refuses", async () => {
      const project = await call<Created>("create_project", base("untouched project"));
      const task = await call<Created>("create_task", {
        ...base("untouched task"),
        projectId: project.id,
      });
      await call("delete_item", { id: task.id, reason: GOOD_REASON, acknowledgeReferences: true });
      await call("delete_item", {
        id: project.id,
        reason: GOOD_REASON,
        acknowledgeReferences: true,
      });

      await rejectionOf("restore_item", { id: task.id });

      const rows = await prisma.$queryRawUnsafe<{ archivedAt: Date | null }[]>(
        `SELECT "archivedAt" FROM "Item" WHERE "id" = $1`,
        task.id,
      );
      expect(rows[0]!.archivedAt).not.toBeNull();
    });
  });

  describe("the row is served by ordinary reads again", () => {
    // The claim that makes a restore worth anything. `delete_item`'s own
    // sweep asserts an archived row is absent from every read; this asserts
    // the round trip, which is the property a person actually cares about —
    // they want the row BACK, not merely un-flagged.
    it("reappears in list_items after being absent", async () => {
      const project = await call<Created>("create_project", base("round trip", "round-trip"));
      const task = await call<Created>("create_task", {
        ...base("round trip ghost", "round-trip"),
        projectId: project.id,
      });

      await call("delete_item", { id: task.id, reason: GOOD_REASON, acknowledgeReferences: true });
      const whileArchived = await call<{ items: { id: string }[] }>("list_items", {
        area: "round-trip",
        includeTerminal: true,
      });
      // The premise: it really was hidden. Without this the test would pass
      // against an operation that never archived anything.
      expect(whileArchived.items.map((item) => item.id)).not.toContain(task.id);

      await call("restore_item", { id: task.id });
      const afterRestore = await call<{ items: { id: string }[] }>("list_items", {
        area: "round-trip",
        includeTerminal: true,
      });
      expect(afterRestore.items.map((item) => item.id)).toContain(task.id);
    });

    // The same round trip through the projects grid, which is where the
    // original ghost was seen and which counts rather than lists.
    it("is counted again in the projects grid", async () => {
      const project = await call<Created>("create_project", base("counted", "counted-area"));
      const task = await call<Created>("create_task", {
        ...base("counted task", "counted-area"),
        projectId: project.id,
      });
      await call("delete_item", { id: task.id, reason: GOOD_REASON, acknowledgeReferences: true });

      const whileArchived = await call<{ projects: { id: string; total: number }[] }>(
        "get_projects",
        { area: "counted-area", includeCompleted: true },
      );
      expect(whileArchived.projects.find((card) => card.id === project.id)?.total).toBe(0);

      await call("restore_item", { id: task.id });

      const afterRestore = await call<{ projects: { id: string; total: number }[] }>(
        "get_projects",
        { area: "counted-area", includeCompleted: true },
      );
      expect(afterRestore.projects.find((card) => card.id === project.id)?.total).toBe(1);
    });
  });
});
