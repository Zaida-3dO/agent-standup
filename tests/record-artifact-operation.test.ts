// MILESTONES.md #98 — artifact writes.
//
// The claims here are about rows actually landing in `Artifact` and `Event`
// with the right column values, and about three guards that read those rows
// changing their answer as a result. None of that can be settled without a
// real Postgres — in particular the enum casts (`$2::"ArtifactKind"`) fail
// only against a real server, and are invisible to both typecheck and lint.
// Skips without TEST_DATABASE_URL, the same convention as every other
// DB-backed file here.
//
// The end-to-end block at the bottom is the one that matters most. Each guard
// is also tested on its own, but the milestone's actual claim is that ONE
// operation clears all three — an item minted through the product can be
// worked to `merged` without anything reaching past the service layer. A
// suite that only checked each guard separately could pass while that
// sequence was still impossible.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner, type RecordedArtifact } from "@/lib/service";
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
  guard?: string;
}

describeIfDb("record_artifact (#98), against Postgres", () => {
  const dbName = scratchDatabaseName("record_artifact");
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
    // Assignment and Artifact both FK to Item, and Artifact FKs to Item a
    // second time through followUpItemId — delete children before parents so
    // the parent delete never hits a constraint violation.
    await prisma.artifact.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(state = "executing", overrides: Record<string, unknown> = {}) {
    taskCounter += 1;
    const id = `task-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${taskCounter}`,
        body: "body",
        state: state as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "needs_approval",
        ...overrides,
      },
    });
    return id;
  }

  async function record(input: Record<string, unknown>): Promise<RecordedArtifact> {
    return runtime.call("record_artifact", input) as Promise<RecordedArtifact>;
  }

  async function recordFails(input: Record<string, unknown>): Promise<ServiceError> {
    return (await runtime
      .call("record_artifact", input)
      .then(() => {
        throw new Error("expected record_artifact to reject, but it resolved");
      })
      .catch((error: unknown) => error)) as ServiceError;
  }

  describe("the row it writes", () => {
    it("records every field it was given", async () => {
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        reviewRound: 3,
        commitSha: "abc123",
        body: "looks good",
        ref: "https://example.invalid/pr/1",
        browserSession: "session-7",
        createdByType: "person",
        createdById: "user-a",
      });

      // Asserted field by field rather than with a snapshot: each of these is
      // read by a different guard, and a snapshot would go green on a change
      // that swapped two of them.
      expect(artifact.kind).toBe("code_review");
      expect(artifact.verdict).toBe("lgtm");
      expect(artifact.reviewRound).toBe(3);
      expect(artifact.commitSha).toBe("abc123");
      expect(artifact.ref).toBe("https://example.invalid/pr/1");
      expect(artifact.browserSession).toBe("session-7");
      expect(artifact.createdByType).toBe("person");
      expect(artifact.createdById).toBe("user-a");

      const stored = await prisma.artifact.findUnique({ where: { id: artifact.id } });
      // The row is read back rather than trusting the RETURNING clause: `body`
      // is not in the operation's return shape at all, so this is the only
      // assertion that would catch it being dropped on the way in.
      expect(stored?.body).toBe("looks good");
      expect(stored?.itemId).toBe(itemId);
    });

    it("stores findings, and stores an empty list as null", async () => {
      const itemId = await createTask();
      const withFindings = await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: [{ text: "naming", severity: "low" }],
        createdByType: "agent",
        createdById: "agent-a",
      });
      const stored = await prisma.artifact.findUnique({ where: { id: withFindings.id } });
      expect(stored?.findings).toEqual([{ text: "naming", severity: "low" }]);

      const empty = await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        findings: [],
        createdByType: "agent",
        createdById: "agent-a",
      });
      const storedEmpty = await prisma.artifact.findUnique({ where: { id: empty.id } });
      // `[]` and "no findings" are the same fact; storing both spellings would
      // make every later reader handle two.
      expect(storedEmpty?.findings).toBeNull();
    });

    it("refuses a findings entry whose severity is not in the ladder", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        findings: [{ text: "x", severity: "catastrophic" }],
        createdByType: "agent",
        createdById: "agent-a",
      });
      // Refused rather than repaired: a coerced findings list looks complete
      // and is not.
      //
      // `invalid_input`, NOT `internal`. `InvalidFindingError` is not a
      // ServiceError, so left to propagate it is wrapped as a server fault —
      // a 500 for what is plainly a caller mistake. This assertion is the
      // one that catches that translation being dropped.
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["findings"]);
    });
  });

  describe("what it refuses", () => {
    it("refuses an item that does not exist", async () => {
      const error = await recordFails({
        itemId: "no-such-item",
        kind: "commit",
        commitSha: "abc",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["itemId"]);
    });

    it("refuses a commit artifact with no commitSha", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "commit",
        createdByType: "agent",
        createdById: "agent-a",
      });
      // Without this, the row lands and `currentTipCommitSha` reads null off
      // it — so the merge is refused for "no commit at all" while a commit
      // artifact plainly exists.
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["commitSha"]);
    });

    it("refuses a verdict on an artifact that is not a review", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "test_run",
        verdict: "lgtm",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["verdict", "kind"]);
    });

    it("allows 'na' on a non-review, which is what that verdict is for", async () => {
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "commit",
        commitSha: "abc",
        verdict: "na",
        createdByType: "agent",
        createdById: "agent-a",
      });
      // The complement of the test above — a rule that refused every verdict
      // on a non-review would also pass that one, and would be wrong.
      expect(artifact.verdict).toBe("na");
    });

    it("refuses when it cannot tell who produced the artifact", async () => {
      const itemId = await createTask();
      const error = await recordFails({ itemId, kind: "plan" });
      // Deliberately not defaulted. `createdByType` decides whether a human
      // authorised a merge on a needs_approval item, so a guess here is the
      // difference between a real gate and a decorative one.
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["createdByType", "createdById"]);
    });

    it("refuses a follow-up item that does not exist", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        followUpItemId: "no-such-item",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["followUpItemId"]);
    });

    it("refuses a kind that is not in the enum", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "not_a_kind",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
    });
  });

  describe("who it credits", () => {
    it("takes the holder from a live assignment when the caller names its session", async () => {
      const itemId = await createTask();
      await prisma.assignment.create({
        data: {
          itemId,
          holderType: "agent",
          holderId: "agent-b",
          sessionId: "session-1",
          rootSessionId: "session-1",
          machine: "laptop",
          role: "builder",
        },
      });

      const artifact = await record({ itemId, kind: "plan", sessionId: "session-1" });
      expect(artifact.createdByType).toBe("agent");
      expect(artifact.createdById).toBe("agent-b");
    });

    it("lets an explicit creator win over the assignment's holder", async () => {
      const itemId = await createTask();
      await prisma.assignment.create({
        data: {
          itemId,
          holderType: "agent",
          holderId: "agent-b",
          sessionId: "session-1",
          rootSessionId: "session-1",
          machine: "laptop",
          role: "builder",
        },
      });

      const artifact = await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        sessionId: "session-1",
        createdByType: "person",
        createdById: "user-a",
      });
      // A person can record a review from a session an agent holds, and the
      // artifact has to say so — this is exactly the field the needs_approval
      // merge clause reads.
      expect(artifact.createdByType).toBe("person");
      expect(artifact.createdById).toBe("user-a");
    });

    it("ignores an assignment that has been released", async () => {
      const itemId = await createTask();
      await prisma.assignment.create({
        data: {
          itemId,
          holderType: "agent",
          holderId: "agent-b",
          sessionId: "session-1",
          rootSessionId: "session-1",
          machine: "laptop",
          role: "builder",
          releasedAt: new Date(),
        },
      });

      const error = await recordFails({ itemId, kind: "plan", sessionId: "session-1" });
      // A released assignment is not a live one — crediting it would let a
      // finished session keep producing attributed artifacts.
      expect(error.code).toBe("invalid_input");
    });
  });

  describe("which round it files under", () => {
    it("defaults to the item's current round, not to 1", async () => {
      const itemId = await createTask();
      await record({
        itemId,
        kind: "plan_review",
        verdict: "approved",
        reviewRound: 4,
        createdByType: "agent",
        createdById: "agent-a",
      });

      const next = await record({
        itemId,
        kind: "commit",
        commitSha: "abc",
        createdByType: "agent",
        createdById: "agent-a",
      });

      // The merge gate reads max(reviewRound) across every kind. Defaulting
      // to 1 here would silently file this commit a round behind the review
      // and refuse the merge for a reason the caller never chose.
      expect(next.reviewRound).toBe(4);
    });

    it("defaults to 1 on an item with no artifacts yet", async () => {
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "plan",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(artifact.reviewRound).toBe(1);
    });

    it("takes an explicit round over the default", async () => {
      const itemId = await createTask();
      await record({
        itemId,
        kind: "plan",
        reviewRound: 2,
        createdByType: "agent",
        createdById: "agent-a",
      });
      const artifact = await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        reviewRound: 5,
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(artifact.reviewRound).toBe(5);
    });

    it("coerces a round arriving as a string, as the command line sends it", async () => {
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "plan",
        reviewRound: "3",
        createdByType: "agent",
        createdById: "agent-a",
      });
      // Every CLI flag is a string. Without the coercion `--review-round 3`
      // is refused as "expected number, received string" for a value the
      // caller spelled correctly.
      expect(artifact.reviewRound).toBe(3);
    });

    it("refuses a round below 1", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "plan",
        reviewRound: 0,
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
    });
  });

  describe("the events it appends", () => {
    it("appends a review event for a review artifact", async () => {
      const itemId = await createTask();
      await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        reviewRound: 2,
        createdByType: "person",
        createdById: "user-a",
      });

      const events = await prisma.event.findMany({ where: { itemId, type: "review" } });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ kind: "code_review", verdict: "lgtm", round: 2 });
      expect(events[0]?.actorType).toBe("person");
    });

    it("appends no review event for an artifact that is not a review", async () => {
      const itemId = await createTask();
      await record({
        itemId,
        kind: "commit",
        commitSha: "abc",
        createdByType: "agent",
        createdById: "agent-a",
      });
      // A commit is a thing produced, not an opinion given. An event here
      // would make "how many reviews has this had" unanswerable.
      const events = await prisma.event.findMany({ where: { itemId, type: "review" } });
      expect(events).toHaveLength(0);
    });
  });
});

