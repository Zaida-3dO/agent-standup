// I26/I27/I28's queries, against a real Postgres — `docs/plans/INTERVENTIONS.md`
// I26, I27, I28.
//
// ── Why this file exists, stated as the failure it exists to catch ─────
//
// The unit tests for these three entries feed `deliveryStage` and
// `untrackedNits` **straight into the predicates**. That proves the
// predicates read their fields correctly; it cannot prove the functions
// that *derive* those fields mean anything, because no assertion ever
// executes them.
//
// A review demonstrated the gap concretely, and in the same directory where
// `interventions-occupancy-db.test.ts` records the identical lesson: the
// `hasCommit` and `hasPullRequest` branches of `deliveryFor` could be
// **swapped** and all nineteen unit tests stayed green. Under that swap an
// item with an open pull request — which nearly always carries a commit
// artifact too — reports `committed`, so I26 nags for the item's whole life
// and I27 never fires at all. That is precisely the failure the three-value
// stage was designed to prevent, and nothing pinned it.
//
// The same review found `untrackedNitsFor` implementing one of I28's three
// documented conditions: it selected on `verdict IS NOT NULL` alone, so a
// `changes_required` review with findings fired the entry — the verdict
// *most* likely to carry findings — and a reviewer who had linked a
// follow-up, which is the remedy I28 asks for, was nudged anyway.
//
// So the semantics are pinned here instead, by executing the real queries
// against real rows. Each case below is a way these functions can be wrong
// in a direction nobody would notice from behaviour.
//
// Skips without TEST_DATABASE_URL, like every other database-backed file
// here; CI's database job runs it, and `check:db-gated:require` fails there
// if the URL is missing rather than skipping silently.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assembleContext } from "@/lib/interventions/context";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the delivery-flow queries — against Postgres", () => {
  const dbName = scratchDatabaseName("interventions_flow_nudges");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.repo.create({ data: { id: "repo-a", displayName: "repo-a" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.artifact.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let counter = 0;

  async function createItem(state = "executing"): Promise<string> {
    counter += 1;
    const id = `item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Item ${counter}`,
        body: "body",
        state: state as never,
        originType: "person",
        area: "web",
        repo: "repo-a",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /** A live claim, so the assembler has an item to answer about. */
  async function claim(sessionId: string, itemId: string): Promise<void> {
    await prisma.assignment.create({
      data: {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: sessionId,
        sessionId,
        rootSessionId: sessionId,
        machine: "desktop",
        worktree: null,
        branch: null,
        liveness: "running" as never,
        releasedAt: null,
      },
    });
  }

  async function artifact(options: {
    itemId: string;
    kind: string;
    verdict?: string;
    findings?: unknown;
    followUpItemId?: string;
    reviewRound?: number;
    body?: string;
  }): Promise<void> {
    await prisma.artifact.create({
      data: {
        itemId: options.itemId,
        kind: options.kind as never,
        ...(options.verdict === undefined ? {} : { verdict: options.verdict as never }),
        ...(options.findings === undefined ? {} : { findings: options.findings as never }),
        ...(options.followUpItemId === undefined ? {} : { followUpItemId: options.followUpItemId }),
        ...(options.body === undefined ? {} : { body: options.body }),
        reviewRound: options.reviewRound ?? 1,
        createdByType: "agent",
        createdById: "agent-a",
      },
    });
  }

  /** A note on an item — the shape `record {action: "note"}` writes. */
  async function note(itemId: string, body: string | null): Promise<void> {
    await prisma.event.create({
      data: {
        itemId,
        actorType: "agent",
        actorId: "agent-a",
        type: "note",
        payload: {},
        ...(body === null ? {} : { body }),
      },
    });
  }

  /**
   * Assembles the context the way `hook_decision` does on a `post` event
   * for a delivery-shaped call, which is the only path these fields are
   * gathered on.
   */
  async function contextFor(sessionId: string) {
    return assembleContext({
      db: prisma as never,
      sessionId,
      tool: "Bash",
      command: "git push origin feat/x",
      phase: "post",
    });
  }

  describe("deliveryFor — the stage an item's work has reached", () => {
    it("reports `committed` for a commit with no pull request", async () => {
      const item = await createItem();
      await claim("s1", item);
      await artifact({ itemId: item, kind: "commit" });

      expect((await contextFor("s1")).deliveryStage).toBe("committed");
    });

    // **The case that kills the branch swap, and the reason this file
    // exists.** A real item with an open pull request almost always carries
    // a commit artifact as well, so both `EXISTS` subqueries are true at
    // once and only the *precedence* decides the answer. Swap the two
    // branches and this reports `committed`: I26 then nags for the item's
    // whole life and I27 never fires. Every unit test still passes, because
    // none of them executes this function.
    it("reports `pull_request_open` when BOTH a commit and a pull request exist", async () => {
      const item = await createItem();
      await claim("s1", item);
      await artifact({ itemId: item, kind: "commit" });
      await artifact({ itemId: item, kind: "pull_request" });

      expect((await contextFor("s1")).deliveryStage).toBe("pull_request_open");
    });

    // The same argument one stage further on: a requested review settles it
    // whatever else is true, so all three signals are present here and the
    // ordering is again the whole of the answer.
    it("reports `review_requested` once a review has been asked for", async () => {
      const item = await createItem();
      await claim("s1", item);
      await artifact({ itemId: item, kind: "commit" });
      await artifact({ itemId: item, kind: "pull_request" });
      await prisma.event.create({
        data: {
          itemId: item,
          type: "review_requested",
          actorType: "agent",
          actorId: "agent-a",
          // `payload` is non-nullable with no default, so an event seeded
          // without one does not typecheck at all — which is the schema
          // saying an event that records nothing is not an event.
          payload: { round: 1 },
          body: "please review",
        },
      });

      expect((await contextFor("s1")).deliveryStage).toBe("review_requested");
    });

    it("reports no stage at all for an item nobody has committed to", async () => {
      // Absent rather than a stage: an item mid-build has not stalled on its
      // way to a pull request, and this is most of an item's working life.
      const item = await createItem();
      await claim("s1", item);

      expect((await contextFor("s1")).deliveryStage).toBeUndefined();
    });

    it("does not read another item's artifacts", async () => {
      // The `itemId` binding is what makes every case above mean anything;
      // without it the query matches the whole table and the first test
      // would pass for the wrong reason.
      const mine = await createItem();
      const theirs = await createItem();
      await claim("s1", mine);
      await artifact({ itemId: theirs, kind: "commit" });
      await artifact({ itemId: theirs, kind: "pull_request" });

      expect((await contextFor("s1")).deliveryStage).toBeUndefined();
    });
  });

  describe("untrackedNitsFor — a nits verdict whose findings nothing tracks", () => {
    const NITS = [
      { text: "spacing", severity: "info" },
      { text: "naming", severity: "low" },
    ];

    it("fires for a lgtm_with_nits review carrying findings and no follow-up", async () => {
      const item = await createItem("merged");
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: NITS,
      });

      expect((await contextFor("s1")).untrackedNits).toEqual({ findingCount: 2, reviewRound: 1 });
    });

    // **False positive 1.** `changes_required` is the verdict most likely to
    // carry findings, and it is already blocking — nudging about its
    // findings would fire on the commonest review there is. This entry is
    // also the only one of the three timed `immediate`, so the misfire
    // would not even be batched.
    it("stays silent for a changes_required review carrying findings", async () => {
      const item = await createItem();
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "changes_required",
        findings: NITS,
      });

      expect((await contextFor("s1")).untrackedNits).toBeUndefined();
    });

    // **False positive 2.** A linked follow-up is exactly the remedy this
    // entry asks for. Nudging the reviewer who already did it is how a
    // guard teaches its users to ignore it.
    it("stays silent when the review links a follow-up item", async () => {
      const item = await createItem("merged");
      const followUp = await createItem();
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: NITS,
        followUpItemId: followUp,
      });

      expect((await contextFor("s1")).untrackedNits).toBeUndefined();
    });

    // Supersession. The verdict is tested on the *governing* review rather
    // than inside the row selection, so a newer verdict wins. Filtering to
    // `lgtm_with_nits` in the `WHERE` would skip past this newer row to
    // find the older nits one and fire on an item being reworked.
    it("stays silent when a newer review supersedes the nits verdict", async () => {
      const item = await createItem();
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: NITS,
        reviewRound: 1,
      });
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "changes_required",
        findings: NITS,
        reviewRound: 2,
      });

      expect((await contextFor("s1")).untrackedNits).toBeUndefined();
    });

    it("stays silent for a nits verdict that recorded no findings", async () => {
      const item = await createItem("merged");
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: [],
      });

      expect((await contextFor("s1")).untrackedNits).toBeUndefined();
    });

    // ── The two answers `followUpItemId` cannot record ────────────────
    //
    // The message names three acceptable answers — "actioned in this
    // change, minted as an item, or judged not worth doing" — and the
    // column records only the middle one. Without the other two, a session
    // that answered in prose was told again that it had been silent: the
    // entry fired on the `commit` artifact whose body said where the
    // finding went, and again on the `note` whose entire content was the
    // answer, with the same findingCount and reviewRound both times.
    //
    // Mutation that breaks these two: deleting `if (row.hasAnswer) return
    // {};` from `untrackedNitsFor`, which restores the repeat.
    it("stays silent once a note recorded after the review answers it", async () => {
      const item = await createItem("merged");
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: NITS,
      });

      expect((await contextFor("s1")).untrackedNits).toEqual({ findingCount: 2, reviewRound: 1 });

      await note(item, "Both nits actioned in 7b2edf4; no row minted because the fix shipped.");

      expect((await contextFor("s1")).untrackedNits).toBeUndefined();
    });

    it("stays silent once an artifact recorded after the review answers it", async () => {
      const item = await createItem("merged");
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: NITS,
      });
      await artifact({
        itemId: item,
        kind: "commit",
        body: "Fixes both nits from round 1.",
      });

      expect((await contextFor("s1")).untrackedNits).toBeUndefined();
    });

    // Ordering is the whole claim: a write that PREDATES the review cannot
    // be an answer to it. Without the timestamp comparison any item with
    // prior history would silence the entry permanently.
    //
    // Mutation that breaks it: `e."ts" > g."createdAt"` -> `>=` is too weak
    // to catch; dropping the comparison entirely is what this kills.
    it("still fires when the only prose predates the review", async () => {
      const item = await createItem("merged");
      await claim("s1", item);
      await note(item, "Starting work on this.");
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: NITS,
      });

      expect((await contextFor("s1")).untrackedNits).toEqual({ findingCount: 2, reviewRound: 1 });
    });

    // A bodyless event is a state change, not an answer. Counting it would
    // let an ordinary transition silence the entry.
    //
    // Mutation that breaks it: dropping `e."body" IS NOT NULL`.
    it("does not treat a bodyless event as an answer", async () => {
      const item = await createItem("merged");
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: NITS,
      });
      await note(item, null);

      expect((await contextFor("s1")).untrackedNits).toEqual({ findingCount: 2, reviewRound: 1 });
    });

    // `Verdict` is a column on `Artifact` generally rather than on reviews
    // alone, so without the `kind` restriction a non-review row can be the
    // one this entry speaks about.
    it("does not treat a non-review artifact as the governing review", async () => {
      const item = await createItem("merged");
      await claim("s1", item);
      await artifact({
        itemId: item,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        findings: NITS,
      });
      await artifact({
        itemId: item,
        kind: "merge_approval",
        verdict: "approved",
        findings: NITS,
      });

      // The later `merge_approval` must not displace the review above it.
      expect((await contextFor("s1")).untrackedNits).toEqual({ findingCount: 2, reviewRound: 1 });
    });
  });
});
