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
  tipCommitLineage,
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
    supersedesSha?: string | null;
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
      expect(error.message).toMatch(/must record a merge_approval/);
      expect(error.fields).toEqual(["state"]);
      expect(await readState(id)).toBe("in_review");
    });

    it("needs_approval: REFUSES a person's approving code_review - a review is not an authorisation", async () => {
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");
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

    it("needs_approval: REFUSES a merge_approval recorded by an AGENT - the hold is on a human", async () => {
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");
    });

    it("needs_approval: REFUSES a merge_approval at a commit the item has moved past, and says so", async () => {
      // Stale, not absent - and the refusal must distinguish them, because a
      // caller told the wrong one chases the wrong person.
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(error.message).toMatch(/moved past/);
      expect(error.message).toMatch(/sha-new/);
      expect(await readState(id)).toBe("in_review");
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(error.message).toMatch(/merge_override does not satisfy/);
      expect(await readState(id)).toBe("in_review");
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");
    });

    it("needs_approval: the refusal names the standing-authorisation route, and warns off the wrong one", async () => {
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        message?: string;
      };

      // The remedy: the field to set, the value to set it to, and the call.
      expect(error.message).toMatch(/mergeAuthority/);
      expect(error.message).toMatch(/pre-approved/);
      expect(error.message).toMatch(/update_item/);

      // The anti-remedy, named so it is not discovered by accident.
      expect(error.message).toMatch(/created_by_type/);
      expect(error.message).toMatch(/WROTE/);
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

    it("needs_approval: REFUSES an unpinned merge_approval once a real tip exists", async () => {
      // An approval recording no commit cannot be shown to be about the code
      // that would ship, so it is refused the moment there is a tip to be
      // stale against. Same reading artifact-tip.ts documents.
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
      };
      expect(error.guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");
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
      // Every review clause is now satisfied, but no person has DECIDED, so
      // needs_approval still blocks.
      error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");

      // Recording the review a SECOND time as a person does not help - it is
      // not an authorisation, and this is the step that used to let the hold
      // be walked past.
      await createArtifact({
        itemId: id,
        kind: "code_review",
        verdict: "approved",
        createdByType: "person",
        commitSha: "commit-a",
        reviewRound: 1,
      });
      error = await callTransition(id, "merged", reg).catch((e: unknown) => e);
      expect((error as { guard?: string }).guard).toBe("merge.requires_authorisation");
      expect(await readState(id)).toBe("in_review");

      // Only the person's recorded decision clears it.
      await createArtifact({
        itemId: id,
        kind: "merge_approval",
        createdByType: "person",
        commitSha: "commit-a",
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

    it("stores a findings list with severities, and a MEDIUM under lgtm_with_nits now BLOCKS", async () => {
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
      const error = (await callTransition(id, "merged", reg).catch((e: unknown) => e)) as {
        guard?: string;
        message?: string;
      };
      expect(error.guard).toBe("merge.requires_approving_code_review");
      // The refusal quotes the finding, so the caller does not have to go and
      // look it up - the failure this gate addresses is a merging party who
      // never read the review.
      expect(error.message).toMatch(/the retry path is untested/);
      expect(error.message).not.toMatch(/a stray log line/);
      expect(await readState(id)).toBe("in_review");

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

    it("REFUSES when a newer but STALE plain lgtm shadows an unhonoured bargain — supersession needs standing, not just recency", async () => {
      // The selection rule this pins. `record_artifact` never checks a
      // code_review commitSha against the tip, so a caller can record a
      // deliberately stale plain `lgtm`: too stale to satisfy any merge
      // clause itself, but newest by createdAt. If the obligation check asked
      // only about the newest approving review, that decoy would answer "no
      // follow-up required" on behalf of the unhonoured bargain below it, and
      // the item would merge with a dead follow-up — discharged by a review
      // that never reviewed the code being merged.
      //
      // Run against the FULL registry: the claim is "this item cannot reach
      // merged", which no single clause can settle.
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

      const error = await callTransition(id, "merged", allMergeGuards()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { message?: string }).message).toContain("follow-up");
      expect(await readState(id)).toBe("in_review");
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

      await callTransition(id, "merged", allMergeGuards());
      expect(await readState(id)).toBe("merged");
    });

    it("REFUSES an unhonoured bargain that is not the newest approving review, through the full registry", async () => {
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

      const error = await callTransition(id, "merged", allMergeGuards()).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { message?: string }).message).toContain("follow-up");
      expect(await readState(id)).toBe("in_review");
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

      await callTransition(id, "merged", allMergeGuards());
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
    it("REFUSES without a supersession link — the documented unsatisfiable case, still refused", async () => {
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
      await expect(callTransition(id, "merged", reg)).rejects.toMatchObject({
        guard: "merge.requires_approving_code_review",
      });
      expect(await readState(id)).toBe("in_review");
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
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
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
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    // The load-bearing negative. If this ever passes, the fix has become a
    // hole: a commit carrying genuinely new, unreviewed work would be riding
    // in on an older approval.
    it("REFUSES a genuinely new commit stacked after a superseding one — staleness still caught", async () => {
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
      await expect(callTransition(id, "merged", reg)).rejects.toMatchObject({
        guard: "merge.requires_approving_code_review",
      });
      expect(await readState(id)).toBe("in_review");
    });

    // Same case as directly above, forced onto the actual collision this row
    // exists to close rather than relying on timing to hit it — the
    // intermittent failure this test is named for (#agent-standup row
    // 1d56cd0e) reproduced at ~45% on ordinary hardware, because the two
    // relevant inserts above land in the same Postgres millisecond
    // (`Artifact.createdAt` is `@db.Timestamptz(3)`) often enough by chance
    // alone. Pinning `createdAt` to the same instant on both `bbb2222` and
    // `ddd4444` makes the tie certain instead of probable, so this test fails
    // every run — not 45% of them — if the tiebreak regresses to something
    // that does not reflect actual insertion order (e.g. back to `id DESC`
    // on the random-uuid `Artifact.id`).
    it("REFUSES the same case even when the new commit ties the superseding one on createdAt to the millisecond", async () => {
      const id = await createTask({ state: "in_review" });
      // Explicit, ordered timestamps rather than each artifact's own
      // insert-time default: `aaa1111` must be strictly OLDER than the tied
      // pair below it, or it would itself win "most recent" and the test
      // would not be exercising the tiebreak at all.
      const reviewed = new Date("2026-01-01T00:00:00.000Z");
      const tie = new Date("2026-01-01T00:00:01.000Z");
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
      });
      // Real new work, inserted AFTER bbb2222 (so it is the true tip) but
      // carrying the identical `createdAt` — the collision the intermittent
      // failure turned on.
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ddd4444", createdAt: tie });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      await expect(callTransition(id, "merged", reg)).rejects.toMatchObject({
        guard: "merge.requires_approving_code_review",
      });
      expect(await readState(id)).toBe("in_review");
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
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
    });

    it("the refusal names the supersedesSha remedy, so the fix is discoverable from the refusal", async () => {
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
      await expect(callTransition(id, "merged", reg)).rejects.toMatchObject({
        message: expect.stringContaining("supersedesSha"),
      });
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

    it("REFUSES when the override names a different commit — not standing permission", async () => {
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
      await expect(callTransition(id, "merged", reg)).rejects.toMatchObject({
        guard: "merge.requires_approving_code_review",
      });
      expect(await readState(id)).toBe("in_review");
    });

    it("REFUSES an override with an empty body — the row cannot vouch for itself", async () => {
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
      await expect(callTransition(id, "merged", reg)).rejects.toMatchObject({
        guard: "merge.requires_approving_code_review",
      });
      expect(await readState(id)).toBe("in_review");
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
      await expect(callTransition(id, "merged", reg)).rejects.toMatchObject({
        guard: "merge.requires_authorisation",
      });
      expect(await readState(id)).toBe("in_review");
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

    it("the refusal names the override route, and names one that exists", async () => {
      // An earlier wording of this message named a remedy no surface
      // implemented, and a session burned six attempts chasing it.
      const id = await createTask({ state: "in_review" });
      await createArtifact({ itemId: id, kind: "commit", commitSha: "ovr8888" });

      const reg = new GuardRegistry();
      for (const guard of MERGE_GUARDS) reg.register(guard);
      await expect(callTransition(id, "merged", reg)).rejects.toMatchObject({
        message: expect.stringContaining("merge_override"),
      });
    });
  });
});
