// Build status end to end: recorded through `record_artifact`, read back
// through `get_item_detail`.
//
// The fold's own logic is pinned in `build-status-fold.test.ts` without a
// database. What can only be settled against a real Postgres is everything
// this file is about: that `check_run` is a value the `ArtifactKind` enum
// actually accepts (an enum cast fails only against a real server, and is
// invisible to both typecheck and lint), that the write guards refuse what
// they claim to, and that the tip the fold is handed is the tip the merge
// gate would compute — including across a supersession, which is a query, not
// a pure function.
//
// The claim that matters most is the last block: asking about the item
// answers the question. A crew that reads an item detail learns whether its
// pull request is passing without leaving the board, which is the whole point
// of the work.
//
// Skips without TEST_DATABASE_URL, the same convention as every other
// DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import type { ItemDetailOutput } from "@/lib/service/operations/get-item-detail";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ServiceError {
  code: string;
  fields?: string[];
}

describeIfDb("build status on an item's detail, against Postgres", () => {
  const dbName = scratchDatabaseName("build_status");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
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

  afterEach(async () => {
    await prisma.artifact.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(): Promise<string> {
    taskCounter += 1;
    const id = `task-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${taskCounter}`,
        body: "body",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

  async function record(input: Record<string, unknown>) {
    return runtime.call("record_artifact", {
      createdByType: "agent",
      createdById: "agent-a",
      ...input,
    });
  }

  async function recordFails(input: Record<string, unknown>): Promise<ServiceError> {
    return (await runtime
      .call("record_artifact", { createdByType: "agent", createdById: "agent-a", ...input })
      .then(() => {
        throw new Error("expected record_artifact to reject, but it resolved");
      })
      .catch((error: unknown) => error)) as ServiceError;
  }

  async function detail(id: string): Promise<ItemDetailOutput> {
    return runtime.call("get_item_detail", { id }) as Promise<ItemDetailOutput>;
  }

  const TIP = "a".repeat(40);

  describe("recording one", () => {
    it("accepts check_run as an artifact kind and stores its status", async () => {
      // The enum cast. If `check_run` were missing from the database's
      // `ArtifactKind` type — a schema edit without the migration, or the
      // reverse — this write fails here and nowhere else: typecheck and lint
      // both pass on a value the server will refuse.
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "check_run",
        body: "passing",
        ref: "https://build.example/runs/1",
        commitSha: TIP,
      });

      const stored = await prisma.artifact.findUnique({ where: { id: artifact.id } });
      expect(stored?.kind).toBe("check_run");
      expect(stored?.body).toBe("passing");
      expect(stored?.commitSha).toBe(TIP);
    });

    it("refuses a status this vocabulary does not know", async () => {
      // Refused rather than coerced: a caller writing a build service's own
      // word would otherwise get a row that reads as nothing at all, silently,
      // having been told the write succeeded.
      const itemId = await createTask();
      for (const body of ["success", "green", "PASSING", "passed", "flaky"]) {
        const error = await recordFails({ itemId, kind: "check_run", body });
        expect(error.code, body).toBe("invalid_input");
        expect(error.fields, body).toContain("body");
      }
    });

    it("refuses a check_run with no status at all", async () => {
      // Required, unlike a pull request's status. A build row that will not
      // say how the build went records nothing — it is the state this kind
      // exists to end, written under its own name.
      const itemId = await createTask();
      const error = await recordFails({ itemId, kind: "check_run", body: null });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("body");
    });

    it("refuses a build URL that is not a plain web address", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "check_run",
        body: "passing",
        ref: "javascript:alert(1)",
      });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("ref");
    });

    it("accepts a build reported with no URL, since the status is the answer", async () => {
      // A local run or a script reading an exit code has no URL to record.
      // Refusing it would push exactly those callers back to recording
      // nothing, which is the behaviour this whole row exists to end.
      const itemId = await createTask();
      const artifact = await record({ itemId, kind: "check_run", body: "failing" });
      expect(artifact.kind).toBe("check_run");
    });
  });

  describe("reading it back on the item's detail", () => {
    it("reports nothing when no build was ever reported", async () => {
      // The read must not invent a status for the majority of items, which
      // have never reported one.
      const itemId = await createTask();
      expect((await detail(itemId)).buildStatus).toBeNull();
    });

    it("still returns the item when no build was reported", async () => {
      // Never block on it. A missing build status must cost nothing — the
      // detail read is the most-used read in the product and an item's own
      // fields must come back regardless.
      const itemId = await createTask();
      const payload = await detail(itemId);
      expect(payload.item.id).toBe(itemId);
      expect(payload.artifacts).toEqual([]);
    });

    it("answers is-it-passing from the item alone", async () => {
      // THE claim. A crew asks about the item and learns whether its pull
      // request is passing, without leaving the board.
      const itemId = await createTask();
      await record({ itemId, kind: "commit", commitSha: TIP });
      await record({
        itemId,
        kind: "pull_request",
        body: "open",
        ref: "https://forge.example/pr/1",
      });
      await record({
        itemId,
        kind: "check_run",
        body: "passing",
        ref: "https://build.example/runs/1",
        commitSha: TIP,
      });

      const build = (await detail(itemId)).buildStatus;
      expect(build?.status).toBe("passing");
      expect(build?.atTip).toBe(true);
      expect(build?.url).toBe("https://build.example/runs/1");
      // The age is a real elapsed time computed from the stored row, not a
      // constant: it must be small for a row written moments ago, and it must
      // exist at all.
      expect(build?.ageSeconds).toBeGreaterThanOrEqual(0);
      expect(build?.ageSeconds).toBeLessThan(120);
      expect(typeof build?.recordedAt).toBe("string");
    });

    it("reports the newest status when a build has changed", async () => {
      // Append-only: pending → passing is two rows, and the answer is the
      // second. Recorded in sequence so the ordering the read applies is the
      // ordering the rows were written in.
      const itemId = await createTask();
      await record({ itemId, kind: "check_run", body: "pending", commitSha: TIP });
      await record({ itemId, kind: "check_run", body: "passing", commitSha: TIP });

      expect((await detail(itemId)).buildStatus?.status).toBe("passing");
    });

    it("reports a green build against a superseded commit as not at tip", async () => {
      // The dangerous row, through the real tip query. The build passed, and
      // it passed against code the item has moved past — so the status is
      // reported and `atTip` is what says not to merge on it.
      const itemId = await createTask();
      const oldSha = "b".repeat(40);
      await record({ itemId, kind: "commit", commitSha: oldSha });
      await record({ itemId, kind: "check_run", body: "passing", commitSha: oldSha });
      // A newer commit moves the tip past the one the build ran against.
      await record({ itemId, kind: "commit", commitSha: TIP });

      const build = (await detail(itemId)).buildStatus;
      expect(build?.status).toBe("passing");
      expect(build?.atTip).toBe(false);
    });

    it("carries a build forward onto a commit that superseded the one it ran against", async () => {
      // A squash mints a sha nobody built. The recorded supersession link is
      // what carries the build onto it — the same rule the merge gate applies
      // to an approval, so the two cannot disagree about what "at tip" means.
      // This is a query over the lineage chain, which is why it is here and
      // not in the pure fold test.
      const itemId = await createTask();
      const branchSha = "c".repeat(40);
      await record({ itemId, kind: "commit", commitSha: branchSha });
      await record({ itemId, kind: "check_run", body: "passing", commitSha: branchSha });
      await record({
        itemId,
        kind: "commit",
        commitSha: TIP,
        supersedesSha: branchSha,
      });

      const build = (await detail(itemId)).buildStatus;
      expect(build?.status).toBe("passing");
      expect(build?.atTip).toBe(true);
    });

    it("reports at-tip as unknown when the item has recorded no commit", async () => {
      // Null, not false. Nothing has been committed, so there is no tip for
      // the build to be stale against, and reporting `false` here would flag
      // a perfectly current build as stale.
      const itemId = await createTask();
      await record({ itemId, kind: "check_run", body: "passing", commitSha: TIP });

      const build = (await detail(itemId)).buildStatus;
      expect(build?.status).toBe("passing");
      expect(build?.atTip).toBeNull();
    });

    it("reports at-tip as unknown when the build recorded no commit", async () => {
      const itemId = await createTask();
      await record({ itemId, kind: "commit", commitSha: TIP });
      await record({ itemId, kind: "check_run", body: "failing" });

      const build = (await detail(itemId)).buildStatus;
      expect(build?.status).toBe("failing");
      expect(build?.atTip).toBeNull();
    });

    it("reports a failing build as failing", async () => {
      // The other direction of the headline claim: a red build must be
      // legible as red. A failing build and a missing approval are different
      // reasons to refuse a merge, and this is the one that names the build.
      const itemId = await createTask();
      await record({ itemId, kind: "commit", commitSha: TIP });
      await record({
        itemId,
        kind: "check_run",
        body: "failing",
        commitSha: TIP,
        ref: "https://build.example/runs/9",
      });

      const build = (await detail(itemId)).buildStatus;
      expect(build?.status).toBe("failing");
      expect(build?.atTip).toBe(true);
      expect(build?.url).toBe("https://build.example/runs/9");
    });

    it("reports a build still running rather than leaving it absent", async () => {
      // `pending` is the state polling exists to escape: a crew reading it
      // knows a build is in flight, rather than that none was ever started.
      const itemId = await createTask();
      await record({ itemId, kind: "check_run", body: "pending", commitSha: TIP });
      expect((await detail(itemId)).buildStatus?.status).toBe("pending");
    });

    it("ignores artifacts of other kinds when deciding the status", async () => {
      // An item with a PR and a review has reported no build. If the kind
      // filter were dropped, one of these rows would be folded as a build
      // status — reported as unknown, on an item that never mentioned a build.
      const itemId = await createTask();
      await record({ itemId, kind: "commit", commitSha: TIP });
      await record({
        itemId,
        kind: "pull_request",
        body: "open",
        ref: "https://forge.example/pr/2",
      });
      await record({ itemId, kind: "code_review", verdict: "lgtm", commitSha: TIP });

      expect((await detail(itemId)).buildStatus).toBeNull();
    });
  });
});
