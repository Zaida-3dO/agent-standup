// Row #17's guards: review-requested, plan-approval, and evidence-at-tip.
// See docs/plans/MILESTONES.md #17, SCHEMA.md §6, §16.
//
// Runs against a real Postgres, like state-machine-transition.test.ts — the
// claims here are about rows actually present (or absent) in `Artifact`
// and `Event`, which an in-memory model cannot settle, and staleness in
// particular is a claim about which of several real rows is newest. Skips
// without TEST_DATABASE_URL, same convention as every other DB-backed file.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GuardRegistry, applyTransition } from "@/lib/service/state-machine";
import {
  currentTipCommitSha,
  evidenceAtTipGuard,
  hasApproval,
  latestApprovalAtTip,
  planApprovalGuard,
  reviewRequestedGuard,
  shaMatches,
} from "@/lib/service/guards";
import { guardRegistry } from "@/lib/service/state-machine/guard";
import {
  defineOperation,
  isServiceError,
  prismaTransactionRunner,
  ServiceRuntime,
} from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import type { ServiceContext } from "@/lib/service/context";
import { z } from "zod";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("artifact guards (#17), against Postgres", () => {
  const dbName = scratchDatabaseName("artifact_guards");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  let runtime: ServiceRuntime;

  beforeAll(() => {
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  });

  afterEach(async () => {
    // Artifact and Event both cascade-free FK to Item — delete children
    // first so the parent delete below never hits a constraint violation.
    await prisma.artifact.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(state: string) {
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
        originType: "person",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function createArtifact(overrides: {
    itemId: string;
    kind: string;
    verdict?: string | null;
    commitSha?: string | null;
    createdAt?: Date;
  }) {
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        itemId: overrides.itemId,
        kind: overrides.kind as never,
        verdict: (overrides.verdict ?? null) as never,
        commitSha: overrides.commitSha ?? null,
        createdByType: "agent",
        createdById: "test-agent",
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
  }

  async function createReviewRequestedEvent(itemId: string) {
    await prisma.event.create({
      data: {
        itemId,
        actorType: "agent",
        actorId: "test-agent",
        type: "review_requested",
        payload: { round: 1 },
      },
    });
  }

  async function readState(itemId: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    return row.state;
  }

  function callTransition(itemId: string, to: string, reg: GuardRegistry) {
    const opName = `test_artifact_guard_${Math.random().toString(36).slice(2)}`;
    const op = defineOperation({
      name: opName,
      kind: "write",
      summary: "test",
      input: z.object({}).strict(),
      async handler(ctx: ServiceContext) {
        return applyTransition(ctx, { itemId, to }, reg);
      },
    });
    const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
    registry[opName] = op;
    return runtime.call(opName, {}).finally(() => {
      delete registry[opName];
    });
  }

  describe("registration — into row #15's shared registry, no parallel mechanism", () => {
    it("registers all three guards into the shared guardRegistry, via ALL_GUARDS alone", () => {
      // guards/index.ts's module-scope registration loop already ran once
      // as a side effect of importing `@/lib/service/guards` above (both
      // directly, and transitively through `@/lib/service/state-machine`'s
      // own imports) — so by the time this test body runs, the shared
      // registry already has these guards, registered by ALL_GUARDS and
      // nothing else.
      expect(guardRegistry.has("artifact.review_requested")).toBe(true);
      expect(guardRegistry.has("artifact.plan_approval")).toBe(true);
      expect(guardRegistry.has("artifact.evidence_at_tip")).toBe(true);
    });
  });

  describe("artifact.review_requested — entering in_review", () => {
    it("rejects entering in_review with no review_requested event", async () => {
      const reg = new GuardRegistry();
      reg.register(reviewRequestedGuard);
      const id = await createTask("executing");
      const error = await callTransition(id, "in_review", reg).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.review_requested");
      expect(await readState(id)).toBe("executing");
    });

    it("allows entering in_review once a review_requested event exists", async () => {
      const reg = new GuardRegistry();
      reg.register(reviewRequestedGuard);
      const id = await createTask("executing");
      await createReviewRequestedEvent(id);
      await callTransition(id, "in_review", reg);
      expect(await readState(id)).toBe("in_review");
    });

    it("does not apply to a transition that is not entering in_review", async () => {
      const reg = new GuardRegistry();
      reg.register(reviewRequestedGuard);
      const id = await createTask("executing");
      // No review_requested event exists, and the guard would reject if it
      // ran — passing here proves appliesTo actually filters this pair out,
      // not merely that the guard is lenient.
      await callTransition(id, "someday", reg);
      expect(await readState(id)).toBe("someday");
    });
  });

  describe("artifact.plan_approval — executing from plan_review", () => {
    it("rejects with no plan_review artifact at all", async () => {
      const reg = new GuardRegistry();
      reg.register(planApprovalGuard);
      const id = await createTask("plan_review");
      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.plan_approval");
      expect(await readState(id)).toBe("plan_review");
    });

    it("rejects a plan_review artifact whose verdict is changes_required, not approved", async () => {
      const reg = new GuardRegistry();
      reg.register(planApprovalGuard);
      const id = await createTask("plan_review");
      await createArtifact({ itemId: id, kind: "plan_review", verdict: "changes_required" });
      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.plan_approval");
    });

    it("allows executing from plan_review once an approved plan_review artifact exists", async () => {
      const reg = new GuardRegistry();
      reg.register(planApprovalGuard);
      const id = await createTask("plan_review");
      await createArtifact({ itemId: id, kind: "plan_review", verdict: "approved" });
      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });
  });

  describe("artifact.evidence_at_tip — an abbreviated sha must not be treated as stale (row 73ff36bd)", () => {
    it("ALLOWS: an approval pinned to a 7-char abbreviation of the full-length tip commit", async () => {
      // The exact reproduction from row 73ff36bd: three approvals pinned to
      // `86f3af0`, a commit artifact pinned to the full 40-character sha for
      // the same commit. Same commit, different lengths — must not refuse.
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "86f3af0",
        createdAt: new Date(),
      });

      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });

    it("ALLOWS: the abbreviation on the other side — a full-length approval against a short tip", async () => {
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "86f3af0",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
        createdAt: new Date(),
      });

      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });

    it("REFUSES: an abbreviation of a DIFFERENT commit than the tip — prefix matching does not widen to unrelated shas", async () => {
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
        createdAt: new Date(Date.now() - 60_000),
      });
      // `deadbee` is not a prefix of the tip and the tip is not a prefix of
      // it — genuinely a different commit, and must still be refused.
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "deadbee",
        createdAt: new Date(),
      });

      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("plan_review");
    });

    it("REFUSES: a non-hex fixture value must not prefix-match another non-hex value it happens to start with", async () => {
      // Guards the HEX_SHA gate itself: without it, "commit-a" would
      // startsWith-match "commit-ab" even though they are unrelated
      // synthetic identifiers, not the same commit at two lengths.
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-ab",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "commit-a",
        createdAt: new Date(),
      });

      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("plan_review");
    });

    it("ALLOWS: an abbreviated approval matching a sha the tip's lineage stands in for, not just the tip itself", async () => {
      // Combines row 73ff36bd's abbreviation fix with the pre-existing
      // supersession-lineage widening: the approval is short, and the sha it
      // is short for isn't the tip directly but something the tip's commit
      // artifact declared it superseded (a squash/rebase/amend).
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "86f3af0",
        createdAt: new Date(Date.now() - 60_000),
      });
      await prisma.artifact.create({
        data: {
          id: randomUUID(),
          itemId: id,
          kind: "commit",
          commitSha: "cafef00dcafef00dcafef00dcafef00dcafef00",
          supersedesSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
          createdByType: "agent",
          createdById: "test-agent",
          createdAt: new Date(),
        },
      });

      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });
  });

  describe("artifact.evidence_at_tip — stale evidence from an earlier commit must be refused", () => {
    it("REFUSES: an approval attached to a superseded commit, even though an approval exists", async () => {
      // The load-bearing test for AC3. A plan is approved at commit A; the
      // branch then moves to commit B (a later `commit` artifact lands).
      // The approval still exists — plan_approval.ts's own guard would pass
      // it — but it is stale evidence for commit B, and this guard's job is
      // to catch exactly that.
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      const earlier = new Date(Date.now() - 60_000);
      const later = new Date();

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "commit-a",
        createdAt: earlier,
      });
      // A newer commit lands after the approval — the item has moved on.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-b",
        createdAt: later,
      });

      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("plan_review");
    });

    it("ALLOWS: an approval attached to the current tip commit", async () => {
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "commit-a",
        createdAt: new Date(),
      });

      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });

    it("ALLOWS: an approval with no commit_sha when the item has no commit artifact yet — nothing to be stale against", async () => {
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
      });

      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });

    it("REFUSES: an approval with no commit_sha once a commit artifact exists — unverifiable against the real tip", async () => {
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        createdAt: new Date(),
      });

      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
    });

    it("ALLOWS: a genuinely fresh item — approved plan, no sha, no commit artifact — so the guard is not unsatisfiable at the only moment this transition is taken", async () => {
      // Pins the finding that killed this row's original premise. The claim
      // under investigation was that `artifact.evidence_at_tip` demands
      // evidence at a tip that cannot exist on `plan_review -> executing`,
      // since an item about to start executing has produced no commit. It
      // does not: `shaMatchesTipOrLineage` treats a null approval against a
      // null tip as current, so the fresh shape passes untouched.
      //
      // This test exists so that stops being a thing anyone has to
      // rediscover by probing. If a later change makes the guard fire on
      // fresh items — the failure mode that would block every first build —
      // this goes red rather than being found by three crews in a wave.
      // Single-character mutation it catches: flipping `candidate === null`
      // to `candidate !== null` in shaMatchesTipOrLineage's tip-null arm.
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
      });

      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });

    it("REFUSES an approval that names a sha on an item with no commit artifact, and blames the MISSING COMMIT rather than the approval", async () => {
      // With no `commit` artifact the tip is null, and the only way to reach
      // a refusal here is for the approval to have named a sha — so the
      // approval is the one thing that IS specific, and the item is what
      // records nothing. A refusal saying the approval "does not record
      // which commit it applies to" would therefore be describing the
      // situation backwards, and would send a reader to re-review a plan
      // that was approved perfectly well when the missing row is a commit
      // artifact.
      //
      // The negative assertion is the load-bearing half: an allow/refuse or
      // guard-id-only test passes against a wrong sentence indefinitely.
      // Single-character mutation this catches:
      // negating `approvalNamesNoCommit` in evidence-at-tip.ts swaps the two
      // branches and fails both the positive and negative assertions below.
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "commit-a",
      });

      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
      const message = (error as { message: string }).message;
      // Names the real gap: the item records no commit artifact.
      expect(message).toContain("records no");
      expect(message).toContain("commit");
      // And does NOT assert the backwards thing about the approval, nor
      // claim staleness — nothing moved.
      expect(message).not.toContain("does not record which commit it applies to");
      expect(message).not.toContain("has moved since it was approved");
      expect(await readState(id)).toBe("plan_review");
    });

    it("ALLOWS a no-sha approval on a commitless item even when an OLDER approval named a sha — which is what makes the refusal above have only one meaning", async () => {
      // This is the test that licenses the single unconditional sentence in
      // the no-tip refusal. `latestApprovalAtTip` walks every approval and
      // returns the first at the tip, so on a commitless item ANY approval
      // carrying a null sha satisfies the guard — regardless of what the
      // other approvals say. Enumerating all five no-commit shapes against
      // Postgres showed the refusal fires only when EVERY approval names a
      // sha, so "the approval does not record which commit it applies to"
      // was not merely backwards on this path, it was unreachable.
      //
      // Pinned because it is the premise the message depends on. If a change
      // ever makes a null-sha approval stop qualifying here, the no-tip
      // refusal silently acquires a second meaning and its now-unconditional
      // sentence starts lying again — this test goes red first.
      // Single-character mutation it catches: `return candidate === null` to
      // `return candidate !== null` in shaMatchesTipOrLineage's tip-null arm.
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
        createdAt: new Date(),
      });

      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });

    // ── The ordering trap: a commit recorded BEFORE the transition ──────
    //
    // Three builders in one wave were refused here and each spent a
    // `review_evidence_override` to get past it, which is three permanent
    // rows recording that this guard's default was judged wrong when it was
    // actually being asked the wrong question.
    //
    // The cause is ordering, not the commit. `evidence_at_tip` compares an
    // approval against `currentTipCommitSha`, the newest `commit` ARTIFACT
    // on the item — and `tipCommitLineage` extends only through explicitly
    // recorded `supersedesSha` links, never git ancestry. So a plan approved
    // at the branch base is never recognised as an ancestor of a commit
    // recorded afterwards, and the guard cannot tell "the plan changed after
    // approval" from "the approved plan was implemented". Those are opposite
    // situations.
    //
    // The pair below is the demonstration: identical item, identical
    // artifacts, identical shas — only the ORDER differs, and only one is
    // refused. That is what makes this a sequence to document rather than a
    // guard to redesign.
    it("REFUSES when a commit artifact is recorded BEFORE the plan_review -> executing transition", async () => {
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      // The plan is approved at the branch base, naming no commit — the
      // ordinary shape, since no commit exists when a plan is reviewed.
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
        createdAt: new Date(Date.now() - 60_000),
      });
      // The builder starts work and records the commit BEFORE transitioning.
      // This is the whole trap: a non-null tip is matched only by an approval
      // naming that sha, and this approval names none.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "a".repeat(40),
        createdAt: new Date(),
      });

      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("plan_review");

      // ── The half that actually cost three sessions ──────────────────
      //
      // The refusal must NOT say the plan moved. Nothing moved: the plan was
      // approved before any commit existed and is unchanged. Three builders
      // read "get it re-reviewed", believed it, and spent a permanent
      // override each. The negative assertion is the load-bearing one — a
      // guard-id-only test passes against that wrong sentence forever.
      const message = (error as { message: string }).message;
      expect(message).not.toContain("has moved since it was approved");
      expect(message).not.toContain("get it re-reviewed");
      // And it must name the sequence that avoids it, since that is the
      // actual remedy and it is free.
      expect(message).toContain("order");
      expect(message).toContain("plan_review -> executing");
    });

    it("ALLOWS the identical artifacts when the transition happens BEFORE the commit is recorded", async () => {
      // Same item shape, same approval, same sha, same guard — the only
      // difference is that the transition is taken first. It succeeds, which
      // is what proves the refusal above is about sequence and not about the
      // commit, the plan, or any property of the work.
      //
      // This is the assertion that would fail if someone "fixed" the trap by
      // weakening the guard into passing both orders unconditionally, and
      // equally the one that documents the workaround as real: transition,
      // then record.
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
        createdAt: new Date(Date.now() - 60_000),
      });

      // Transition first — the approval is still current, because a
      // commitless item has a null tip and a null approval matches it.
      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");

      // The commit is recorded after, and nothing refuses it. The guard does
      // not apply to any transition out of `executing`, so the work proceeds.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "a".repeat(40),
        createdAt: new Date(),
      });
      expect(await readState(id)).toBe("executing");
    });

    it("still REFUSES a plan that genuinely changed after approval, whatever the ordering", async () => {
      // The criterion that keeps the fix honest: the guard exists to catch a
      // plan approved at one commit and then moved. Documenting the ordering
      // must not quiet that case too.
      //
      // Distinguishable from the ordering trap by the approval naming a
      // DIFFERENT sha rather than none: the plan was reviewed at `a`, the
      // item is now at `b`, and no supersession link says `b` carries `a`'s
      // reviewed work. That is real staleness and stays refused.
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");

      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "b".repeat(40),
        createdAt: new Date(),
      });

      const error = await callTransition(id, "executing", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
      // And it says the plan MOVED, which is the true diagnosis here and the
      // one that distinguishes this from the ordering trap above.
      const message = (error as { message: string }).message;
      expect(message).toContain("has moved since it was approved");
      // It must NOT offer the ordering advice, which would be wrong here and
      // would send a reader to reorder two writes that are already in the
      // right order. Together with the ordering test's inverse assertions,
      // this is what pins the two diagnoses as genuinely distinct rather
      // than one message widened to cover both.
      expect(message).not.toContain("plan_review -> executing");
      expect(await readState(id)).toBe("plan_review");
    });

    it("does not reject when there is no approval at all — that is plan_approval.ts's rejection, not this guard's", async () => {
      const reg = new GuardRegistry();
      reg.register(evidenceAtTipGuard);
      const id = await createTask("plan_review");
      // No plan_review artifact of any kind. This guard has nothing to say
      // about "never approved" — only about "approved, but stale" — so it
      // must let the transition through on its own (planApprovalGuard,
      // registered separately, is what actually gates existence).
      await callTransition(id, "executing", reg);
      expect(await readState(id)).toBe("executing");
    });

    it("both guards together: an unapproved plan is rejected by plan_approval, a stale approval by evidence_at_tip", async () => {
      const reg = new GuardRegistry();
      reg.register(planApprovalGuard);
      reg.register(evidenceAtTipGuard);

      const unapproved = await createTask("plan_review");
      const unapprovedError = await callTransition(unapproved, "executing", reg).catch(
        (e: unknown) => e,
      );
      expect((unapprovedError as { guard?: string }).guard).toBe("artifact.plan_approval");

      const stale = await createTask("plan_review");
      await createArtifact({
        itemId: stale,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: stale,
        kind: "commit",
        commitSha: "commit-b",
        createdAt: new Date(),
      });
      const staleError = await callTransition(stale, "executing", reg).catch((e: unknown) => e);
      expect((staleError as { guard?: string }).guard).toBe("artifact.evidence_at_tip");

      const fresh = await createTask("plan_review");
      await createArtifact({
        itemId: fresh,
        kind: "commit",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: fresh,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "commit-a",
        createdAt: new Date(),
      });
      await callTransition(fresh, "executing", reg);
      expect(await readState(fresh)).toBe("executing");
    });
  });

  describe("the reusable helpers directly (artifact-tip.ts) — the surface #18 reuses", () => {
    it("currentTipCommitSha returns null with no commit artifact, and the newest commit's sha otherwise", async () => {
      const id = await createTask("executing");
      expect(await currentTipCommitSha(prisma, id)).toBeNull();

      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-b",
        createdAt: new Date(),
      });
      expect(await currentTipCommitSha(prisma, id)).toBe("commit-b");
    });

    it("hasApproval is existence-only — true even when the approval is stale", async () => {
      const id = await createTask("executing");
      expect(await hasApproval(prisma, id, "code_review")).toBe(false);
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "commit-a",
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "commit-b" });
      // Still true — hasApproval deliberately does not know about staleness.
      expect(await hasApproval(prisma, id, "code_review")).toBe(true);
    });

    it("latestApprovalAtTip picks whichever approval is actually at the tip, regardless of recency", async () => {
      // The scenario this test proves: the most recently created approval is
      // not the one at the tip, but a less-recent approval is. "The most
      // recent approval" and "the approval that is at the tip" must be
      // answered as different questions, or this case silently returns the
      // wrong row.
      const id = await createTask("executing");
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 120_000),
      });
      const approvalAtTip = await prisma.artifact.create({
        data: {
          id: randomUUID(),
          itemId: id,
          kind: "code_review",
          verdict: "approved",
          commitSha: "commit-a",
          createdByType: "agent",
          createdById: "test-agent",
          createdAt: new Date(Date.now() - 90_000),
        },
      });
      // A more recently created approval exists too, but it names a commit
      // that is not the item's tip — the point is only that recency and
      // being at the tip must be evaluated independently.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "commit-x",
        createdAt: new Date(Date.now() - 30_000),
      });

      const result = await latestApprovalAtTip(prisma, id, "code_review");
      expect(result?.id).toBe(approvalAtTip.id);
    });

    it("latestApprovalAtTip matches a short sha against a full-length tip, and vice versa", async () => {
      const id = await createTask("executing");
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
      });
      const approval = await prisma.artifact.create({
        data: {
          id: randomUUID(),
          itemId: id,
          kind: "code_review",
          verdict: "approved",
          commitSha: "86f3af0",
          createdByType: "agent",
          createdById: "test-agent",
        },
      });

      const result = await latestApprovalAtTip(prisma, id, "code_review");
      expect(result?.id).toBe(approval.id);
    });

    it("latestApprovalAtTip does not match a short sha against an unrelated full-length tip", async () => {
      const id = await createTask("executing");
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "deadbee",
      });

      expect(await latestApprovalAtTip(prisma, id, "code_review")).toBeNull();
    });
  });
});

