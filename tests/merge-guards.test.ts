// Row #18's guards: merge — commit, approving code review at the current
// review round, the visual gate, and who may authorise. See
// docs/plans/MILESTONES.md #18, SCHEMA.md §16.
//
// Runs against a real Postgres, like `artifact-guards.test.ts` and
// `guard-hierarchy.test.ts` — the claims here are about rows actually
// present (or absent) in `Artifact`, which an in-memory model cannot settle.
// Skips without TEST_DATABASE_URL.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GuardRegistry, applyTransition, rehearseTransition } from "@/lib/service/state-machine";
import {
  ALL_GUARDS,
  MERGE_GUARDS,
  currentReviewRound,
  hasApprovingArtifactAtCurrentRound,
  hasApprovingArtifactAtCurrentRoundAndTip,
  tipCommitLineage,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresAuthorisationGuard,
  mergeRequiresCommitGuard,
  mergeRequiresLinkedFollowUpGuard,
  mergeRequiresVisualReviewGuard,
} from "@/lib/service/guards";
import { guardRegistry, type GuardInput } from "@/lib/service/state-machine/guard";
import { defineOperation, prismaTransactionRunner, ServiceRuntime } from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import type { ServiceContext, TransactionHandle } from "@/lib/service/context";
import { z } from "zod";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("merge guards (#18), against Postgres", () => {
  const dbName = scratchDatabaseName("merge_guards");
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
    // Artifact FK's to Item — delete children first.
    await prisma.artifact.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(opts: {
    state: string;
    needsVisualReview?: boolean;
    mergeAuthority?: string;
  }) {
    taskCounter += 1;
    const id = `task-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${taskCounter}`,
        body: "body",
        state: opts.state as never,
        originType: "person",
        area: "web",
        needsVisualReview: opts.needsVisualReview ?? false,
        mergeAuthority: (opts.mergeAuthority ?? "pre_approved") as never,
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
    reviewRound?: number;
    createdByType?: string;
    createdAt?: Date;
    followUpItemId?: string | null;
    findings?: unknown;
    body?: string | null;
    /**
     * An explicit `id` rather than the usual `randomUUID()` default — for
     * the one test that needs to pin which artifact wins a same-`createdAt`
     * `id DESC` tie deterministically (the tiebreak's own regression test:
     * it reverts the fix under mutation, so it needs the *old* ordering to
     * have a guaranteed rather than a 50/50 answer). Every other call site
     * leaves this unset and gets the random default, which is correct there
     * — an id chosen for legibility, not insertion order.
     */
    id?: string;
  }) {
    await prisma.artifact.create({
      data: {
        id: overrides.id ?? randomUUID(),
        itemId: overrides.itemId,
        kind: overrides.kind as never,
        verdict: (overrides.verdict ?? null) as never,
        commitSha: overrides.commitSha ?? null,
        supersedesSha: overrides.supersedesSha ?? null,
        body: overrides.body ?? null,
        reviewRound: overrides.reviewRound ?? 1,
        createdByType: (overrides.createdByType ?? "agent") as never,
        createdById: "test-actor",
        followUpItemId: overrides.followUpItemId ?? null,
        ...(overrides.findings === undefined ? {} : { findings: overrides.findings as never }),
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
  }

  async function readState(itemId: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    return row.state;
  }

  function callTransition(
    itemId: string,
    to: string,
    reg: GuardRegistry,
    fields?: Record<string, unknown>,
  ) {
    const opName = `test_merge_guard_${Math.random().toString(36).slice(2)}`;
    const op = defineOperation({
      name: opName,
      kind: "write",
      summary: "test",
      input: z.object({}).strict(),
      async handler(ctx: ServiceContext) {
        return applyTransition(ctx, { itemId, to, fields }, reg);
      },
    });
    const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
    registry[opName] = op;
    return runtime.call(opName, {}).finally(() => {
      delete registry[opName];
    });
  }

  /**
   * The pass-plus-nudge pair every converted process-guard test asserts.
   * **The state read is the load-bearing half and happens here, once**: a
   * merge that carries a warning but does not actually land is a refusal
   * wearing a friendlier name, so every test that expects a nudge
   * also proves the row reached `merged`. Returns the nudges so each test
   * pins its own branch's message.
   */
  async function mergedWithNudges(
    itemId: string,
    reg: GuardRegistry,
    fields?: Record<string, unknown>,
  ): Promise<{ guard: string; message: string }[]> {
    const applied = (await callTransition(itemId, "merged", reg, fields)) as {
      nudges: { guard: string; message: string }[];
    };
    expect(await readState(itemId)).toBe("merged");
    return applied.nudges;
  }

  describe("registration — canonical service/guards convention, no parallel mechanism", () => {
    it("registers all five merge guards into the shared guardRegistry, exactly once", () => {
      expect(guardRegistry.has("merge.requires_commit")).toBe(true);
      expect(guardRegistry.has("merge.requires_approving_code_review")).toBe(true);
      expect(guardRegistry.has("merge.requires_visual_review")).toBe(true);
      expect(guardRegistry.has("merge.requires_authorisation")).toBe(true);
      expect(guardRegistry.has("merge.requires_linked_followup")).toBe(true);
    });

    it("all five apply only to entering merged, not other transitions", () => {
      for (const guard of [
        mergeRequiresCommitGuard,
        mergeRequiresApprovingCodeReviewGuard,
        mergeRequiresVisualReviewGuard,
        mergeRequiresAuthorisationGuard,
        mergeRequiresLinkedFollowUpGuard,
      ]) {
        expect(guard.appliesTo("in_review", "merged")).toBe(true);
        expect(guard.appliesTo("executing", "merged")).toBe(true);
        expect(guard.appliesTo("in_review", "blocked")).toBe(false);
        expect(guard.appliesTo("in_review", "executing")).toBe(false);
      }
    });

    it("MERGE_GUARDS is exactly the merge guard ids ALL_GUARDS registers for this row — not a fork", () => {
      // Makes the "against MERGE_GUARDS exactly as ALL_GUARDS registers
      // them" claim below verifiable rather than asserted only in prose:
      // MERGE_GUARDS is what several tests in this file register instead of
      // the full ALL_GUARDS (to avoid tangling with row #21's orthogonal
      // summary requirement), so this pins that it is not a second,
      // independently-maintained list that could silently drift from what
      // guards/index.ts actually installs.
      const mergeIdsInAllGuards = [...ALL_GUARDS]
        .map((g) => g.id)
        .filter((id) => id.startsWith("merge."))
        .sort();
      expect([...MERGE_GUARDS].map((g) => g.id).sort()).toEqual(mergeIdsInAllGuards);
    });
  });

  describe("criterion 1 — merge.requires_commit", () => {
    it("NUDGES: no commit artifact at all — the merge lands and names the gap", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresCommitGuard);
      const id = await createTask({ state: "in_review" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_commit");
      expect(nudges[0]?.message).toMatch(/No commit_sha recorded/);
      // Proof can ride the next call: both spellings silence this warning,
      // which is why the nudge message itself names them.
      expect(nudges[0]?.message).toContain("merge_proof");
      expect(nudges[0]?.message).toContain("skip_proof");
    });

    it("ALLOWS: a commit artifact exists", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresCommitGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-a" });
      const applied = (await callTransition(id, "merged", reg)) as {
        nudges: unknown[];
      };
      expect(await readState(id)).toBe("merged");
      expect(applied.nudges).toEqual([]);
    });

    it("ALLOWS silently: proof on the call is an engaged decision, not a gap", async () => {
      // The two cheap-proof spellings, asserted at the guard the keys exist
      // for: with `merge_proof` (a sentence or the PR title) or an explicit
      // `skip_proof: true`, the merge lands with NOTHING to fix — the
      // caller has already stated the proof position, so a warning would
      // be noise. And `skip_proof` must be exactly `true`: a truthy typo
      // is not a decision, and nudging for it is what keeps that honest.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresCommitGuard);
      const withProof = await createTask({ state: "in_review" });
      const proofed = (await callTransition(withProof, "merged", reg, {
        merge_proof: "PR #4111: rate limit on the public endpoint",
      })) as { nudges: unknown[] };
      expect(await readState(withProof)).toBe("merged");
      expect(proofed.nudges).toEqual([]);

      const skipping = await createTask({ state: "in_review" });
      const skipped = (await callTransition(skipping, "merged", reg, {
        skip_proof: true,
      })) as { nudges: unknown[] };
      expect(await readState(skipping)).toBe("merged");
      expect(skipped.nudges).toEqual([]);

      const typo = await createTask({ state: "in_review" });
      const nudges = await mergedWithNudges(typo, reg, { skip_proof: "true" });
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_commit");
    });
  });

  describe("criterion 2 — merge.requires_approving_code_review", () => {
    it("NUDGES: no code_review artifact at all — merged with the gap named", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).toMatch(/No approved code_review artifact/);
    });

    it("NUDGES: a code_review artifact whose verdict is changes_required, not approved", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "code_review", verdict: "changes_required" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("ALLOWS: an approved code_review artifact at round 1 (the default/only round)", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        reviewRound: 1,
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: an approval recorded for an earlier review round — merged, with the drift named", async () => {
      // The load-bearing test for the round-currency clause: round 1 was
      // approved, then a fresh artifact (e.g. a re-requested review) landed
      // at round 2, advancing max(review_round) for the item. The round-1
      // approval still exists — `hasApproval`-only logic would pass it —
      // but it is stale evidence for round 2.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        reviewRound: 1,
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "changes_required",
        reviewRound: 2,
      });

      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      // The VERDICT is what this test is for — a genuine re-review at a
      // higher round outranks the earlier approval, which is the whole point
      // of the round-currency clause. The wording assertions below only
      // require the warning to name the round limb explicitly, since a
      // sentence that describes a round mismatch and a sha mismatch in the
      // same words identifies neither.
      expect(nudges[0]?.message).toMatch(/review round 2/);
      expect(nudges[0]?.message).toMatch(/round 1/);
      // And it must not call this staleness — nothing about the commit moved.
      expect(nudges[0]?.message).toContain("NOT staleness");
    });

    it("NUDGES an approval that named no commit against a real tip, and names the two honest exits", async () => {
      // The merge was applied, so this warning's whole job is diagnosis:
      // an approval that never recorded a commit cannot be shown to cover
      // the tip — but claiming the item "has moved" would be false, and
      // the cheapest way out of a false staleness claim is pinning the
      // current sha onto a review that was not about it. With passage no
      // longer at stake, the two honest remedies (a historical
      // verification, or a reasoned merge_override for work that is not
      // about a commit at all) must be discoverable from the answer
      // itself.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        reviewRound: 1,
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tip" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      const message = nudges[0]?.message ?? "";
      expect(message).toContain("does not record which commit it applies to");
      expect(message).toContain("This is not staleness");
      expect(message).not.toContain("has moved since it was approved");
      // The remedy-naming guarantee this branch exists to provide.
      expect(message).toContain("historical_verification");
      expect(message).toContain("merge_override");
      expect(await readState(id)).toBe("merged");
    });

    // ── The round limb names WHICH artifact kind moved the round ─────────
    //
    // Occurrence seven's shape, and the reason this whole row exists. An
    // honest code_review approves at round 1 naming the exact sha that is
    // also the tip; a `check_run` then lands at round 2 and silently demotes
    // it. A refusal phrased as "not for the current review round (2) and
    // last recorded commit (9a2d2df...)" invites the reader to check the
    // sha, find it matching perfectly, and conclude the guard is broken. It
    // is not — the ROUND conjunct failed, and the sha was never compared at
    // all. Seven separate investigations went that way.
    //
    // The verdict deliberately still speaks: cross-kind round drift is the
    // mechanism by which a higher-round verification demotes a dead-follow-up
    // lgtm_with_followups, and the merge gate still needs to say so. What
    // this test pins is that the warning says which limb failed and names the
    // kind that did it.
    it("NUDGES on the ROUND limb and names the artifact kind that moved the round — a check_run demoting a matching review", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      const sha = "9a2d2df75a0f49da5aedfe37d26f77801431dc48";
      await createArtifact({ itemId: id, kind: "commit", commitSha: sha, reviewRound: 1 });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: sha,
        reviewRound: 1,
      });
      // The demoting artifact. Not a review, carries no verdict on the code,
      // and names the very same commit — nothing about the work changed.
      await createArtifact({ itemId: id, kind: "check_run", commitSha: sha, reviewRound: 2 });

      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      // The one word that would have ended all seven investigations.
      expect(nudges[0]?.message).toContain("check_run");
      // Both rounds named, so the reader can see the drift without querying.
      expect(nudges[0]?.message).toMatch(/round 1/);
      expect(nudges[0]?.message).toMatch(/review round 2/);
      // The reviewed sha is reported as what it is — a match, not a mismatch.
      expect(nudges[0]?.message).toContain(sha);
      // And the warning must NOT send the reader hunting a moved commit.
      expect(nudges[0]?.message).toContain("NOT staleness");
      expect(nudges[0]?.message).not.toMatch(/has moved since it was approved/);
    });

    // ── The sha limb — occurrence SIX, the one true positive ──────────────
    //
    // THE acceptance-criteria test. Of the seven firings investigated, six
    // were misdiagnoses and this one was correct: a review at sha S, a commit
    // at a different sha F, no `supersedesSha` linking them, same round. The
    // work really did move past its review and the guard was right to say so.
    //
    // It asserts the LIMB, not merely land-or-warn. A land-and-warn test that
    // only checked the guard id would keep passing for the wrong reason if a
    // later change routed this into the round limb or the null-tip branch,
    // which is exactly the class of silent regression this row's diagnosis
    // work is meant to prevent.
    it("NUDGES on the SHA limb — a review at one commit, a later unrelated commit at the tip (occurrence six)", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      const reviewedSha = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
      const fixSha = "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: reviewedSha,
        reviewRound: 1,
      });
      // No `supersedesSha`: this is genuinely new work, not a rewrite of the
      // reviewed commit, so the lineage is {fixSha} alone and the approval
      // correctly fails to match it.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: fixSha,
        reviewRound: 1,
      });

      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      // The sha limb, not the round limb — both shas named, and the message
      // is the staleness one, because here staleness is the honest word.
      expect(nudges[0]?.message).toContain(fixSha);
      expect(nudges[0]?.message).toContain("has moved since it was approved");
      expect(nudges[0]?.message).not.toContain("NOT staleness");
    });

    it("ALLOWS: an approval recorded at the current (later) review round", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "changes_required",
        reviewRound: 1,
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        reviewRound: 2,
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: approved at the current round, but for a commit a newer, same-round commit has since superseded — round-currency alone is not commit-currency", async () => {
      // The second composition bug review round 1's fix surfaced: round 1
      // is approved against commit-a, which is the tip at that moment — but
      // then a NEW commit (commit-b) lands still at round 1 (nothing bumps
      // the round). Round-only scoping alone would accept the round-1
      // approval as "current", even though it names a commit the tip has
      // moved past and nobody has reviewed commit-b at all.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 120_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-b",
        reviewRound: 1,
        createdAt: new Date(),
      });

      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      // "last recorded commit", not "tip commit": the value is derived from
      // the item's own commit artifacts, and calling it the tip sent a caller
      // to `git log` to find the guard wrong. Asserted as message text
      // because the wording IS the fix here — the check is unchanged.
      expect(nudges[0]?.message).toMatch(
        /not for the current review round \(1\) and last recorded commit \(commit-b\)/,
      );
      // The cheapest remedy, and the only one that does not require writing
      // something untrue.
      expect(nudges[0]?.message).toMatch(/DESCENDANT/);
      expect(nudges[0]?.message).toMatch(/Record a `commit` artifact at the reviewed commit/);
    });

    it("ALLOWS: approved at the current round AND naming the current tip commit", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(),
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("ALLOWS: an approval pinned to a 7-char abbreviation of the full-length tip commit (row 73ff36bd's recurrence, e09aa150 site 2)", async () => {
      // approvingArtifactAtCurrentRoundAndTip is the second of four sites
      // that ask "is this sha at the tip" — this pins that it now agrees
      // with latestApprovalAtTip (artifact-guards.test.ts) rather than
      // still comparing shas by exact value, which is what let a row #300
      // unblocked at plan_review hit the identical wall at merged.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "86f3af0",
        reviewRound: 1,
        createdAt: new Date(),
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });
  });

  describe("criterion 3 — merge.requires_visual_review", () => {
    it("ALLOWS: needs_visual_review is false — the clause never fires, no evidence required", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresVisualReviewGuard);
      const id = await createTask({ state: "in_review", needsVisualReview: false });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: needs_visual_review is true and no visual_review artifact exists", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresVisualReviewGuard);
      const id = await createTask({ state: "in_review", needsVisualReview: true });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_visual_review");
      expect(nudges[0]?.message).toMatch(/no approved visual_review artifact/);
      // The "nothing to look at" exit stays named: on a CI or release row the
      // flag is the wrong thing, not the missing review.
      expect(nudges[0]?.message).toMatch(/needsVisualReview: false/);
    });

    it("NUDGES: needs_visual_review is true and the only visual_review approval is stale — attached to a superseded commit", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresVisualReviewGuard);
      const id = await createTask({ state: "in_review", needsVisualReview: true });
      const earlier = new Date(Date.now() - 60_000);
      const later = new Date();
      await createArtifact({
        itemId: id,
        kind: "visual_review",
        verdict: "approved",
        commitSha: "commit-a",
        createdAt: earlier,
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "commit-b", createdAt: later });

      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_visual_review");
      // Same wording fix as the code_review guard: "last recorded commit",
      // and the ledger-is-behind remedy named before the re-review one.
      expect(nudges[0]?.message).toMatch(/not for the last recorded commit \(commit-b\)/);
      expect(nudges[0]?.message).toMatch(/DESCENDANT/);
    });

    it("ALLOWS: needs_visual_review is true and the visual_review approval is at the current tip commit", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresVisualReviewGuard);
      const id = await createTask({ state: "in_review", needsVisualReview: true });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "visual_review",
        verdict: "approved",
        commitSha: "commit-a",
        createdAt: new Date(),
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });
  });

  describe("criterion 4 — merge.requires_authorisation, per merge_authority", () => {
    it("pre_approved: ALLOWS with no further evidence", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pre_approved" });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: needs_approval when the approving code_review was recorded by an agent, not a person", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toMatch(/human approval is recommended/);
      expect(nudges[0]?.message).toMatch(/person record a merge_approval/);
    });

    it("NUDGES: a person's approving code_review does not authorise — a review is not a decision", async () => {
      // THE REGRESSION TEST FOR THE FOUR-MINUTE INCIDENT (SCHEMA.md 6e).
      //
      // This is the case that used to PASS, and its passing is what made a
      // hold overridable. `created_by_type` on a review records who WROTE it,
      // not who authorised the merge - so reading it as authorisation meant
      // the only way to satisfy a hold was to put a person's name on a review
      // an agent performed, which the guard's own message calls dishonest.
      //
      // A person reviewing the code is not the same act as a person deciding
      // it may ship, and after this change only the latter satisfies the
      // clause.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      // The nudge still names what a review is NOT, so the answer cannot be
      // read as "a person took part, so the hold is met".
      expect(nudges[0]?.message).toMatch(/This is a decision, not a review/);
    });

    it("needs_approval: ALLOWS on a person-recorded merge_approval at the tip commit", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tip" });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: "sha-tip",
        createdByType: "person",
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: a merge_approval recorded by an AGENT does not satisfy the hold — it is on a human", async () => {
      // The write path refuses this too, but the gate must not depend on that
      // alone: a row can arrive from a backfill, a fixture or direct SQL, and
      // this is the single question "may this merge without a human" rests on.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tip" });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: "sha-tip",
        createdByType: "agent",
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("NUDGES: a merge_approval at a commit the item has moved past, and says so", async () => {
      // Stale, not absent - and the warning must distinguish them, because a
      // caller told the wrong one chases the wrong remedy.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "sha-old",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: "sha-old",
        createdByType: "person",
      });
      // New work lands, declaring no supersession - so it is genuinely new.
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-new" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toMatch(/moved past/);
      expect(nudges[0]?.message).toMatch(/sha-new/);
    });

    it("needs_approval: a merge_approval carries forward across a squash (lineage), like every other clause", async () => {
      // #243's lineage reading applies here too. A person who approved the
      // branch tip that was then squash-merged approved the code that
      // shipped; refusing them because the forge rewrote the sha would make
      // this clause unsatisfiable in the workflow it most needs to work in.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "branch-tip",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: "branch-tip",
        createdByType: "person",
        createdAt: new Date(Date.now() - 30_000),
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "squashed",
        supersedesSha: "branch-tip",
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("needs_approval: ALLOWS a merge_approval pinned to a 7-char abbreviation of the full-length tip commit (e09aa150 site 3)", async () => {
      // personHasApprovedMerge is the third of four sites that ask "is this
      // sha at the tip" — before this fix it compared shas by exact value
      // via a local appliesToTip(), so an abbreviated merge_approval was
      // refused as stale even though the underlying commit was identical,
      // AND the refusal rendered as staleApprovalExists:true — sending a
      // person to re-authorise a merge for a change that never happened.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
      });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: "86f3af0",
        createdByType: "person",
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("needs_approval: a merge_override does NOT satisfy the hold (#243's stated boundary)", async () => {
      // #243 states outright that the override never satisfies
      // `needs_approval`. Asserted against the authorisation guard directly:
      // the override widens what counts as REVIEW EVIDENCE, never who may
      // AUTHORISE, and that boundary is what makes a hold mean anything.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tip" });
      await createArtifact({
        itemId: id,
        kind: "merge_override",
        commitSha: "sha-tip",
        createdByType: "person",
        body: "Nothing material changed since the review; only a doc typo was fixed.",
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toMatch(/merge_override does not substitute/);
    });

    it("needs_approval: a historical_verification does NOT satisfy the hold either", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tip" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "sha-tip",
        createdByType: "person",
        body: "Inspected the shipped code against the acceptance criteria.",
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("needs_approval: the nudge names the standing-authorisation route, and warns off the wrong one", async () => {
      // Both halves are load-bearing and neither is implied by the rule itself.
      //
      // A caller holding a standing authorisation ("merge this class of work
      // without asking me each time") reads the bare rule as "go and fetch a
      // human" and stalls on work that was already authorised — so the message
      // has to say that a standing grant lives on the ITEM, as
      // `mergeAuthority: pre-approved`, rather than in the transition request.
      // The default makes this the common case, not the exotic one: an item
      // minted by an agent lands on `needs_approval`.
      //
      // And the guard is trivially satisfiable the WRONG way, by recording the
      // artifact with `createdByType: person` — which credits a human with a
      // review an agent wrote. A refusal that leaves a tempting-but-dishonest
      // escape hatch unmentioned relies on every caller noticing unaided.
      //
      // Mutation-checked: deleting either sentence from the guard fails this
      // test and nothing else in the suite.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");

      // The remedy: the field to set, the value to set it to, and the call.
      expect(nudges[0]?.message).toMatch(/mergeAuthority/);
      expect(nudges[0]?.message).toMatch(/pre-approved/);
      expect(nudges[0]?.message).toMatch(/update_item/);

      // The anti-remedy, named so it is not discovered by accident.
      expect(nudges[0]?.message).toMatch(/created_by_type/);
      expect(nudges[0]?.message).toMatch(/WROTE/);
    });

    it("needs_approval: NUDGES with no code_review artifact at all", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("NUDGES: agent_judgement with no merge_rationale field supplied — merged, reason unstated", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "agent_judgement" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toMatch(/recorded one-line rationale/);
      expect(nudges[0]?.message).toMatch(/merge_rationale/);
    });

    it("NUDGES: agent_judgement with a blank/whitespace-only merge_rationale", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "agent_judgement" });
      const nudges = await mergedWithNudges(id, reg, { merge_rationale: "   " });
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("agent_judgement: ALLOWS once a one-line merge_rationale is supplied", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "agent_judgement" });
      await callTransition(id, "merged", reg, {
        merge_rationale: "Docs-only change, nothing to break.",
      });
      expect(await readState(id)).toBe("merged");
    });

    // ── `pr`: the authority whose evidence is a fact, not a decision ─────
    //
    // The clause reads the item's NEWEST `pull_request` artifact and refuses
    // until it reports `merged`. Every case below names the source change
    // that would make it pass wrongly, per this file's convention.

    it("pr: ALLOWS when the newest pull_request artifact reports merged", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({ itemId: id, kind: "pull_request", body: "merged" });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: pr while the PR is still open, and says to merge it", async () => {
      // The ordinary unmet case. Fails if the clause returns guardOk without
      // consulting the artifact — i.e. if `pr` were treated as an alias for
      // `pre_approved`, which is the shape a careless implementation takes.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({ itemId: id, kind: "pull_request", body: "open" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toMatch(/reports `open`/);
    });

    it("NUDGES: a CLOSED pull request — closed is not merged", async () => {
      // THE POINT OF THE WHOLE CHANGE. Before `merged` existed as a status,
      // a PR that merged and a PR abandoned without merging both stored as
      // `closed`, so a gate reading the status could not tell "the work
      // landed" from "the work was dropped" — and would have passed the
      // abandoned one. Fails if `closed` is ever treated as satisfying, or
      // if the two statuses are collapsed back together.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({ itemId: id, kind: "pull_request", body: "closed" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toMatch(/A closed PR is not a merged one/);
    });

    it("NUDGES: pr with no pull_request artifact at all, and names the recording remedy", async () => {
      // A distinct fault from "the PR is open", and deliberately given a
      // different message: this is usually a bookkeeping gap (the PR exists
      // and nobody recorded it), so telling this caller to "merge your PR"
      // sends them to look at one that may already have merged. Fails if the
      // two cases are folded into one message.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toMatch(/no pull_request artifact has been recorded/);
    });

    it("pr: reads the NEWEST row only — a later close supersedes an earlier merge", async () => {
      // Artifacts are append-only and a status change is a new row, so an
      // item can have merged, then had a follow-up PR closed unmerged. Only
      // the last row describes the PR now.
      //
      // Fails if the clause is written as "does ANY pull_request row say
      // merged", which is the obvious-but-wrong reading and passes exactly
      // the abandoned-work case this authority exists to catch.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({
        itemId: id,
        kind: "pull_request",
        body: "merged",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "pull_request",
        body: "closed",
        createdAt: new Date(),
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("pr: reads the NEWEST row only — a later merge supersedes an earlier close", async () => {
      // The same rule in the allowing direction, so the test above cannot be
      // satisfied by a clause that simply refuses whenever any `closed` row
      // exists. A re-proposed piece of work that finally landed must merge.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({
        itemId: id,
        kind: "pull_request",
        body: "closed",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "pull_request",
        body: "merged",
        createdAt: new Date(),
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: a draft PR — a draft has not landed", async () => {
      // `draft` joined the vocabulary in the same change as `merged`. It is
      // not a near-miss for merged and must not read as one.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({ itemId: id, kind: "pull_request", body: "draft" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toMatch(/reports `draft`/);
    });

    it("pr: a merge_approval does NOT satisfy it — the condition is a fact, not a decision", async () => {
      // The boundary that keeps this authority meaningful, asserted the same
      // way `needs_approval`'s boundaries are. No human decision substitutes
      // for the PR actually having merged: a person cannot approve their way
      // past a PR that is still open, because the clause is not asking
      // anyone's permission.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tip" });
      await createArtifact({ itemId: id, kind: "pull_request", body: "open" });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: "sha-tip",
        createdByType: "person",
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      // The warning itself says no decision substitutes for the fact.
      expect(nudges[0]?.message).toMatch(/Nothing substitutes for that fact/);
    });

    it("pr: is STRICTER than pre_approved — the same evidence lands silently there and with a warning on pr", async () => {
      // The claim the migration and the guard doc both make, stated as a
      // test rather than as prose. A fourth value on an authorisation enum
      // reads like a loosening, and this is what shows it is not: identical
      // evidence, and `pr` is the one that still says something.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);

      const permissive = await createTask({ state: "in_review", mergeAuthority: "pre_approved" });
      await createArtifact({ itemId: permissive, kind: "pull_request", body: "open" });
      const silent = (await callTransition(permissive, "merged", reg)) as { nudges: unknown[] };
      expect(await readState(permissive)).toBe("merged");
      expect(silent.nudges).toEqual([]);

      const gated = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({ itemId: gated, kind: "pull_request", body: "open" });
      const nudges = await mergedWithNudges(gated, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("pr: an unrecognised legacy body falls through to open and NUDGES, rather than passing", async () => {
      // The read path is lenient about rows written before the status
      // vocabulary existed, and that leniency has to fail safe here: an
      // unrecognised body reads as `open`, so the gate warns. Fails if the
      // fallback is ever changed to something that satisfies this clause,
      // which would let an unvalidated row authorise a merge.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "pr" });
      await createArtifact({ itemId: id, kind: "pull_request", body: "some old note" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("NUDGES: a person's approval at an EARLIER round than the current one — round-2 review-1 defect", async () => {
      // The regression test for the composition bug review round 1 found:
      // a person approved code_review at round 1; the item was then
      // re-reviewed and approved again, this time only by an agent, at
      // round 2 (the current round). `merge.requires_approving_code_review`
      // is satisfied by the round-2 (agent) approval; before the fix,
      // `hasPersonApprovedCodeReview` scanned every round and was satisfied
      // by the round-1 (person) approval — two DIFFERENT artifacts, each
      // individually satisfying its own guard, letting the item merge with
      // no human having looked at what actually shipped at round 2.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
        reviewRound: 1,
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
        reviewRound: 2,
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("needs_approval: a new review ROUND at the same commit does not expire a person's decision", async () => {
      // Deliberately NOT round-scoped, unlike the review clauses (SCHEMA.md
      // 6e). A review is a statement about a round of work; a person's
      // decision is a statement about a state of the CODE, which the commit
      // scope already pins exactly.
      //
      // Round-scoping it would expire a human decision because a REVIEWER
      // opened another round at the same commit - invalidating the person's
      // approval through an act the person had no part in, and sending
      // someone back to them for a signature nothing had changed under.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tip" });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: "sha-tip",
        createdByType: "person",
        reviewRound: 1,
      });
      // A second review round lands at the SAME commit. The code the person
      // approved is unchanged, so their decision still applies.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
        commitSha: "sha-tip",
        reviewRound: 2,
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: a person's approval at the current round but for a superseded commit — round-currency alone is not commit-currency", async () => {
      // The second composition bug: a person's approval sits at the
      // current round, but for a commit a newer, same-round commit has
      // since superseded. The current round's actual tip-matching approval
      // is agent-only — so a person having approved *something* at the
      // current round is not the same as a person having approved what
      // actually shipped.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 120_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 90_000),
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-b",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
        commitSha: "commit-b",
        reviewRound: 1,
        createdAt: new Date(),
      });

      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("needs_approval: NUDGES an unpinned merge_approval once a real tip exists", async () => {
      // An approval recording no commit cannot be shown to be about the code
      // that would ship, so the clause is unmet the moment there is a tip to
      // be stale against. Same reading artifact-tip.ts documents.
      //
      // The write path requires a commitSha, so this row can only arrive from
      // another writer - which is exactly why the gate checks it too.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: null,
        createdByType: "person",
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tip" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("REFUSES a merge_authority value outside the three declared ones — defensive against an enum drift", async () => {
      // Exercised at the guard's own `check()`, not through the database:
      // `mergeAuthority` is a Prisma enum column with only the three
      // declared values, so this branch is unreachable through a normal
      // write — this proves the guard's own defensive check independently
      // of whether the schema could ever produce the value.
      const input: GuardInput = {
        item: {
          id: "task-unrecognised-authority",
          kind: "task",
          state: "in_review",
          blockedReason: null,
          blockedOnType: null,
          blockedOnPersonId: null,
          unblockAt: null,
          pauseReason: null,
          resumeCondition: null,
          needsVisualReview: false,
          mergeAuthority: "not_a_real_authority",
        },
        from: "in_review",
        to: "merged",
        fields: {},
        db: {
          $queryRawUnsafe: async <T = unknown>() => [] as T,
          $executeRawUnsafe: async () => 0,
        },
        settings: defaultSnapshot(),
      };
      const result = await mergeRequiresAuthorisationGuard.check(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/Unrecognised merge_authority: not_a_real_authority/);
      }
    });
  });

  describe("all four together — the full merged gate, matching SCHEMA.md §16's row exactly", () => {
    it("warns for EVERY missing clause at once, and falls silent clause by clause as they are met", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresCommitGuard);
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      reg.register(mergeRequiresVisualReviewGuard);
      reg.register(mergeRequiresAuthorisationGuard);

      const id = await createTask({
        state: "in_review",
        needsVisualReview: true,
        mergeAuthority: "needs_approval",
      });

      // The composition claim: where a refuse-first design would report
      // exactly one clause and hide the other three, the nudge gate lists
      // every gap in one answer, in
      // registration order — a caller fixing one gap learns about the rest
      // in the same call instead of discovering them one round trip at a
      // time. The merge landed on every step below; `mergedWithNudges`
      // asserts that.
      const nothingRecorded = await mergedWithNudges(id, reg);
      expect(nothingRecorded.map((n) => n.guard)).toEqual([
        "merge.requires_commit",
        "merge.requires_approving_code_review",
        "merge.requires_visual_review",
        "merge.requires_authorisation",
      ]);

      await createArtifact({ itemId: id, kind: "commit", commitSha: "commit-a" });
      const withCommit = await mergedWithNudges(id, reg);
      expect(withCommit.map((n) => n.guard)).toEqual([
        "merge.requires_approving_code_review",
        "merge.requires_visual_review",
        "merge.requires_authorisation",
      ]);

      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
        commitSha: "commit-a",
      });
      const withReview = await mergedWithNudges(id, reg);
      expect(withReview.map((n) => n.guard)).toEqual([
        "merge.requires_visual_review",
        "merge.requires_authorisation",
      ]);

      await createArtifact({
        itemId: id,
        kind: "visual_review",
        verdict: "approved",
        commitSha: "commit-a",
      });
      // Every review clause is now satisfied; only the human DECISION is
      // still owed.
      const withVisual = await mergedWithNudges(id, reg);
      expect(withVisual.map((n) => n.guard)).toEqual(["merge.requires_authorisation"]);

      // Recording the review a SECOND time as a person does not clear it -
      // it is not an authorisation, and this is the step that used to let
      // the hold be walked past.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
        commitSha: "commit-a",
        reviewRound: 1,
      });
      const personReviewAgain = await mergedWithNudges(id, reg);
      expect(personReviewAgain.map((n) => n.guard)).toEqual(["merge.requires_authorisation"]);

      // Only the person's recorded decision silences the last warning.
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        createdByType: "person",
        commitSha: "commit-a",
      });
      const complete = (await callTransition(id, "merged", reg)) as { nudges: unknown[] };
      expect(await readState(id)).toBe("merged");
      expect(complete.nudges).toEqual([]);
    });

    it("NUDGES the review round 1 defect: person-approved at an earlier round, agent-only approved at the current round, commit present — against MERGE_GUARDS exactly as ALL_GUARDS registers them", async () => {
      // Reproduces review round 1's finding verbatim, against
      // `MERGE_GUARDS` — the exact four-guard array `ALL_GUARDS`
      // (`src/lib/service/guards/index.ts`) installs into `guardRegistry`
      // for this row, not a hand-picked subset built here independently —
      // so this proves the composed *merge* gate, not just one guard in
      // isolation. (Not the full `ALL_GUARDS`: that also includes row
      // #21's `summaries.required_and_valid`, which fires first on
      // entering `merged` per `runGuards`'s stop-at-first-rejection order
      // and would mask this scenario behind an unrelated "no summary
      // supplied" rejection — an orthogonal requirement this test isn't
      // about.) Before the fix: commit present, round-1 approved by a
      // person, round-2 approved only by an agent →
      // `merge.requires_approving_code_review` accepted the round-2
      // (agent) approval as "the current round's approval", and
      // `merge.requires_authorisation`'s old `hasPersonApprovedCodeReview`
      // (unscoped to round) accepted the round-1 (person) approval as
      // evidence a person approved *something* — two different artifacts,
      // each satisfying a different guard, and the item merged with no
      // human ever having reviewed the code that actually shipped at
      // round 2. `mergeAuthority: needs_approval`, `needsVisualReview:
      // false` (isolating this to the two guards under test — the visual
      // gate is covered separately above).
      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) {
        reg.register(guard);
      }
      const id = await createTask({
        state: "in_review",
        needsVisualReview: false,
        mergeAuthority: "needs_approval",
      });

      // A commit lands (the tip). Round 1 is approved by a person against
      // an EARLIER commit (the item then moves on) — round 2's approval,
      // by an agent only, is the one that actually matches the tip.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
        commitSha: "commit-a",
        reviewRound: 1,
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-b",
        createdAt: new Date(),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
        commitSha: "commit-b",
        reviewRound: 2,
      });

      // The review clause is satisfied by the round-2 agent approval, so a
      // gate that only checked "a person approved SOMETHING" would let this
      // through silently — the composition defect. The composed gate merges
      // and warns, and the single warning names the authorisation clause:
      // the person's round-1 approval is not evidence about what shipped.
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });
  });

  describe("the reusable helpers directly (merge-review-round.ts)", () => {
    it("currentReviewRound defaults to 1 with no artifacts, and reports the max otherwise", async () => {
      const id = await createTask({ state: "in_review" });
      expect(await currentReviewRound(prisma, id)).toBe(1);
      await createArtifact({ itemId: id, kind: "code_review", reviewRound: 3 });
      await createArtifact({ itemId: id, kind: "commit", reviewRound: 1 });
      expect(await currentReviewRound(prisma, id)).toBe(3);
    });

    it("hasApprovingArtifactAtCurrentRound is false when the only approval is at an earlier round", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        reviewRound: 1,
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "changes_required",
        reviewRound: 2,
      });
      expect(await hasApprovingArtifactAtCurrentRound(prisma, id, "code_review")).toBe(false);
    });

    it("hasApprovingArtifactAtCurrentRoundAndTip is false when the current-round approval names a commit the tip has moved past", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 120_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-b",
        reviewRound: 1,
        createdAt: new Date(),
      });
      // Round-only: the round-1 approval IS at the current round (round
      // never advanced past 1), so this stays true — proving the two
      // helpers really do answer different questions.
      expect(await hasApprovingArtifactAtCurrentRound(prisma, id, "code_review")).toBe(true);
      // Round-and-tip: false, because that same approval names commit-a,
      // not the current tip (commit-b).
      expect(await hasApprovingArtifactAtCurrentRoundAndTip(prisma, id, "code_review")).toBe(false);
    });

    it("hasApprovingArtifactAtCurrentRoundAndTip is true when the current-round approval names the current tip commit", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "commit-a",
        reviewRound: 1,
        createdAt: new Date(),
      });
      expect(await hasApprovingArtifactAtCurrentRoundAndTip(prisma, id, "code_review")).toBe(true);
    });
  });

  // ── The tiered review vocabulary (SCHEMA.md §6a) ────────────────────────
  //
  // These prove the two halves of "additive": every tier now satisfies the
  // clauses that only `'approved'` used to, and nothing that was refused
  // before is accepted now.
  describe("tiered verdicts — which ones the merge gate accepts", () => {
    for (const verdict of ["lgtm", "lgtm_with_nits", "approved"]) {
      it(`ACCEPTS: a ${verdict} code_review at the current round and tip`, async () => {
        const reg = new GuardRegistry();
        reg.register(mergeRequiresApprovingCodeReviewGuard);
        const id = await createTask({ state: "in_review" });
        await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-tier" });
        await createArtifact({
          itemId: id,
          kind: "code_review",
          verdict,
          commitSha: "sha-tier",
        });
        await callTransition(id, "merged", reg);
        expect(await readState(id)).toBe("merged");
      });
    }

    it("NUDGES: an `na` verdict — a legal value that is not an approval", async () => {
      // The interesting distinction. An "everything except changes_required"
      // reading of the enum would wave this through, and `na` is what a
      // commit or a test-run artifact carries — an item would merge on the
      // strength of an artifact that reviewed nothing. The merge lands with
      // the warning: the clause still draws the line, it just does not
      // stand on it.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-na" });
      await createArtifact({ itemId: id, kind: "code_review", verdict: "na", commitSha: "sha-na" });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("NUDGES: changes_required, unchanged by the tiering", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-cr" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "changes_required",
        commitSha: "sha-cr",
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("REFUSES at the database: a verdict outside the enum", async () => {
      // The hyphenated spelling is the one a human or a source store writes,
      // and the column does not hold it. Proven against Postgres because
      // TypeScript's union says nothing about what the column accepts.
      const id = await createTask({ state: "in_review" });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Artifact" ("id", "itemId", "kind", "verdict", "createdByType", "createdById")
           VALUES ($1, $2, 'code_review'::"ArtifactKind", $3::"Verdict", 'agent'::"HolderType", 'x')`,
          randomUUID(),
          id,
          "lgtm-with-nits",
        ),
      ).rejects.toThrow();
    });

    it("stores a findings list with severities, and a MEDIUM under lgtm_with_nits speaks up", async () => {
      // Findings change the merge outcome beneath exactly one verdict:
      // `lgtm_with_nits` claims the remainder is cosmetic, and a medium
      // finding contradicts the verdict's own terms.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-find" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        commitSha: "sha-find",
        findings: [
          { text: "the retry path is untested", severity: "medium" },
          { text: "a stray log line", severity: "low" },
        ],
      });
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      // The warning quotes the finding, so the caller does not have to go
      // and look it up - the failure this gate addresses is a merging party
      // who never read the review. Only the BLOCKING findings are quoted:
      // the low one is not what the clause objects to.
      expect(nudges[0]?.message).toMatch(/the retry path is untested/);
      expect(nudges[0]?.message).not.toMatch(/a stray log line/);

      // Still stored verbatim - the gate reads findings, it does not rewrite them.
      const stored = await prisma.artifact.findFirstOrThrow({
        where: { itemId: id, kind: "code_review" },
      });
      expect(stored.findings).toEqual([
        { text: "the retry path is untested", severity: "medium" },
        { text: "a stray log line", severity: "low" },
      ]);
    });

    it("lgtm_with_nits with only LOW/INFO findings still merges", async () => {
      // The other half of the rule, and the one that keeps the tier usable:
      // nits are what the verdict is FOR. A gate that blocked on any finding
      // at all would make `lgtm_with_nits` identical to `changes_required`.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-nits" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        commitSha: "sha-nits",
        findings: [
          { text: "a stray log line", severity: "low" },
          { text: "naming quibble", severity: "info" },
        ],
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("a CRITICAL finding under a plain lgtm does NOT block - the verdict carries the weight", async () => {
      // The deliberate asymmetry, and the one most likely to be "fixed" by a
      // later reader who thinks it is an oversight. A plain `lgtm` makes no
      // claim about the severity of what was found; a reviewer recording a
      // critical finding alongside it has stated, attributably, that it does
      // not block. Reading severity there would let a recorded observation
      // silently overrule an explicit approval.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-crit" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "sha-crit",
        findings: [{ text: "unbounded recursion on a rare path", severity: "critical" }],
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("a HIGH finding under lgtm_with_followups does NOT block - that tier is FOR real findings", async () => {
      // `lgtm_with_followups` already pays for its bargain through
      // merge.requires_linked_followup. Grading it here would double-charge
      // it and make the tier unusable for the case it exists to serve.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      const followUp = await createTask({ state: "on_deck" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-fu" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "sha-fu",
        followUpItemId: followUp,
        findings: [{ text: "the cache is never invalidated", severity: "high" }],
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("an UNGRADED finding under lgtm_with_nits does not block", async () => {
      // Absent severity reads as "ungraded", which is a different claim from
      // "graded low" (findings.ts). Blocking on it would be the gate grading
      // a finding the reviewer declined to grade, and every review recorded
      // before the vocabulary existed is ungraded.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-ung" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        commitSha: "sha-ung",
        findings: [{ text: "no severity was recorded for this one" }],
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("a malformed findings document does not block - the verdict decides alone", async () => {
      // A row written before the validator existed, or by any other writer,
      // must not become an item that can never merge, refused for a column
      // the merging party did not write and cannot correct. Refusing to merge
      // is a stronger action than this clause is entitled to take on data it
      // cannot read.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-bad" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        commitSha: "sha-bad",
        findings: { not: "an array" },
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("the severity clause grades the artifact the gate RESTS ON, not merely the newest", async () => {
      // The composition property. Two approving reviews at the same round and
      // tip: the newest is a clean `lgtm`, the one before it a
      // `lgtm_with_nits` carrying a medium.
      // `approvingArtifactAtCurrentRoundAndTip` resolves newest-first, so the
      // gate rests on the clean one and must grade THAT - not re-query for
      // "some review with findings".
      //
      // Getting this wrong in either direction is a real bug: grading a
      // different artifact from the one relied on is exactly the shape of the
      // composition regressions this file guards against.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "sha-two",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        commitSha: "sha-two",
        findings: [{ text: "found on the first pass", severity: "medium" }],
        createdAt: new Date("2026-01-01T10:01:00Z"),
      });
      // Re-reviewed at the same round and tip, and found clean.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "sha-two",
        createdAt: new Date("2026-01-01T10:02:00Z"),
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("lgtm_with_nits goes stale when the nits are addressed — and the second merge is clean once re-reviewed", async () => {
      // This is the whole "merge after nits" rule, and it needs no gate of
      // its own: addressing a nit produces a commit, the commit moves the
      // tip, and the existing tip-currency check warns about the now-stale
      // approval — loudly, and until a light re-review lands at the new
      // tip, after which the merge answers with nothing to say.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "sha-before-nits",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_nits",
        commitSha: "sha-before-nits",
        createdAt: new Date("2026-01-01T10:01:00Z"),
      });
      // The nit is addressed — a new commit, and the approval is now stale.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "sha-after-nits",
        createdAt: new Date("2026-01-01T11:00:00Z"),
      });
      const first = await mergedWithNudges(id, reg);
      expect(first).toHaveLength(1);
      expect(first[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(first[0]?.message).toContain("has moved since it was approved");

      // The light re-review at the new tip.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "sha-after-nits",
        createdAt: new Date("2026-01-01T11:05:00Z"),
      });
      const second = await mergedWithNudges(id, reg);
      expect(second).toEqual([]);
    });
  });

  // ── criterion 5 — merge.requires_linked_followup ────────────────────────
  describe("criterion 5 — merge.requires_linked_followup", () => {
    /** An item approved with `verdict` at its own tip, optionally linking a follow-up. */
    async function approvedWith(verdict: string, followUpItemId?: string | null) {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: `sha-${id}` });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict,
        commitSha: `sha-${id}`,
        followUpItemId: followUpItemId ?? null,
      });
      return id;
    }

    function registry() {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresLinkedFollowUpGuard);
      return reg;
    }

    it("NUDGES: lgtm_with_followups with no follow-up linked", async () => {
      // The warning this verdict needs to stay honest. Without it the
      // verdict is strictly the cheapest option available to a reviewer and
      // nothing ever checks the other half of the bargain.
      const id = await approvedWith("lgtm_with_followups");
      const nudges = await mergedWithNudges(id, registry());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_linked_followup");
    });

    it("ACCEPTS: lgtm_with_followups linking an open follow-up item", async () => {
      const followUp = await createTask({ state: "on_deck" });
      const id = await approvedWith("lgtm_with_followups", followUp);
      await callTransition(id, "merged", registry());
      expect(await readState(id)).toBe("merged");
    });

    for (const closedState of ["merged", "wont_do", "cancelled", "research_done"]) {
      it(`NUDGES: lgtm_with_followups linking a follow-up already ${closedState}`, async () => {
        // Linking a dead item would satisfy the letter of the rule and
        // defeat it entirely — the findings would be attached to something
        // nobody is going to pick up. Single-character mutation this
        // catches: removing any one entry from CLOSED_ITEM_STATES.
        const followUp = await createTask({ state: closedState });
        const id = await approvedWith("lgtm_with_followups", followUp);
        const nudges = await mergedWithNudges(id, registry());
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.guard).toBe("merge.requires_linked_followup");
        expect(nudges[0]?.message).toContain(closedState);
      });
    }

    for (const openState of ["on_deck", "executing", "blocked", "paused", "planning"]) {
      it(`ACCEPTS: a follow-up in the open state ${openState}`, async () => {
        // `blocked` and `paused` are deliberately accepted: the work is
        // still owed, it is just waiting on something. Refusing them would
        // make the verdict unusable in exactly the situations that produce
        // follow-ups most often.
        const followUp = await createTask({ state: openState });
        const id = await approvedWith("lgtm_with_followups", followUp);
        await callTransition(id, "merged", registry());
        expect(await readState(id)).toBe("merged");
      });
    }

    for (const verdict of ["lgtm", "lgtm_with_nits", "approved"]) {
      it(`does NOT fire for a ${verdict} approval with no follow-up linked`, async () => {
        // The over-blocking check. A guard that demanded a follow-up from
        // every tier would make the other three unmergeable, which no test
        // asserting only the refusal would notice.
        const id = await approvedWith(verdict);
        await callTransition(id, "merged", registry());
        expect(await readState(id)).toBe("merged");
      });
    }

    it("stays silent when there is no qualifying approval at all", async () => {
      // That item already gets its warning from
      // merge.requires_approving_code_review, and a second one naming a
      // different cause would only obscure the real one. Registered alone
      // here, so "silent" is observable: the transition succeeds with
      // nothing at all on the answer.
      const id = await createTask({ state: "in_review" });
      await callTransition(id, "merged", registry());
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES: the link is on a STALE approval and the tip approval has none", async () => {
      // Guards against the obvious way round this rule: link a follow-up
      // once, then keep re-reviewing with lgtm_with_followups and no link.
      // The guard reads the same artifact the merge is resting on — the one
      // at the current tip — not any artifact that ever carried a link.
      const followUp = await createTask({ state: "on_deck" });
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "sha-old",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "sha-old",
        followUpItemId: followUp,
        createdAt: new Date("2026-01-01T10:01:00Z"),
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "sha-new",
        createdAt: new Date("2026-01-01T11:00:00Z"),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "sha-new",
        followUpItemId: null,
        createdAt: new Date("2026-01-01T11:01:00Z"),
      });
      const nudges = await mergedWithNudges(id, registry());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_linked_followup");
    });

    it("reads the NEWEST approval at the tip when two exist at the same round", async () => {
      // Two approvals at the same round and tip is ordinary — a first review
      // defers findings, a second finds it clean. The newest is the current
      // word on the change, so a later plain `lgtm` releases the follow-up
      // requirement the earlier one imposed.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-two" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "sha-two",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "sha-two",
        createdAt: new Date("2026-01-01T10:30:00Z"),
      });
      await callTransition(id, "merged", registry());
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES when the newest approval at the tip is the one deferring findings", async () => {
      // The mirror of the case above, so "newest wins" is pinned in both
      // directions rather than only in the direction that permits a merge.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-two-b" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "sha-two-b",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "sha-two-b",
        createdAt: new Date("2026-01-01T10:30:00Z"),
      });
      const nudges = await mergedWithNudges(id, registry());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_linked_followup");
    });
  });

  // #138 — closing work that finished before this installation existed.
  // The clause under test is the historical-verification alternative inside
  // `merge.requires_approving_code_review`. Every case here is about the
  // shape of that alternative: what it accepts, what it refuses, and — the
  // load-bearing half — what it leaves untouched.
  describe("criterion 2b — historical_verification as an alternative to an approving code_review", () => {
    const ENV_VAR = "ENABLE_HISTORICAL_VERIFICATION";
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_VAR];
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = savedEnv;
    });

    function openWindow() {
      process.env[ENV_VAR] = "true";
    }

    function reviewClauseOnly() {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      return reg;
    }

    /**
     * Every merge guard, as production installs them.
     *
     * The single-clause registry above isolates *which* clause answered, which
     * is what most of these cases are about. It cannot answer the question the
     * follow-up obligation actually poses — "can this item reach `merged`" —
     * because the guard enforcing that obligation is not in it. A case that
     * asserts a merge succeeds, or that an obligation survives, has to run
     * against the whole conjunction or it is asserting about a system nobody
     * runs.
     */
    function allMergeGuards() {
      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      return reg;
    }

    it("NUDGES while the window is CLOSED, even with a perfectly-formed artifact — the default posture is unchanged", async () => {
      // The most important case in this block. With the window shut, this
      // path does not exist, and the guard must say exactly what it said
      // before the alternative was added — a warning that names no
      // historical route, because with the window shut there is none.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "Read src/app at abc123: the routes named in the brief are absent.",
      });
      delete process.env[ENV_VAR];

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).not.toContain("historical_verification");
    });

    it("NUDGES for every near-miss spelling of the flag — the window fails closed", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected",
      });

      for (const value of ["1", "yes", "on", "TRUE", "True", "true ", " true", "", "false"]) {
        process.env[ENV_VAR] = value;
        const nudges = await mergedWithNudges(id, reviewClauseOnly());
        expect(nudges).toHaveLength(1);
        expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
        // Fails closed all the way: the warning must not offer the route the
        // misspelling did not turn on.
        expect(nudges[0]?.message).not.toContain("historical_verification");
      }
    });

    it("ALLOWS with the window open and an artifact naming the tip commit — the case the whole row exists for", async () => {
      openWindow();
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "Verified against merged code at abc123; the routes are gone and no links remain.",
      });

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toEqual([]);
    });

    it("NUDGES when the verification names a commit the tip has moved past — an inspection of superseded code proves nothing about what ships", async () => {
      openWindow();
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "old111",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "old111",
        body: "inspected at commit old111",
      });
      // A newer commit moves the tip; the inspection is now about code that
      // is not what would ship.
      await createArtifact({ itemId: id, kind: "commit", commitSha: "new222" });

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("NUDGES a verification with no body — the evidence IS the difference from an unfalsifiable approval", async () => {
      // `record_artifact` refuses to write this row; the guard asserts it
      // independently, because this is the clause that decides a merge and
      // it must not rest on an upstream validator staying correct.
      openWindow();
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: null,
      });

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("does NOT satisfy merge_authority needs_approval — a person's sign-off is still required", async () => {
      // The narrowest and most important boundary: this path widens what
      // counts as review EVIDENCE, never what counts as AUTHORISATION.
      openWindow();
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        // Authored by a PERSON deliberately. The authorisation clause also
        // requires `createdByType = 'person'`, so an agent-authored artifact
        // would be warned for that reason instead and this test would pass
        // without ever exercising the kind check — leaving the guarantee it
        // claims to protect undefended against a future edit that widened
        // the query's `kind` filter.
        createdByType: "person",
      });

      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toContain("needs_approval");
    });

    it("does NOT satisfy needs_approval even when person-authored AND carrying an approving verdict — the defence in depth, spelled out", async () => {
      // The clause is defended twice over, and a test that exercises only one
      // layer passes for the wrong reason.
      //
      //   1. `record_artifact` refuses a verdict on a non-review kind, so a
      //      verification with an approving verdict cannot be written through
      //      the product at all. That is the PRIMARY defence, and it is what
      //      makes the authorisation query's `verdict = ANY(...)` filter
      //      exclude this kind regardless of anything else.
      //   2. The query is additionally scoped to `kind = 'code_review'`.
      //
      // This inserts the artifact DIRECTLY, bypassing (1), so that (2) is the
      // only thing left standing — otherwise widening the query's `kind`
      // filter would be an undetectable regression. Person-authored and
      // approving, so neither `createdByType` nor `verdict` can be the reason
      // it warns.
      openWindow();
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        createdByType: "person",
        verdict: "approved",
      });

      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
      expect(nudges[0]?.message).toContain("needs_approval");
    });

    it("does NOT satisfy the visual-review clause — an unrelated requirement stays unrelated", async () => {
      openWindow();
      const id = await createTask({ state: "in_review", needsVisualReview: true });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
      });

      const reg = new GuardRegistry();
      reg.register(mergeRequiresVisualReviewGuard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_visual_review");
    });

    it("leaves the lgtm_with_followups obligation intact where such an approval actually exists", async () => {
      // The reading worth disproving: because the historical path can
      // satisfy the code-review clause without a `code_review`, one might
      // expect `merge.requires_linked_followup` to go quiet and let an
      // unhonoured lgtm_with_followups bargain through. It cannot — where a
      // qualifying approval carrying that verdict exists, that guard reads
      // it and warns exactly as before.
      openWindow();
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "abc123",
        followUpItemId: null,
      });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
      });

      const reg = new GuardRegistry();
      reg.register(mergeRequiresLinkedFollowUpGuard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_linked_followup");
    });

    // ── The follow-up bargain cannot be dissolved by an inspection ────────
    //
    // Found by adversarial probe, not by reading: `merge.requires_linked_followup`
    // resolves its approval by ROUND AND TIP, so an honest `lgtm_with_followups`
    // stops qualifying when either moves and that guard then correctly says
    // nothing. That was safe only while the same non-qualification made the
    // code-review clause speak up — and it still does, by name: the review
    // clause itself warns when an inspection would dissolve an unhonoured
    // bargain. Both demotion routes are pinned here.
    it("NUDGES when a higher-round verification demotes an lgtm_with_followups whose follow-up is dead — round demotion", async () => {
      openWindow();
      const id = await createTask({ state: "in_review" });
      const deadFollowUp = await createTask({ state: "cancelled" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "abc123",
        reviewRound: 1,
        followUpItemId: deadFollowUp,
      });
      // `currentReviewRound` is MAX(reviewRound) across EVERY kind, so this
      // one artifact pushes the item to round 2 and the honest review at
      // round 1 stops qualifying — one caller-supplied parameter.
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        reviewRound: 2,
      });

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      // The warning must name the real obstacle. Telling the caller to go and
      // get a code review, when the actual problem is a dead follow-up, sends
      // them to fix the wrong thing.
      expect(nudges[0]?.message).toContain("follow-up");
    });

    it("NUDGES when a verification at a newer tip demotes an lgtm_with_followups whose follow-up is dead — tip demotion, no explicit round needed", async () => {
      openWindow();
      const id = await createTask({ state: "in_review" });
      const deadFollowUp = await createTask({ state: "wont_do" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "old111",
        createdAt: new Date(Date.now() - 60_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "old111",
        followUpItemId: deadFollowUp,
        createdAt: new Date(Date.now() - 50_000),
      });
      // A newer commit moves the tip, so the review fails to qualify on the
      // tip axis alone, with every artifact still at round 1.
      await createArtifact({ itemId: id, kind: "commit", commitSha: "new222" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "new222",
        body: "inspected at new222",
      });

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).toContain("follow-up");
    });

    it("ALLOWS a demoted lgtm_with_followups whose follow-up is still LIVE — the bargain is honoured, so nothing is owed", async () => {
      // The other half of the rule: this must warn about an unhonoured
      // bargain without warning about an honoured one, or it would simply
      // complain on every item that ever carried the verdict.
      openWindow();
      const id = await createTask({ state: "in_review" });
      const liveFollowUp = await createTask({ state: "on_deck" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "abc123",
        reviewRound: 1,
        followUpItemId: liveFollowUp,
      });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        reviewRound: 2,
      });

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toEqual([]);
    });

    it("NUDGES a demoted lgtm_with_followups that links NO follow-up at all", async () => {
      openWindow();
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "abc123",
        reviewRound: 1,
        followUpItemId: null,
      });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        reviewRound: 2,
      });

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).toContain("follow-up");
    });

    it("ALLOWS a plain lgtm that was demoted — only the followups tier carries an obligation to honour", async () => {
      openWindow();
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "abc123",
        reviewRound: 1,
      });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        reviewRound: 2,
      });

      await callTransition(id, "merged", reviewClauseOnly());
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES when a newer but STALE plain lgtm shadows an unhonoured bargain — supersession needs standing, not just recency", async () => {
      // The selection rule this pins. `record_artifact` never checks a
      // code_review commitSha against the tip, so a caller can record a
      // deliberately stale plain `lgtm`: too stale to satisfy any merge
      // clause itself, but newest by createdAt. If the obligation check asked
      // only about the newest approving review, that decoy would answer "no
      // follow-up required" on behalf of the unhonoured bargain below it, and
      // the item would merge with a dead follow-up — discharged by a review
      // that never reviewed the code being merged.
      //
      // Run against the FULL registry: the claim is that this item cannot
      // merge without a warning — and earns exactly one — which no single
      // clause can settle on its own.
      openWindow();
      const id = await createTask({ state: "in_review", mergeAuthority: "pre_approved" });
      const deadFollowUp = await createTask({ state: "cancelled" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "abc123",
        followUpItemId: deadFollowUp,
        createdAt: new Date(Date.now() - 40_000),
      });
      // The decoy — newest, approving, and naming a commit nobody is shipping.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "not-the-tip",
        createdAt: new Date(Date.now() - 20_000),
      });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        reviewRound: 2,
      });

      const nudges = await mergedWithNudges(id, allMergeGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).toContain("follow-up");
    });

    it("ALLOWS when a newer QUALIFYING clean review supersedes the bargain — an obligation can be retired, but only by a review with standing", async () => {
      // The other half of the selection rule. A later review that genuinely
      // reviewed the shipping code IS the most recent word on the change, and
      // must be able to retire an earlier deferral — otherwise one
      // lgtm_with_followups would poison an item permanently.
      openWindow();
      const id = await createTask({ state: "in_review", mergeAuthority: "pre_approved" });
      const deadFollowUp = await createTask({ state: "cancelled" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "abc123",
        followUpItemId: deadFollowUp,
        createdAt: new Date(Date.now() - 40_000),
      });
      // Newer, approving, AND at the current round and tip — it could carry
      // the merge on its own, so it has standing to retire the deferral.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "abc123",
        createdAt: new Date(Date.now() - 20_000),
      });

      const nudges = await mergedWithNudges(id, allMergeGuards());
      expect(nudges).toEqual([]);
    });

    it("NUDGES an unhonoured bargain that is not the newest approving review, through the full registry", async () => {
      // Guards against the check narrowing back to "the newest approving
      // review" by any route: here the newest approving row is a plain lgtm
      // at the tip but at an EARLIER round, so it does not qualify, and the
      // older bargain still stands.
      openWindow();
      const id = await createTask({ state: "in_review", mergeAuthority: "pre_approved" });
      const deadFollowUp = await createTask({ state: "merged" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "abc123",
        reviewRound: 1,
        followUpItemId: deadFollowUp,
        createdAt: new Date(Date.now() - 40_000),
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "abc123",
        reviewRound: 1,
        createdAt: new Date(Date.now() - 20_000),
      });
      // Pushes the round to 2, so the plain lgtm at round 1 stops qualifying.
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        reviewRound: 2,
      });

      const nudges = await mergedWithNudges(id, allMergeGuards());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).toContain("follow-up");
    });

    it("ALLOWS a demoted bargain whose follow-up is live, through the full registry — no over-refusal", async () => {
      openWindow();
      const id = await createTask({ state: "in_review", mergeAuthority: "pre_approved" });
      const liveFollowUp = await createTask({ state: "on_deck" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm_with_followups",
        commitSha: "abc123",
        reviewRound: 1,
        followUpItemId: liveFollowUp,
      });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected at abc123",
        reviewRound: 2,
      });

      const nudges = await mergedWithNudges(id, allMergeGuards());
      expect(nudges).toEqual([]);
    });

    it("NUDGES with no commit artifact at all — there is no tip to have inspected", async () => {
      openWindow();
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected something",
      });

      const nudges = await mergedWithNudges(id, reviewClauseOnly());
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("the warning names the alternative while the window is open, and stays silent about it while closed", async () => {
      // A path nobody is told about is a path nobody takes — and the one
      // they take instead is recording a code_review that nothing can check.
      // Equally, advertising a shut door would be worse than saying nothing.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });

      delete process.env[ENV_VAR];
      const closed = await mergedWithNudges(id, reviewClauseOnly());
      expect(closed).toHaveLength(1);
      expect(closed[0]?.message).not.toContain("historical_verification");

      openWindow();
      const open = await mergedWithNudges(id, reviewClauseOnly());
      expect(open).toHaveLength(1);
      expect(open[0]?.message).toContain("historical_verification");
    });
  });

  describe("rehearsal — reports the warnings without writing anything", () => {
    it("reports the merge warnings and leaves the item unchanged", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresCommitGuard);
      const id = await createTask({ state: "in_review" });

      const dbHandle: TransactionHandle = {
        $queryRawUnsafe: (query: string, ...values: unknown[]) =>
          prisma.$queryRawUnsafe(query, ...values),
        $executeRawUnsafe: (query: string, ...values: unknown[]) =>
          prisma.$executeRawUnsafe(query, ...values),
      };
      const ctx = {
        db: dbHandle,
        settings: defaultSnapshot(),
        caller: {},
        operation: "test",
      };
      const outcome = await rehearseTransition(ctx, { itemId: id, to: "merged" }, reg);
      // The rehearsal answers "what would this call report" — and since the
      // real call now reports a warning rather than a wall, so does this.
      expect(outcome.allowed).toBe(true);
      expect(outcome.nudges).toEqual([
        { guard: "merge.requires_commit", message: expect.stringContaining("merge_proof") },
      ]);
      expect(await readState(id)).toBe("in_review");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // The squash-merge fix (#236) and the stated-reason override.
  //
  // Two separate things, tested separately on purpose, because conflating
  // them is the mistake the design set out to avoid: the squash case is a
  // BUG in the check and is fixed so that no override is consumed for it;
  // the override is for the judgement call that genuinely remains.
  // ══════════════════════════════════════════════════════════════════════

  /** A `TransactionHandle` over the scratch database, for calling helpers directly. */
  function dbHandleFor(): TransactionHandle {
    return {
      $queryRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$queryRawUnsafe(query, ...values),
      $executeRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$executeRawUnsafe(query, ...values),
    };
  }

  describe("squash-merge — an approval carries forward onto the sha the reviewed code landed as", () => {
    // The regression this whole section exists for. Reproduces the exact
    // sequence three independent sessions reported as unsatisfiable: review
    // the branch tip, squash-merge (which mints a NEW sha that did not exist
    // at review time), record the landed commit, try to merge.
    it("still warns without a supersession link — the documented unsatisfiable case is not silently carried", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "e993415" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "e993415",
      });
      // The squash merge. A brand-new commit object, claiming nothing.
      await createArtifact({ itemId: id, kind: "commit", commitSha: "97837fa" });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      // The warning still fires: the fix carries an approval across a
      // RECORDED rewrite; it does not make an unrecorded one invisible.
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("ALLOWS when the landed commit records supersedesSha — same shas, link added", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "e993415" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "e993415",
      });
      // The ONLY difference from the refusing case above: the landed commit
      // says what it is a rewrite of. No new review, no override, no
      // environment variable, no change to the shas involved.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "97837fa",
        supersedesSha: "e993415",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      // Fully silent, not merely allowed: the lineage fix removes the
      // warning as cleanly as it used to remove the wall.
      expect(nudges).toEqual([]);
    });

    it("follows a multi-hop chain — a rebase, then a squash", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "aaa1111" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "aaa1111",
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "bbb2222",
        supersedesSha: "aaa1111",
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "ccc3333",
        supersedesSha: "bbb2222",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toEqual([]);
    });

    // The load-bearing negative. If this ever goes silent, the fix has
    // become a hole: a commit carrying genuinely new, unreviewed work would
    // be riding in on an older approval without the answer saying so.
    it("NUDGES a genuinely new commit stacked after a superseding one — staleness still called out", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "aaa1111" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "aaa1111",
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "bbb2222",
        supersedesSha: "aaa1111",
      });
      // Real new work: it declares no supersession, so it is not a rewrite
      // of anything and the approval must not reach it.
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ddd4444" });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    // Same case as directly above, forced onto the actual collision this row
    // exists to close rather than relying on timing to hit it — the
    // intermittent failure this test is named for (#agent-standup row
    // 1d56cd0e) reproduced at ~45% on ordinary hardware, because the two
    // relevant inserts above land in the same Postgres millisecond
    // (`Artifact.createdAt` is `@db.Timestamptz(3)`) often enough by chance
    // alone. Pinning `createdAt` to the same instant on both `bbb2222` and
    // `ddd4444` removes the *timing* luck, but is not enough on its own —
    // see the `id` note just below.
    //
    // **The ids are pinned too, and this is the part that actually makes the
    // mutant kill deterministic.** Pinning only `createdAt` still leaves the
    // reverted tiebreak (`id DESC` on a `randomUUID()`) deciding the
    // outcome, which is a fair coin flip: simulated at 100k random uuid
    // pairs, the true tip won only ~49.8% of the time, and measuring this
    // exact test against the reverted code across 17 runs killed the mutant
    // 6 times and let it survive 11 — the same disease this fix exists to
    // cure (a confident "fails every run" claim that wasn't true),
    // reproduced in the regression test written to catch it. So the ids are
    // chosen explicitly: `bbb2222` sorts LOWER than `ddd4444` lexically
    // (`bbb... < ddd...`), which under `id DESC` alone would make `ddd4444`
    // win the tie regardless of tiebreak — not the collision this test needs
    // to force. The ids below invert that on purpose: `bbb2222FF...` (all
    // trailing `f`s, the maximum hex digit) is given the id that sorts
    // HIGHEST, so under the reverted `"createdAt" DESC, "id" DESC` ordering
    // it — not the true tip `ddd4444` — always wins the tie and is wrongly
    // treated as current. That guarantees the guard wrongly allows the merge
    // under the reverted code every run, and the warning this test asserts
    // then never fires: a deterministic kill instead of a coin flip. Under
    // the fix (`seq DESC`), insertion order decides regardless of what the
    // ids happen to be, so `ddd4444` — inserted after `bbb2222` — still wins
    // and the guard still correctly warns.
    it("NUDGES the same case even when the new commit ties the superseding one on createdAt to the millisecond", async () => {
      const id = await createTask({ state: "in_review" });
      // Explicit, ordered timestamps rather than each artifact's own
      // insert-time default: `aaa1111` must be strictly OLDER than the tied
      // pair below it, or it would itself win "most recent" and the test
      // would not be exercising the tiebreak at all.
      const reviewed = new Date("2026-01-01T00:00:00.000Z");
      const tie = new Date("2026-01-01T00:00:01.000Z");
      // Explicit ids so a reverted tiebreak (`id DESC`) has a guaranteed,
      // not merely probable, wrong answer — see the comment above this test.
      const bbb2222Id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
      const ddd4444Id = "00000000-0000-4000-8000-000000000000";
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "aaa1111",
        createdAt: reviewed,
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "aaa1111",
        createdAt: reviewed,
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "bbb2222",
        supersedesSha: "aaa1111",
        createdAt: tie,
        id: bbb2222Id,
      });
      // Real new work, inserted AFTER bbb2222 (so it is the true tip) but
      // carrying the identical `createdAt` — the collision the intermittent
      // failure turned on. Its id is pinned lower than `bbb2222`'s, so under
      // the reverted `id DESC` tiebreak it is the one that loses.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "ddd4444",
        createdAt: tie,
        id: ddd4444Id,
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("a supersession cycle terminates rather than hanging the merge decision", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "cyc0001" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "cyc0002",
        supersedesSha: "cyc0001",
      });
      // Closes the loop: the newest artifact for 0001 supersedes 0002, which
      // supersedes 0001. An unbounded walk here would not return, inside the
      // transaction that decides a merge.
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "cyc0001",
        supersedesSha: "cyc0002",
      });
      const lineage = await tipCommitLineage(dbHandleFor(), id);
      expect(lineage.has("cyc0001")).toBe(true);
      expect(lineage.has("cyc0002")).toBe(true);
      expect(lineage.size).toBe(2);
    });

    it("only a commit artifact can extend the lineage — a review claiming supersession is ignored", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "real999" });
      // A non-commit kind carrying the column has no standing to assert that
      // one sha replaced another. If this were honoured, any artifact could
      // drag an arbitrary sha into the comparison set.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "real999",
        supersedesSha: "sneaky1",
      });
      const lineage = await tipCommitLineage(dbHandleFor(), id);
      expect(lineage.has("real999")).toBe(true);
      expect(lineage.has("sneaky1")).toBe(false);
    });

    it("the person-approval clause reads the same lineage — a human review survives the squash", async () => {
      // If this clause used a narrower reading than the code-review clause,
      // needs_approval would stay unsatisfiable in exactly the workflow it
      // most needs to work in — and the two clauses could come to rest on
      // different artifacts, the composition-bug class merge.ts documents
      // twice.
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "hum1111" });
      // An agent reviewed it; a PERSON authorised it. Both pinned to the
      // branch tip that the squash then rewrote. The review satisfies the
      // code-review clause and the merge_approval satisfies the
      // authorisation clause, and BOTH have to survive the rewrite via the
      // same lineage or the two clauses come to rest on different shas.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "hum1111",
        createdByType: "agent",
      });
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        commitSha: "hum1111",
        createdByType: "person",
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "hum2222",
        supersedesSha: "hum1111",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      // Silent on BOTH clauses: neither the review nor the person's
      // authorisation fell off the rewrite.
      expect(nudges).toEqual([]);
    });

    it("the warning names the supersedesSha remedy, so the fix is discoverable from the answer", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "msg1111" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        commitSha: "msg1111",
      });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "msg2222" });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      const review = nudges.find((n) => n.guard === "merge.requires_approving_code_review");
      expect(review?.message).toContain("supersedesSha");
    });
  });

  describe("merge_override — an escape hatch that leaves a trace", () => {
    it("ALLOWS a merge with no approving review at all, on a reasoned override", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ovr1111" });
      await createArtifact({
        itemId: id,
        kind: "merge_override",
        commitSha: "ovr1111",
        body: "Docs-only change since review; no source files were touched.",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("NUDGES when the override names a different commit — not standing permission", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ovr2222" });
      // The override was a judgement about one state of the code and must
      // not reach the one that is actually here.
      await createArtifact({
        itemId: id,
        kind: "merge_override",
        commitSha: "some-other-commit",
        body: "Nothing material changed since the review was recorded.",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).toContain("No approved code_review");
    });

    it("still warns with an override that has an empty body — the row cannot vouch for itself", async () => {
      // Belt-and-braces at the GUARD, independent of the write-time check
      // below: this is the clause that decides a merge, and it must not rest
      // on a validator it does not itself run. Written through Prisma
      // directly for that reason — `record_artifact` would refuse it.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ovr3333" });
      await prisma.artifact.create({
        data: {
          id: randomUUID(),
          itemId: id,
          kind: "merge_override" as never,
          commitSha: "ovr3333",
          body: null,
          reviewRound: 1,
          createdByType: "agent" as never,
          createdById: "test-actor",
        },
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
    });

    it("does NOT satisfy needs_approval — it widens review evidence, never authorisation", async () => {
      // The boundary that keeps this from being a way to merge round a
      // human. If this ever passes, an agent can override its way past a
      // person's required sign-off.
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ovr4444" });
      await createArtifact({
        itemId: id,
        kind: "merge_override",
        commitSha: "ovr4444",
        body: "Trivial rebase since review; the approval still stands here.",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      // Exactly one, and it is the AUTHORISATION clause: the override did
      // its narrow job — the review clause is silent — and nothing wider.
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_authorisation");
    });

    it("survives the squash that lands it, exactly as an approval does", async () => {
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ovr5555" });
      await createArtifact({
        itemId: id,
        kind: "merge_override",
        commitSha: "ovr5555",
        body: "Comment-only edit after review; behaviour is unchanged.",
      });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "ovr6666",
        supersedesSha: "ovr5555",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("is recorded and countable — the override is auditable after the merge", async () => {
      // AC #4: a pattern of overriding has to be detectable, which means the
      // decision has to survive as a queryable row rather than as a field on
      // a request that is discarded once the guard has read it.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ovr7777" });
      await createArtifact({
        itemId: id,
        kind: "merge_override",
        commitSha: "ovr7777",
        body: "Lint-only fix after the approving review; logic untouched.",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      await callTransition(id, "merged", reg);

      const overrides = await prisma.artifact.findMany({
        where: { itemId: id, kind: "merge_override" as never },
      });
      expect(overrides).toHaveLength(1);
      expect(overrides[0]!.body).toContain("Lint-only fix");
      expect(overrides[0]!.createdById).toBe("test-actor");
      // Never readable as a review — the property the separate kind buys.
      expect(overrides[0]!.verdict).toBeNull();
      const reviews = await prisma.artifact.findMany({
        where: { itemId: id, kind: "code_review" as never },
      });
      expect(reviews).toHaveLength(0);
    });

    it("the warning names a route that exists, and offers no override of a wall that is gone", async () => {
      // Two things are pinned. One: an earlier wording of this message
      // named a remedy no surface implemented, and a session burned six
      // attempts chasing it — every route a warning names must be one the
      // caller can actually take. Two: an override is not advertised here
      // as a way PAST the warning (`guards/merge.ts` keeps the reasoning —
      // a nudge walls nothing, so it needs no escape hatch). It works by
      // being recorded first, which the reasoned-override case above pins.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ovr8888" });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      const nudges = await mergedWithNudges(id, reg);
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.guard).toBe("merge.requires_approving_code_review");
      expect(nudges[0]?.message).toContain("Get the change reviewed now");
      expect(nudges[0]?.message).not.toContain("merge_override");
    });

    it("ALLOWS an override pinned to a 7-char abbreviation of the full-length tip commit (e09aa150 site 4)", async () => {
      // mergeOverrideSatisfies is the fourth of four sites, and the one that
      // used to compare shas in SQL ("commitSha" = ANY($3::text[])) rather
      // than in TS — exact-value membership either way, and blind to an
      // override recorded from ordinary git output the same way the other
      // three sites were.
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "commit",
        commitSha: "86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a",
      });
      await createArtifact({
        itemId: id,
        kind: "merge_override",
        commitSha: "86f3af0",
        body: "Docs-only change since review; no source files were touched.",
      });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });
  });
});
