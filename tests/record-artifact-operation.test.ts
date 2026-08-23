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
    // `record_artifact` refuses a `createdByType: "person"` whose id names
    // nobody (#134), so the person these fixtures credit has to exist.
    await prisma.person.create({ data: { id: "user-a", displayName: "User A" } });
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
      // `invalid_input`, NOT `internal`. An off-ladder severity is plainly a
      // caller mistake, and reporting it as a server fault would answer a
      // fixable input with a 500. This assertion is the load-bearing one:
      // both the schema and `parseFindings` reject this value, and whichever
      // gets there first must produce a caller error.
      expect(error.code).toBe("invalid_input");

      // The field path points AT the offending value — `findings.0.severity`,
      // not the whole `findings` field. With `findings` typed as an array of
      // objects, the schema rejects the bad enum member before the handler
      // runs and names the exact path, which is strictly more useful on a
      // fifty-entry list than naming the field as a whole. The prefix is what
      // matters, so this does not pin the separator style.
      const fields = error.fields ?? [];
      expect(fields).toHaveLength(1);
      expect(fields[0]).toMatch(/^findings/);
      expect(fields[0]).toContain("severity");
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

    // #138 — a `historical_verification` closes an item on an inspection of
    // merged code rather than on a review. Its whole claim to being an
    // acceptable substitute is that the claim is CHECKABLE, which means the
    // evidence is mandatory rather than conventional.
    it("refuses a historical_verification with no commitSha", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "historical_verification",
        body: "I looked at it and it seemed fine.",
        createdByType: "agent",
        createdById: "agent-a",
      });
      // An inspection that does not name the code it read cannot be
      // confirmed or refuted by the next person to look — which would make
      // it exactly the unfalsifiable approval this kind exists to replace.
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["commitSha"]);
    });

    it("refuses a historical_verification with no body", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "historical_verification",
        commitSha: "abc123",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["body"]);
    });

    it("refuses a historical_verification whose body is only whitespace", async () => {
      // A blank string satisfies "a body was supplied" while recording
      // nothing, which is the same as recording nothing.
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "   \n  ",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["body"]);
    });

    // #236 — a `merge_override` is a reasoned decision to merge WITHOUT the
    // approving review the gate requires. Its entire claim to being an
    // audited escape hatch rather than a silent bypass is that the reason is
    // mandatory and durable, so the reason is enforced at the WRITE: a row
    // asserting an override that could never have qualified should not
    // exist, because a later reader counts it as an override.
    it("refuses a merge_override with no commitSha", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "merge_override",
        body: "Nothing material changed since the review; docs only.",
        createdByType: "agent",
        createdById: "agent-a",
      });
      // An override is a judgement about one specific state of the code. An
      // unpinned one would be standing permission to skip review.
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["commitSha"]);
    });

    it("refuses a merge_override with no body — the stated reason is the whole point", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "merge_override",
        commitSha: "abc123",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["body"]);
    });

    it("refuses a merge_override whose body is only whitespace", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "merge_override",
        commitSha: "abc123",
        body: "   \n  ",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["body"]);
    });

    it("refuses a merge_override whose reason is too short to say anything", async () => {
      // A mandatory field satisfiable by "ok" is an optional field with extra
      // keystrokes. The floor is crude and does not pretend to detect a
      // considered reason — it removes the dismissal, which is the shape a
      // required field collapses into when nothing checks its content.
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "merge_override",
        commitSha: "abc123",
        body: "fine",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["body"]);
      // The refusal says the actual length and the required one, so the
      // caller does not have to guess how much more is wanted.
      const text = (error as unknown as Error).message;
      expect(text).toContain("4 characters");
      expect(text).toContain("20");
    });

    it("accepts a merge_override carrying a commit and a real reason, and never as a review", async () => {
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "merge_override",
        commitSha: "abc123",
        body: "Rebased onto main after approval; no source changes since the review.",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(artifact.kind).toBe("merge_override");
      // No verdict, so nothing counting approvals can ever count this. The
      // separate kind is what makes overriding countable rather than
      // indistinguishable from an ordinary approval.
      expect(artifact.verdict).toBeNull();
      // Attribution is recorded, which is what makes "who overrode this"
      // answerable after the fact.
      expect(artifact.createdByType).toBe("agent");
      expect(artifact.createdById).toBe("agent-a");
    });

    it("records supersedesSha on a commit artifact, which is what carries an approval across a squash", async () => {
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "commit",
        commitSha: "97837fa",
        supersedesSha: "e993415",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(artifact.commitSha).toBe("97837fa");
      expect(artifact.supersedesSha).toBe("e993415");
    });

    it("leaves supersedesSha null when not supplied — nothing widens implicitly", async () => {
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "commit",
        commitSha: "plain11",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(artifact.supersedesSha).toBeNull();
    });

    it("accepts a historical_verification carrying both, and stores it as its own kind — never as a review", async () => {
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "Read the merged code at abc123: the routes named in the brief are absent.",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(artifact.kind).toBe("historical_verification");
      // No verdict, because it is not a review and has no judgement to give.
      // This is what stops a reader — human or query — from ever counting it
      // as an approval.
      expect(artifact.verdict).toBeNull();
    });

    it("refuses a verdict on a historical_verification — it is not a review and must never read as one", async () => {
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected",
        verdict: "lgtm",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["verdict", "kind"]);
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

    it("refuses a person id that names nobody", async () => {
      // **`merge.requires_authorisation` reads `created_by_type` to decide
      // whether a *human* authorised a merge on a `needs_approval` item.** So
      // an id naming nobody is not a cosmetic problem: it satisfies the one
      // clause that exists to require a person, with a person who does not
      // exist. Accepted before this check (#134).
      const itemId = await createTask();
      const error = await recordFails({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        createdByType: "person",
        createdById: "nobody-at-all",
      });

      // `not_found` specifically, and naming the field — the same answer
      // `create_item` already gives for `originPersonId`, so the two
      // operations agree about whether a person reference must resolve.
      expect(error.code).toBe("not_found");
      expect(error.fields).toContain("createdById");
    });

    it("still accepts a person id that names a real person", async () => {
      // The negative control, and the assertion that would fail if the check
      // were written so broadly it refused everyone: a check that always threw
      // would satisfy the case above perfectly and make the operation unusable
      // for the very reviews the merge gate is waiting on.
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        createdByType: "person",
        createdById: "user-a",
      });

      expect(artifact.createdByType).toBe("person");
      expect(artifact.createdById).toBe("user-a");
    });

    it("does not check an agent id against the people table", async () => {
      // Agent ids are not a foreign key to anything, so there is no table to
      // resolve them against and refusing an unknown one would mean refusing
      // every agent. This pins the check to `person` rather than to "any
      // creator", which is the mistake that would look like extra safety and
      // would break every agent-recorded artifact in the suite.
      const itemId = await createTask();
      const artifact = await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        createdByType: "agent",
        createdById: "some-agent-nobody-registered",
      });

      expect(artifact.createdByType).toBe("agent");
      expect(artifact.createdById).toBe("some-agent-nobody-registered");
    });

    it("refuses a person resolved from an assignment when that person does not exist", async () => {
      // The check has to sit below the assignment fallback, not beside the
      // explicit input. A `createdById` inferred from a live assignment's
      // holder reaches the same merge clause, so an assignment held by a
      // person id naming nobody would otherwise walk straight past it.
      const itemId = await createTask();
      await prisma.assignment.create({
        data: {
          id: "assignment-ghost",
          itemId,
          holderType: "person",
          holderId: "ghost-person",
          sessionId: "session-ghost",
          rootSessionId: "session-ghost",
          machine: "laptop",
          role: "builder",
        },
      });

      const error = await recordFails({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        sessionId: "session-ghost",
      });

      expect(error.code).toBe("not_found");
      expect(error.fields).toContain("createdById");
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

  // The operation deliberately accepts artifacts on items a transition would
  // refuse: recording a fact is not passing a gate, and the record of what
  // happened has to stay writable after the thing it describes is over. A
  // review that lands moments after a merge, a screenshot attached to a
  // cancelled item, a test run filed against a project — all are true, and
  // refusing them would lose information without protecting anything.
  //
  // That reasoning was written down but never asserted, which leaves it as an
  // intention rather than a property: a later change adding a state check
  // here would break nothing and read as tightening. These pin it, so the
  // permissiveness has to be removed on purpose if it is ever removed.
  describe("what it deliberately does not refuse", () => {
    it("records an artifact against an item in a terminal state", async () => {
      const itemId = await createTask("merged");

      const artifact = await record({
        itemId,
        kind: "code_review",
        verdict: "lgtm",
        createdByType: "person",
        createdById: "user-a",
      });

      // Adding `if (isTerminalState(item.state)) throw ...` to the handler is
      // the change that makes this fail.
      expect(artifact.itemId).toBe(itemId);
      const rows = await prisma.artifact.findMany({ where: { itemId } });
      expect(rows).toHaveLength(1);
    });

    it("records an artifact against a project, which has no state of its own", async () => {
      // A parentless item is a project: its state derives from its children,
      // so there is no state here for a state check to consult at all.
      const projectId = await createTask("on_deck", { kind: "project" });

      const artifact = await record({
        itemId: projectId,
        kind: "test_run",
        createdByType: "agent",
        createdById: "agent-a",
      });

      expect(artifact.itemId).toBe(projectId);
      const rows = await prisma.artifact.findMany({ where: { itemId: projectId } });
      expect(rows).toHaveLength(1);
    });

    it("still refuses an item that does not exist, terminal or not", async () => {
      // The complement, and the reason the two above are not simply "this
      // operation validates nothing". Existence is checked; state is not.
      const error = await recordFails({
        itemId: "no-such-item",
        kind: "test_run",
        createdByType: "agent",
        createdById: "agent-a",
      });
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["itemId"]);
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
    // `record_artifact` refuses a `createdByType: "person"` whose id names
    // nobody (#134), so the person these fixtures credit has to exist.
    await prisma.person.create({ data: { id: "user-a", displayName: "User A" } });
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
