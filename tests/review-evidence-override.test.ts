// `review_evidence_override` — the escape hatch for the two review-evidence
// clauses. See SCHEMA.md §6c-bis, §16.
//
// Runs against a real Postgres, like `artifact-guards.test.ts` and
// `merge-guards.test.ts`: every claim here is about rows actually present
// (or absent) in `Artifact`, and about which of several real rows a guard
// comes to rest on — neither of which an in-memory model can settle. Skips
// without TEST_DATABASE_URL, the same convention as every other DB-backed
// file.
//
// **What this file is guarding against.** An escape hatch is the one feature
// where the tests that matter most are the ones asserting it does NOT work:
// that it cannot be spent on a commit written after it, that it cannot
// manufacture a person's authorisation, and that it cannot stand in for a
// review that never happened. Those live at the bottom of this file under
// "the boundaries", and they are the reason it exists.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GuardRegistry, applyTransition } from "@/lib/service/state-machine";
import {
  ALL_GUARDS,
  MIN_EVIDENCE_REASON_LENGTH,
  REVIEW_EVIDENCE_OVERRIDE_KIND,
  evidenceAtTipGuard,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresAuthorisationGuard,
  planApprovalGuard,
  reviewEvidenceOverrideRemedy,
  reviewEvidenceOverrideSatisfies,
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
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A reason comfortably over the floor, so length is never the thing under test. */
const GOOD_REASON = "Rebased onto main; no source changes since the approving review.";

describeIfDb("review_evidence_override (§6c-bis), against Postgres", () => {
  const dbName = scratchDatabaseName("review_evidence_override");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
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
    await prisma.artifact.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(state: string, mergeAuthority = "pre_approved") {
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
        mergeAuthority: mergeAuthority as never,
      },
    });
    return id;
  }

  async function createArtifact(overrides: {
    itemId: string;
    kind: string;
    verdict?: string | null;
    commitSha?: string | null;
    supersedesSha?: string | null;
    body?: string | null;
    createdByType?: string;
    createdAt?: Date;
  }) {
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        itemId: overrides.itemId,
        kind: overrides.kind as never,
        verdict: (overrides.verdict ?? null) as never,
        commitSha: overrides.commitSha ?? null,
        supersedesSha: overrides.supersedesSha ?? null,
        body: overrides.body ?? null,
        createdByType: (overrides.createdByType ?? "agent") as never,
        createdById: "test-agent",
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
  }

  async function readState(itemId: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    return row.state;
  }

  function callTransition(itemId: string, to: string, reg: GuardRegistry) {
    const opName = `test_evidence_override_${Math.random().toString(36).slice(2)}`;
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

  /** The `plan_review → executing` pair, with both row #17 guards registered. */
  function planGuards() {
    const reg = new GuardRegistry();
    reg.register(planApprovalGuard);
    reg.register(evidenceAtTipGuard);
    return reg;
  }

  // ── The gap this closes: without an override this guard is absolute ────

  describe("artifact.evidence_at_tip — an absolute block, made passable with a reason", () => {
    it("still refuses a stale plan approval when no override exists", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("plan_review");
    });

    it("lets a stale plan approval through when an override names the tip commit", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
      });

      await callTransition(id, "executing", planGuards());
      expect(await readState(id)).toBe("executing");
    });

    it("names a reachable remedy in the refusal — the whole complaint was that there was none", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      // Names the artifact kind to record, and names the guard being
      // overridden — the attribution the scoring work needs to tell "which
      // guard's default is wrong" from "overriding happened".
      expect((error as { message: string }).message).toContain(REVIEW_EVIDENCE_OVERRIDE_KIND);
      expect((error as { message: string }).message).toContain("artifact.evidence_at_tip");
    });

    it("an override does NOT fire when the approval is already at the tip — it stays inert and uncounted", async () => {
      // The guard must consult the override only after `latestApprovalAtTip`
      // has actually said no. If it were checked first, an override lying
      // around would be "spent" on a healthy item and would appear in the
      // override count as a firing that never happened — which would make
      // the count useless for deciding whether the guard's default is wrong.
      const id = await createTask("plan_review");
      const sha = "c".repeat(40);
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: sha,
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: sha });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: sha,
        body: GOOD_REASON,
      });

      await callTransition(id, "executing", planGuards());
      expect(await readState(id)).toBe("executing");
    });
  });

  // ── The backfill case: an approval that never recorded a commit ────────

  describe("the sha-less anchor — the case that had a structurally untakeable remedy", () => {
    // ── The shape of the null-tip refusal, stated precisely ──────────────
    //
    // The obvious reading — "the approval recorded no commit" — is NOT this
    // case, and asserting it produced two passing transitions and two failed
    // tests on the first run. `shaMatchesTipOrLineage` treats a null tip as
    // matching a null candidate, so an approval with no sha on an item with
    // no commit is not stale and the guard never fires.
    //
    // The reachable null-tip refusal is the reverse: the approval RECORDS a
    // sha and the item records no commit artifact. Every approving row then
    // fails to match, and there is no tip for an override to name.
    it("refuses when the approval names a sha but the item records no commit artifact", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
    });

    it("honours a sha-less override on exactly that item — the refusal with no sha to name", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: null,
        body: GOOD_REASON,
      });

      await callTransition(id, "executing", planGuards());
      expect(await readState(id)).toBe("executing");
    });

    it("an approval with no sha on an item with no commit is not stale at all — no override needed", async () => {
      // Pins the asymmetry the two tests above depend on. If this ever starts
      // refusing, the null-tip semantics have changed underneath this feature
      // and the sha-less allowance is answering a different question.
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
      });

      await callTransition(id, "executing", planGuards());
      expect(await readState(id)).toBe("executing");
    });

    it("does NOT honour a sha-less override once the item has a tip — the widening is a property of the item, not a choice", async () => {
      // This is the test that stops the sha-less allowance being a loophole.
      // A caller cannot elect to have no tip; the moment a commit artifact
      // exists, strict scoping is back and a sha-less override is inert.
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: null,
        body: GOOD_REASON,
      });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("plan_review");
    });

    it("does NOT honour a sha-NAMING override on an item with no tip — it is about a commit this item has no record of", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "d".repeat(40),
        body: GOOD_REASON,
      });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
    });
  });

  // ── Scoping: the property that stops it being standing permission ──────

  describe("commit scoping — an override is about one state of the code", () => {
    it("does not apply to a commit recorded after it", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
      });
      // The branch moves on after the override was written.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "e".repeat(40),
        createdAt: new Date(Date.now() + 1000),
      });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
    });

    it("survives a squash that rewrites the tip, via supersedesSha lineage", async () => {
      // Same allowance an approval gets. Without it the override would be
      // defeated by exactly the mechanic that made review-at-tip
      // unsatisfiable in the first place.
      const reviewed = "a".repeat(40);
      const landed = "f".repeat(40);
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "0".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: reviewed });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: reviewed,
        body: GOOD_REASON,
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: landed,
        supersedesSha: reviewed,
        createdAt: new Date(Date.now() + 1000),
      });

      await callTransition(id, "executing", planGuards());
      expect(await readState(id)).toBe("executing");
    });
  });

  // ── The merge clause accepts the same claim in the other kind ──────────

  describe("merge.requires_approving_code_review — interchangeable in what it satisfies", () => {
    function mergeGuards() {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      return reg;
    }

    it("satisfies the code-review clause for a backfilled item with no review at all", async () => {
      // Ope's second ask: "requiring review artifacts is also a bit much
      // ... especially when backfilling it's just a bunch of tokens wasted."
      const id = await createTask("in_review");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
      });

      await callTransition(id, "merged", mergeGuards());
      expect(await readState(id)).toBe("merged");
    });

    it("still refuses when no override and no review exist", async () => {
      const id = await createTask("in_review");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });

      const error = await callTransition(id, "merged", mergeGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("merge.requires_approving_code_review");
    });
  });

  // ── The boundaries. The reason this file exists. ───────────────────────

  describe("the boundaries — what an override must never be able to do", () => {
    it("does NOT satisfy merge.requires_authorisation on a needs_approval item", async () => {
      // The load-bearing distinction in this whole area: an override widens
      // what counts as review EVIDENCE, never who may AUTHORISE a merge. An
      // agent may not supply a person's decision. If this ever passes, the
      // escape hatch has become a way to forge authorisation.
      const id = await createTask("in_review", "needs_approval");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
      });

      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);

      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");
    });

    it("does NOT stand in for a plan review that never happened", async () => {
      // `artifact.plan_approval` asks whether a plan was EVER approved. An
      // override says a recorded review still stands — which is not a claim
      // anybody can make about a review that was never recorded. The
      // override must not reach the existence clause.
      const id = await createTask("plan_review");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
      });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.plan_approval");
      expect(await readState(id)).toBe("plan_review");
    });

    it("ignores an override whose body is null, however well-scoped", async () => {
      // `record_artifact` refuses to write one of these without a reason, so
      // such a row should not exist. The guard asserts it anyway: a clause
      // that decides a transition must not be one edit away from accepting
      // an empty excuse.
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: null,
      });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
    });

    it("belongs to one item only — an override on a sibling does not excuse this one", async () => {
      const other = await createTask("plan_review");
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: other,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
      });

      const error = await callTransition(id, "executing", planGuards()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("artifact.evidence_at_tip");
    });
  });

  // ── The resolver, directly ─────────────────────────────────────────────

  describe("reviewEvidenceOverrideSatisfies — what the guards are reading", () => {
    it("reports the override it came to rest on, for the event payload that records the move", async () => {
      const id = await createTask("plan_review");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
        createdByType: "person",
      });

      const outcome = await prisma.$transaction(async (tx) =>
        reviewEvidenceOverrideSatisfies(tx as never, id),
      );
      expect(outcome.satisfied).toBe(true);
      expect(outcome.override?.reason).toBe(GOOD_REASON);
      // Attribution is the point: a reason nobody can attribute is a reason
      // nobody can weigh.
      expect(outcome.override?.createdByType).toBe("person");
      expect(outcome.override?.createdById).toBe("test-agent");
    });

    it("prefers the newest qualifying override", async () => {
      const id = await createTask("plan_review");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: "The older reason, superseded by the one written later.",
        createdAt: new Date(Date.now() - 10_000),
      });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
      });

      const outcome = await prisma.$transaction(async (tx) =>
        reviewEvidenceOverrideSatisfies(tx as never, id),
      );
      expect(outcome.override?.reason).toBe(GOOD_REASON);
    });

    it("reports unsatisfied, with no override, when none qualifies", async () => {
      const id = await createTask("plan_review");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });

      const outcome = await prisma.$transaction(async (tx) =>
        reviewEvidenceOverrideSatisfies(tx as never, id),
      );
      expect(outcome.satisfied).toBe(false);
      expect(outcome.override).toBeUndefined();
    });
  });

  describe("reviewEvidenceOverrideRemedy — the sentence a refused caller reads", () => {
    it("names the guard, the kind, and the reason floor", () => {
      const text = reviewEvidenceOverrideRemedy("artifact.evidence_at_tip", true);
      expect(text).toContain("artifact.evidence_at_tip");
      expect(text).toContain(REVIEW_EVIDENCE_OVERRIDE_KIND);
      expect(text).toContain(String(MIN_EVIDENCE_REASON_LENGTH));
    });

    it("tells a caller with no tip commit not to name one — a remedy that names an impossible step is not a remedy", () => {
      const withTip = reviewEvidenceOverrideRemedy("artifact.evidence_at_tip", true);
      const without = reviewEvidenceOverrideRemedy("artifact.evidence_at_tip", false);
      expect(withTip).toContain("naming this commit");
      expect(without).toContain("no commitSha");
      expect(without).not.toContain("naming this commit");
    });
  });

  describe("registration — no parallel mechanism", () => {
    it("keeps the two overridable guards in the shared registry, registered by ALL_GUARDS", () => {
      expect(guardRegistry.has("artifact.evidence_at_tip")).toBe(true);
      expect(guardRegistry.has("merge.requires_approving_code_review")).toBe(true);
      expect(ALL_GUARDS.some((g) => g.id === "artifact.evidence_at_tip")).toBe(true);
    });
  });
});
