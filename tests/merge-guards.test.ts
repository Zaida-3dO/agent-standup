// Row #18's guards: merge — commit, approving code review at the current
// review round, the visual gate, and who may authorise. See
// docs/plans/MILESTONES.md #18, SCHEMA.md §16.
//
// Runs against a real Postgres, like `artifact-guards.test.ts` and
// `guard-hierarchy.test.ts` — the claims here are about rows actually
// present (or absent) in `Artifact`, which an in-memory model cannot settle.
// Skips without TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GuardRegistry, applyTransition, rehearseTransition } from "@/lib/service/state-machine";
import {
  ALL_GUARDS,
  MERGE_GUARDS,
  currentReviewRound,
  hasApprovingArtifactAtCurrentRound,
  hasApprovingArtifactAtCurrentRoundAndTip,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresAuthorisationGuard,
  mergeRequiresCommitGuard,
  mergeRequiresLinkedFollowUpGuard,
  mergeRequiresVisualReviewGuard,
} from "@/lib/service/guards";
import { guardRegistry, type GuardInput } from "@/lib/service/state-machine/guard";
import {
  defineOperation,
  isServiceError,
  prismaTransactionRunner,
  ServiceRuntime,
} from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import type { ServiceContext, TransactionHandle } from "@/lib/service/context";
import { z } from "zod";
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
    reviewRound?: number;
    createdByType?: string;
    createdAt?: Date;
    followUpItemId?: string | null;
    findings?: unknown;
    body?: string | null;
  }) {
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        itemId: overrides.itemId,
        kind: overrides.kind as never,
        verdict: (overrides.verdict ?? null) as never,
        commitSha: overrides.commitSha ?? null,
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
    it("REFUSES: no commit artifact at all", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresCommitGuard);
      const id = await createTask({ state: "in_review" });
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      const rejected = error as { guard?: string; message?: string; fields?: readonly string[] };
      expect(rejected.guard).toBe("merge.requires_commit");
      expect(rejected.message).toMatch(/No commit_sha recorded/);
      expect(rejected.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
    });

    it("ALLOWS: a commit artifact exists", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresCommitGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-a" });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });
  });

  describe("criterion 2 — merge.requires_approving_code_review", () => {
    it("REFUSES: no code_review artifact at all", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_approving_code_review");
      expect(error.message).toMatch(/No approved code_review artifact/);
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
    });

    it("REFUSES: a code_review artifact whose verdict is changes_required, not approved", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "code_review", verdict: "changes_required" });
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("merge.requires_approving_code_review");
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

    it("REFUSES: an approval recorded for an earlier review round — the item has since moved to a new round", async () => {
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

      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_approving_code_review");
      expect(error.message).toMatch(/not for the current review round \(2\)/);
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
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

    it("REFUSES: approved at the current round, but for a commit a newer, same-round commit has since superseded — round-currency alone is not commit-currency", async () => {
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

      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_approving_code_review");
      expect(error.message).toMatch(
        /not for the current review round \(1\) and tip commit \(commit-b\)/,
      );
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
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
  });

  describe("criterion 3 — merge.requires_visual_review", () => {
    it("ALLOWS: needs_visual_review is false — the clause never fires, no evidence required", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresVisualReviewGuard);
      const id = await createTask({ state: "in_review", needsVisualReview: false });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("REFUSES: needs_visual_review is true and no visual_review artifact exists", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresVisualReviewGuard);
      const id = await createTask({ state: "in_review", needsVisualReview: true });
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_visual_review");
      expect(error.message).toMatch(/no approved visual_review artifact/);
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
    });

    it("REFUSES: needs_visual_review is true and the only visual_review approval is stale — attached to a superseded commit", async () => {
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

      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_visual_review");
      expect(error.message).toMatch(/not for the current tip commit \(commit-b\)/);
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
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

    it("needs_approval: REFUSES when the approving code_review was recorded by an agent, not a person", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
      });
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(error.message).toMatch(/a person must record/);
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
    });

    it("needs_approval: ALLOWS when the approving code_review was recorded by a person", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("needs_approval: REFUSES with no code_review artifact at all", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(error.fields).toEqual(["state"]);
    });

    it("agent_judgement: REFUSES with no merge_rationale field supplied", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "agent_judgement" });
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(error.message).toMatch(/recorded one-line merge_rationale/);
      expect(error.fields).toEqual(["merge_rationale"]);
      expect(await readState(id)).toBe("in_review");
    });

    it("agent_judgement: REFUSES with a blank/whitespace-only merge_rationale", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "agent_judgement" });
      const error = (await callTransition(id, "merged", reg, {
        merge_rationale: "   ",
      }).catch((e: unknown) => e)) as { guard?: string };
      expect(error.guard).toBe("merge.requires_authorisation");
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

    it("needs_approval: REFUSES when the person's approval is at an EARLIER round than the current one, even though a person approved at some point — round-2 review-1 defect", async () => {
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
    });

    it("needs_approval: ALLOWS when the person's approval IS the current round's approval", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "changes_required",
        createdByType: "person",
        reviewRound: 1,
      });
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
        reviewRound: 2,
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("needs_approval: REFUSES when the person's approval is at the current round but for a superseded commit — round-currency alone is not commit-currency", async () => {
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

      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
    });

    it("needs_approval: ALLOWS when the person's approval matches BOTH the current round and the current tip commit", async () => {
      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const id = await createTask({ state: "in_review", mergeAuthority: "needs_approval" });
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
        createdAt: new Date(),
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
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
    it("REFUSES until every clause is satisfied, then ALLOWS once they all are", async () => {
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

      // Nothing recorded yet.
      let error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("merge.requires_commit");
      expect(await readState(id)).toBe("in_review");

      await createArtifact({ itemId: id, kind: "commit", commitSha: "commit-a" });
      error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("merge.requires_approving_code_review");

      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "agent",
        commitSha: "commit-a",
      });
      error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("merge.requires_visual_review");

      await createArtifact({
        itemId: id,
        kind: "visual_review",
        verdict: "approved",
        commitSha: "commit-a",
      });
      // Code review was recorded by an agent, so needs_approval still blocks.
      error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");

      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
        commitSha: "commit-a",
        reviewRound: 1,
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("REFUSES the review round 1 defect: person-approved at an earlier round, agent-only approved at the current round, commit present — against MERGE_GUARDS exactly as ALL_GUARDS registers them", async () => {
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

      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");
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

    it("REFUSES: an `na` verdict — a legal value that is not an approval", async () => {
      // The interesting rejection. An "everything except changes_required"
      // reading of the enum would wave this through, and `na` is what a
      // commit or a test-run artifact carries — an item would merge on the
      // strength of an artifact that reviewed nothing.
      const reg = new GuardRegistry();
      reg.register(mergeRequiresApprovingCodeReviewGuard);
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "sha-na" });
      await createArtifact({ itemId: id, kind: "code_review", verdict: "na", commitSha: "sha-na" });
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect(await readState(id)).toBe("in_review");
    });

    it("REFUSES: changes_required, unchanged by the tiering", async () => {
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
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect(await readState(id)).toBe("in_review");
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

    it("stores a findings list with severities, and changes no merge outcome by doing so", async () => {
      // Storage only. A medium-severity finding recorded against an
      // approving review does not, on its own, block anything: no
      // severity-derived gate exists in this system and this change does not
      // add one. The gate still reads the verdict and the artifact's
      // currency, exactly as before.
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
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");

      const stored = await prisma.artifact.findFirstOrThrow({
        where: { itemId: id, kind: "code_review" },
      });
      expect(stored.findings).toEqual([
        { text: "the retry path is untested", severity: "medium" },
        { text: "a stray log line", severity: "low" },
      ]);
    });

    it("lgtm_with_nits goes stale when the nits are addressed, and merges again once re-reviewed", async () => {
      // This is the whole "merge after nits" rule, and it needs no gate of
      // its own: addressing a nit produces a commit, the commit moves the
      // tip, and the existing tip-currency check refuses the now-stale
      // approval until a light re-review lands at the new tip.
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
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect(await readState(id)).toBe("in_review");

      // The light re-review at the new tip.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "lgtm",
        commitSha: "sha-after-nits",
        createdAt: new Date("2026-01-01T11:05:00Z"),
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
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

    it("REFUSES: lgtm_with_followups with no follow-up linked", async () => {
      // The rejection this verdict exists to make possible. Without it the
      // verdict is strictly the cheapest option available to a reviewer and
      // nothing ever checks the other half of the bargain.
      const id = await approvedWith("lgtm_with_followups");
      const error = await callTransition(id, "merged", registry()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect((error as { guard?: string }).guard).toBe("merge.requires_linked_followup");
      expect(await readState(id)).toBe("in_review");
    });

    it("ACCEPTS: lgtm_with_followups linking an open follow-up item", async () => {
      const followUp = await createTask({ state: "on_deck" });
      const id = await approvedWith("lgtm_with_followups", followUp);
      await callTransition(id, "merged", registry());
      expect(await readState(id)).toBe("merged");
    });

    for (const closedState of ["merged", "wont_do", "cancelled", "research_done"]) {
      it(`REFUSES: lgtm_with_followups linking a follow-up already ${closedState}`, async () => {
        // Linking a dead item would satisfy the letter of the rule and
        // defeat it entirely — the findings would be attached to something
        // nobody is going to pick up. Single-character mutation this
        // catches: removing any one entry from CLOSED_ITEM_STATES.
        const followUp = await createTask({ state: closedState });
        const id = await approvedWith("lgtm_with_followups", followUp);
        const error = await callTransition(id, "merged", registry()).catch((e: unknown) => e);
        expect(isServiceError(error)).toBe(true);
        expect((error as { message?: string }).message).toContain(closedState);
        expect(await readState(id)).toBe("in_review");
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
      // That item is already refused by merge.requires_approving_code_review,
      // and a second rejection naming a different cause would only obscure
      // the real one. Registered alone here, so "silent" is observable: the
      // transition succeeds.
      const id = await createTask({ state: "in_review" });
      await callTransition(id, "merged", registry());
      expect(await readState(id)).toBe("merged");
    });

    it("REFUSES: the link is on a STALE approval and the tip approval has none", async () => {
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
      const error = await callTransition(id, "merged", registry()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect(await readState(id)).toBe("in_review");
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

    it("REFUSES when the newest approval at the tip is the one deferring findings", async () => {
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
      const error = await callTransition(id, "merged", registry()).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
      expect(await readState(id)).toBe("in_review");
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

    it("REFUSES while the window is CLOSED, even with a perfectly-formed artifact — the default posture is unchanged", async () => {
      // The most important case in this block. With the window shut, this
      // path does not exist and the guard must behave exactly as it did
      // before the alternative was added.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "Read src/app at abc123: the routes named in the brief are absent.",
      });
      delete process.env[ENV_VAR];

      const error = await callTransition(id, "merged", reviewClauseOnly()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect(await readState(id)).toBe("in_review");
    });

    it("REFUSES for every near-miss spelling of the flag — the window fails closed", async () => {
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
        const error = await callTransition(id, "merged", reviewClauseOnly()).catch(
          (e: unknown) => e,
        );
        expect((error as { code?: string }).code).toBe("guard_rejected");
        expect(await readState(id)).toBe("in_review");
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

      await callTransition(id, "merged", reviewClauseOnly());
      expect(await readState(id)).toBe("merged");
    });

    it("REFUSES when the verification names a commit the tip has moved past — an inspection of superseded code proves nothing about what ships", async () => {
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

      const error = await callTransition(id, "merged", reviewClauseOnly()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect(await readState(id)).toBe("in_review");
    });

    it("REFUSES a verification with no body — the evidence IS the difference from an unfalsifiable approval", async () => {
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

      const error = await callTransition(id, "merged", reviewClauseOnly()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect(await readState(id)).toBe("in_review");
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
        // would be refused for that reason instead and this test would pass
        // without ever exercising the kind check — leaving the guarantee it
        // claims to protect undefended against a future edit that widened
        // the query's `kind` filter.
        createdByType: "person",
      });

      const reg = new GuardRegistry();
      reg.register(mergeRequiresAuthorisationGuard);
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { message?: string }).message).toContain("needs_approval");
      expect(await readState(id)).toBe("in_review");
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
      // it is refused.
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
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { message?: string }).message).toContain("needs_approval");
      expect(await readState(id)).toBe("in_review");
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
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect(await readState(id)).toBe("in_review");
    });

    it("leaves the lgtm_with_followups obligation intact where such an approval actually exists", async () => {
      // The reading worth disproving: because the historical path can
      // satisfy the code-review clause without a `code_review`, one might
      // expect `merge.requires_linked_followup` to go quiet and let an
      // unhonoured lgtm_with_followups bargain through. It cannot — where a
      // qualifying approval carrying that verdict exists, that guard reads
      // it and fires exactly as before.
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
      const error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { guard?: string }).guard).toBe("merge.requires_linked_followup");
      expect(await readState(id)).toBe("in_review");
    });

    // ── The follow-up bargain cannot be dissolved by an inspection ────────
    //
    // Found by adversarial probe, not by reading: `merge.requires_linked_followup`
    // resolves its approval by ROUND AND TIP, so an honest `lgtm_with_followups`
    // stops qualifying when either moves and that guard then correctly says
    // nothing. That is safe only while the same non-qualification also refuses
    // the merge at the code-review clause — which an alternative satisfier
    // removes. Both demotion routes are pinned here.
    it("REFUSES when a higher-round verification demotes an lgtm_with_followups whose follow-up is dead — round demotion", async () => {
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

      const error = await callTransition(id, "merged", reviewClauseOnly()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      // The refusal must name the real obstacle. Telling the caller to go and
      // get a code review, when the actual problem is a dead follow-up, sends
      // them to fix the wrong thing.
      expect((error as { message?: string }).message).toContain("follow-up");
      expect(await readState(id)).toBe("in_review");
    });

    it("REFUSES when a verification at a newer tip demotes an lgtm_with_followups whose follow-up is dead — tip demotion, no explicit round needed", async () => {
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

      const error = await callTransition(id, "merged", reviewClauseOnly()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { message?: string }).message).toContain("follow-up");
      expect(await readState(id)).toBe("in_review");
    });

    it("ALLOWS a demoted lgtm_with_followups whose follow-up is still LIVE — the bargain is honoured, so nothing is owed", async () => {
      // The other half of the rule: this must refuse an unhonoured bargain
      // without refusing an honoured one, or it would simply block every
      // item that ever carried the verdict.
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

      await callTransition(id, "merged", reviewClauseOnly());
      expect(await readState(id)).toBe("merged");
    });

    it("REFUSES a demoted lgtm_with_followups that links NO follow-up at all", async () => {
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

      const error = await callTransition(id, "merged", reviewClauseOnly()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { message?: string }).message).toContain("follow-up");
      expect(await readState(id)).toBe("in_review");
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

    it("still REFUSES with no commit artifact at all — there is no tip to have inspected", async () => {
      openWindow();
      const id = await createTask({ state: "in_review" });
      await createArtifact({
        itemId: id,
        kind: "historical_verification",
        commitSha: "abc123",
        body: "inspected something",
      });

      const error = await callTransition(id, "merged", reviewClauseOnly()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect(await readState(id)).toBe("in_review");
    });

    it("the refusal names the alternative while the window is open, and stays silent about it while closed", async () => {
      // A path nobody is told about is a path nobody takes — and the one
      // they take instead is recording a code_review that nothing can check.
      // Equally, advertising a shut door would be worse than saying nothing.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "abc123" });

      delete process.env[ENV_VAR];
      const closed = await callTransition(id, "merged", reviewClauseOnly()).catch(
        (e: unknown) => e,
      );
      expect((closed as { message?: string }).message).not.toContain("historical_verification");

      openWindow();
      const open = await callTransition(id, "merged", reviewClauseOnly()).catch((e: unknown) => e);
      expect((open as { message?: string }).message).toContain("historical_verification");
    });
  });

  describe("rehearsal — reports the rejection without writing anything", () => {
    it("reports the merge rejection and leaves the item unchanged", async () => {
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
      expect(outcome.allowed).toBe(false);
      expect(outcome.rejection?.guard).toBe("merge.requires_commit");
      expect(await readState(id)).toBe("in_review");
    });
  });
});