// shaMatches's bound is pure — no database needed, so this runs even
// without TEST_DATABASE_URL. Pinned separately from the guard-level and
// latestApprovalAtTip tests above because two mutants survived those:
// widening HEX_SHA from `{7,40}` to `{1,40}` or to `{7,}` still passed
// every test that exercises shaMatches only through real git-length shas
// (7 or 40 characters) — none of those fixtures happen to sit exactly on
// the boundary the bound is supposed to enforce. Row 030ec708: with
// commitSha stored as any non-empty string (record-artifact.ts has no
// format check), the floor is a security margin, not a convenience — at 4
// characters a matching sha is 1-in-65,536 and brute-forceable in minutes
// by writing artifacts in a loop; at 7 it is 1-in-268,435,456, the exact
// margin git itself stakes --short abbreviation on.
describe("shaMatches — the {7,40} bound is pinned, not left to a comment", () => {
  // A 40-char real sha-1 to compare boundary-length candidates against.
  const fullSha = "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a";
  const sixChar = fullSha.slice(0, 6);
  const sevenChar = fullSha.slice(0, 7);
  const fortyOneChar = `${fullSha}a`;

  it("REFUSES a 6-character prefix — one character under the floor", () => {
    expect(shaMatches(sixChar, fullSha)).toBe(false);
  });

  it("ALLOWS a 7-character prefix — exactly at the floor", () => {
    expect(shaMatches(sevenChar, fullSha)).toBe(true);
  });

  it("REFUSES a 41-character string prefix-matching a longer one — the ceiling, not just non-equality", () => {
    // A genuine prefix relationship — fortyOneChar really is the first 41
    // characters of a longer string — so this can only be refused because
    // HEX_SHA's ceiling excludes 41-character values from counting as a sha
    // at all. Comparing two unrelated 41-char strings (no prefix relation)
    // would pass this same assertion for the WRONG reason even with no
    // ceiling at all, since shaMatches would fall through to false anyway —
    // that is exactly the gap that let `{7,40}` -> `{7,}` survive: it
    // widens what HEX_SHA accepts without ever being asked to accept a
    // prefix pair that only a wider ceiling would admit.
    const longerRelated = `${fortyOneChar}cccccccccccccccccccccccccccccccccccccccc`;
    expect(shaMatches(fortyOneChar, longerRelated)).toBe(false);
  });

  it("ALLOWS a 40-character exact match — exactly at the ceiling", () => {
    expect(shaMatches(fullSha, fullSha)).toBe(true);
  });

  it("case-sensitive: an uppercase-hex candidate does not bypass the gate via a mixed-case prefix", () => {
    // Guards against a case-insensitive regex slipping in later: HEX_SHA is
    // lowercase-only, and git commit shas are always rendered lowercase, so
    // an uppercase value is never real git output and must not prefix-match
    // through some case-folding path this function does not have but a
    // careless edit could add.
    expect(shaMatches(sevenChar.toUpperCase(), fullSha)).toBe(false);
  });
});