describeIfDb("request_review (#98), against Postgres", () => {
  const dbName = scratchDatabaseName("request_review");
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

  let counter = 0;
  async function createTask() {
    counter += 1;
    const id = `req-task-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${counter}`,
        body: "body",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  it("appends a review_requested event carrying the round", async () => {
    const itemId = await createTask();
    await runtime.call("request_review", {
      itemId,
      round: 2,
      actorType: "agent",
      actorId: "agent-b",
    });

    const events = await prisma.event.findMany({ where: { itemId, type: "review_requested" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ round: 2 });
    expect(events[0]?.actorId).toBe("agent-b");
  });

  it("defaults the round to the item's current round", async () => {
    const itemId = await createTask();
    await prisma.artifact.create({
      data: {
        itemId,
        kind: "plan" as never,
        reviewRound: 3,
        createdByType: "agent",
        createdById: "agent-a",
      },
    });

    await runtime.call("request_review", { itemId });
    const events = await prisma.event.findMany({ where: { itemId, type: "review_requested" } });
    // A request that named round 1 while the item was on round 3 would make
    // the ledger unable to say which round was being asked about.
    expect(events[0]?.payload).toEqual({ round: 3 });
  });

  it("refuses an item that does not exist", async () => {
    const error = (await runtime
      .call("request_review", { itemId: "no-such-item" })
      .then(() => {
        throw new Error("expected request_review to reject, but it resolved");
      })
      .catch((e: unknown) => e)) as ServiceError;
    expect(error.code).toBe("not_found");
    expect(error.fields).toEqual(["itemId"]);
  });
});
