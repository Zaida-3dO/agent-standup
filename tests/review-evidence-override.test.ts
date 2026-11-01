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
// review that never happened. The guards it feeds now nudge rather than
// refuse, so "does NOT work" reads as "does not silence the warning": each
// boundary test asserts the move lands AND the guard still speaks up. Those
// live at the bottom of this file under "the boundaries", and they are the
// reason it exists.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GuardRegistry, applyTransition } from "@/lib/service/state-machine";
import {
  ALL_GUARDS,
  MERGE_OVERRIDE_GUARD_ID,
  MERGE_OVERRIDE_REMEDY,
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
import { defineOperation, prismaTransactionRunner, ServiceRuntime } from "@/lib/service";
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

  type Nudge = { guard: string; message: string };

  /**
   * Drives a transition through `runtime.call` and returns the applied
   * answer's nudges. Every guard this file exercises now nudges rather than
   * refuses — that is what the boundary tests below pin — so each drive
   * below lands, and the open question is only what the answer says.
   */
  async function appliedNudges(itemId: string, to: string, reg: GuardRegistry): Promise<Nudge[]> {
    return ((await callTransition(itemId, to, reg)) as { nudges: Nudge[] }).nudges;
  }

  // ── The gap this closes: without an override this guard always speaks ──

  describe("artifact.evidence_at_tip — a warning, silenced by a stated reason", () => {
    it("still warns of a stale plan approval when no override exists, and moves", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("artifact.evidence_at_tip");
      expect(nudges[0]?.message).toContain("has moved since it was approved");
      expect(await readState(id)).toBe("executing");
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toEqual([]); // an applied override buys silence, not just passage
      expect(await readState(id)).toBe("executing");
    });

    it("names the repair its diagnosis calls for: re-review when the plan moved, the override when it did not", async () => {
      // The warning need not point at an escape route past a wall,
      // so each branch of the diagnosis names only the repair that cause
      // calls for — and the override is offered only where nothing actually
      // moved. Spending one on a plan that genuinely moved is the corrupted
      // count the ordering-trap rewrite in `evidence-at-tip.ts` exists to
      // prevent.
      const moved = await createTask("plan_review");
      await createArtifact({
        itemId: moved,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });
      await createArtifact({ itemId: moved, kind: "commit", commitSha: "b".repeat(40) });
      const movedNudges = await appliedNudges(moved, "executing", planGuards());
      expect(movedNudges).toHaveLength(1);
      expect(movedNudges[0]?.guard).toBe("artifact.evidence_at_tip");
      expect(movedNudges[0]?.message).toContain("get it re-reviewed");
      expect(movedNudges[0]?.message).not.toContain(REVIEW_EVIDENCE_OVERRIDE_KIND);

      // The ordering trap: no approval names a commit and a tip exists — the
      // only shape for which the override IS the named repair. The guard
      // attribution the scoring work reads ("which guard's default was
      // judged wrong" versus "overriding happened") now rides on the nudge's
      // own `guard` field instead of prose in the message.
      const unmoved = await createTask("plan_review");
      await createArtifact({
        itemId: unmoved,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
      });
      await createArtifact({ itemId: unmoved, kind: "commit", commitSha: "b".repeat(40) });
      const trapNudges = await appliedNudges(unmoved, "executing", planGuards());
      expect(trapNudges).toHaveLength(1);
      expect(trapNudges[0]?.guard).toBe("artifact.evidence_at_tip");
      expect(trapNudges[0]?.message).toContain(REVIEW_EVIDENCE_OVERRIDE_KIND);

      expect(await readState(moved)).toBe("executing");
      expect(await readState(unmoved)).toBe("executing");
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toEqual([]);
      expect(await readState(id)).toBe("executing");
    });
  });

  // ── The backfill case: an approval that never recorded a commit ────────

  describe("the sha-less anchor — the case that had a structurally untakeable remedy", () => {
    // ── The shape of the null-tip warning, stated precisely ──────────────
    //
    // The obvious reading — "the approval recorded no commit" — is NOT this
    // case, and asserting it produced two passing transitions and two failed
    // tests on the first run. `shaMatchesTipOrLineage` treats a null tip as
    // matching a null candidate, so an approval with no sha on an item with
    // no commit is not stale and the guard never fires.
    //
    // The reachable null-tip warning is the reverse: the approval RECORDS a
    // sha and the item records no commit artifact. Every approving row then
    // fails to match, and there is no tip for an override to name.
    it("warns when the approval names a sha but the item records no commit artifact", async () => {
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: "a".repeat(40),
      });

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("artifact.evidence_at_tip");
      // The no-tip diagnosis blames the missing `commit` artifact — nothing
      // has moved, so it must not ask for a re-review.
      expect(nudges[0]?.message).toContain("no `commit` artifact");
      expect(nudges[0]?.message).not.toContain("has moved since it was approved");
      expect(await readState(id)).toBe("executing");
    });

    it("honours a sha-less override on exactly that item — the warning with no sha to name", async () => {
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toEqual([]);
      expect(await readState(id)).toBe("executing");
    });

    it("an approval with no sha on an item with no commit is not stale at all — no override needed", async () => {
      // Pins the asymmetry the two tests above depend on. If this ever starts
      // warning, the null-tip semantics have changed underneath this feature
      // and the sha-less allowance is answering a different question.
      const id = await createTask("plan_review");
      await createArtifact({
        itemId: id,
        kind: "plan_review",
        verdict: "approved",
        commitSha: null,
      });

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toEqual([]);
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("executing"); // the move lands; the silence is what is lost
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("artifact.evidence_at_tip");
      // Still the no-tip diagnosis: the override names a commit the item has
      // no record of, so it excuses nothing here.
      expect(nudges[0]?.message).toContain("no `commit` artifact");
      expect(await readState(id)).toBe("executing");
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("artifact.evidence_at_tip");
      // The tip has moved past the commit the override named — the same
      // stale diagnosis as if no override existed at all.
      expect(nudges[0]?.message).toContain("not for the current tip commit");
      expect(await readState(id)).toBe("executing");
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toEqual([]); // the lineage keeps the override in force — and silent
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

      const nudges = await appliedNudges(id, "merged", mergeGuards());
      expect(nudges).toEqual([]); // the shared claim silences this clause too
      expect(await readState(id)).toBe("merged");
    });

    it("warns when no override and no review exist — the merge lands anyway", async () => {
      const id = await createTask("in_review");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });

      const nudges = await appliedNudges(id, "merged", mergeGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).toContain("No approved code_review");
      expect(await readState(id)).toBe("merged");
    });
  });

  // ── The boundaries. The reason this file exists. ───────────────────────

  describe("the boundaries — what an override must never be able to do", () => {
    it("does NOT satisfy merge.requires_authorisation on a needs_approval item", async () => {
      // The load-bearing distinction in this whole area: an override widens
      // what counts as review EVIDENCE, never who may AUTHORISE a merge. An
      // agent may not supply a person's decision. The clause nudges rather
      // than refuses now, so the forgery proof is that a review-evidence
      // override leaves the authorisation warning sounding: if this ever
      // goes silent, the escape hatch has become a way to forge
      // authorisation.
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

      const nudges = await appliedNudges(id, "merged", reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      // Warning, not person-only gate — and worded by role, never naming an
      // individual. The override is called out as no substitute in the
      // sentence itself.
      expect(nudges[0]?.message).toContain("human approval is recommended");
      expect(nudges[0]?.message).toContain("never who may authorise");
      expect(await readState(id)).toBe("merged");
    });

    it("does NOT stand in for a plan review that never happened", async () => {
      // `artifact.plan_approval` asks whether a plan was EVER approved. An
      // override says a recorded review still stands — which is not a claim
      // anybody can make about a review that was never recorded. The
      // override must not reach the existence clause. The nudge-era proof is
      // that `artifact.plan_approval` keeps warning while
      // `artifact.evidence_at_tip` stays silent: it has nothing to say with
      // no evidence at all, and an override reaching that far would make a
      // currency claim about nothing.
      const id = await createTask("plan_review");
      await createArtifact({ itemId: id, kind: "commit", commitSha: "b".repeat(40) });
      await createArtifact({
        itemId: id,
        kind: REVIEW_EVIDENCE_OVERRIDE_KIND,
        commitSha: "b".repeat(40),
        body: GOOD_REASON,
      });

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("artifact.plan_approval");
      expect(nudges[0]?.message).toContain("No approved plan_review");
      expect(await readState(id)).toBe("executing");
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("executing");
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

      const nudges = await appliedNudges(id, "executing", planGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("artifact.evidence_at_tip");
      expect(await readState(id)).toBe("executing");
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

  describe("reviewEvidenceOverrideRemedy — the override's accepted shape, still pinned to the parser", () => {
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

    // ── The syntax, not just the offer ──────────────────────────────────
    //
    // Naming the artifact kind was never the gap. A caller told to record an
    // override still has to work out which tool files it and what its fields
    // are called — and the catalogue note of 2026-09-10 records what that
    // costs: four attempts, four byte-identical refusals, and a justified
    // merge abandoned. The nudging guards do not print this sentence, but
    // their warnings name these kinds, so the literal call stays pinned —
    // a documented bypass whose shape drifts is an undiscoverable one again.
    it("names the operation that files the override, not only the artifact kind", () => {
      const text = reviewEvidenceOverrideRemedy("artifact.evidence_at_tip", true);
      // The tool name. Without it the caller is told what to record and not
      // how to record it, which is the whole defect.
      expect(text).toContain("record_artifact");
      // Every field that call needs. `createdByType`/`createdById` are
      // optional on `record_artifact` ONLY for a caller holding a live
      // assignment; a warned caller may hold none, so the example shows
      // them rather than working for the luckier half of its readers.
      expect(text).toContain("itemId");
      expect(text).toContain("body");
      expect(text).toContain("createdByType");
      expect(text).toContain("createdById");
    });

    it("shows commitSha exactly when there is a commit to name", () => {
      // The field must appear in the with-tip form and be ABSENT from the
      // no-tip one — on a commitless item only a sha-less override is
      // honoured, so printing the field there would offer the single shape
      // guaranteed to be inert.
      expect(reviewEvidenceOverrideRemedy("g", true)).toContain('"commitSha"');
      expect(reviewEvidenceOverrideRemedy("g", false)).not.toContain('"commitSha"');
    });

    // The strongest of these: it does not check for a string, it checks
    // that the printed call is one `record_artifact` actually accepts.
    // Fails if a field is renamed, misspelled, or dropped from the schema
    // while the remedy keeps advertising it — the drift that turns a
    // documented bypass back into an undiscoverable one.
    it("prints a call that record_artifact's own schema accepts", () => {
      for (const hasTip of [true, false]) {
        const text = reviewEvidenceOverrideRemedy("artifact.evidence_at_tip", hasTip);
        const json = text.slice(text.indexOf("record_artifact {") + "record_artifact ".length);
        const call = JSON.parse(json.slice(0, json.indexOf("}") + 1)) as Record<string, unknown>;

        // Placeholders stand in for values only the caller knows; the real
        // assertion is that the SHAPE parses.
        const parsed = (OPERATION_REGISTRY.record_artifact.input as z.ZodType<unknown>).safeParse({
          ...call,
          itemId: randomUUID(),
          createdById: "tester",
          ...(hasTip ? { commitSha: "a".repeat(40) } : {}),
        });
        expect(parsed.success).toBe(true);
        expect(call.artifactKind).toBe(REVIEW_EVIDENCE_OVERRIDE_KIND);
        // The field the caller must replace is present and is a
        // placeholder, not a fabricated reason — a canned justification in
        // an example is what a hurried caller copies verbatim, and it would
        // land in a permanent, counted record whose only value is that a
        // person can read it afterwards.
        expect(typeof call.body).toBe("string");
        expect(call.body).toMatch(/^<.*>$/);
        // The example must not silently satisfy the reason floor the same
        // sentence quotes: if it did, a caller could paste it unedited and
        // file a meaningless override that passed.
        expect(String(call.body).length).toBeLessThan(MIN_EVIDENCE_REASON_LENGTH * 2);
      }
    });
  });

  describe("registration — no parallel mechanism", () => {
    it("keeps the two overridable guards in the shared registry, registered by ALL_GUARDS", () => {
      expect(guardRegistry.has("artifact.evidence_at_tip")).toBe(true);
      expect(guardRegistry.has("merge.requires_approving_code_review")).toBe(true);
      expect(ALL_GUARDS.some((g) => g.id === "artifact.evidence_at_tip")).toBe(true);
    });

    // An override is filed AGAINST a named guard, and the merge remedy
    // prints that name. If the guard's own `id` drifted from the constant
    // the sentence quotes, the sentence would tell a caller to attribute an
    // override to a clause that never offered one — and the count that
    // makes overrides reviewable would be attributed to the wrong guard.
    it("prints the merge guard's own id in the sentence offering its override", () => {
      expect(mergeRequiresApprovingCodeReviewGuard.id).toBe(MERGE_OVERRIDE_GUARD_ID);
      expect(MERGE_OVERRIDE_REMEDY).toContain(mergeRequiresApprovingCodeReviewGuard.id);
      // And the merge form always names a commit: `merge.requires_commit`
      // guarantees a tip before this clause is reached, so there is no
      // sha-less shape of it to offer.
      expect(MERGE_OVERRIDE_REMEDY).toContain('"commitSha"');
      expect(MERGE_OVERRIDE_REMEDY).toContain("record_artifact");
    });
  });
});
