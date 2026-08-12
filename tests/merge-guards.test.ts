// Row #18's guards: merge — commit, approving code review at the current
// review round, the visual gate, and who may authorise. See
// docs/plans/MILESTONES.md #18, SCHEMA.md §16.
//
// Runs against a real Postgres, like `artifact-guards.test.ts` and
// `guard-hierarchy.test.ts` — the claims here are about rows actually
// present (or absent) in `Artifact`, which an in-memory model cannot settle.
// Skips without TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { GuardRegistry, applyTransition, rehearseTransition } from "@/lib/service/state-machine";
import {
  currentReviewRound,
  hasApprovingArtifactAtCurrentRound,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresAuthorisationGuard,
  mergeRequiresCommitGuard,
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
  createScratchDatabase,
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
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
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
  }) {
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        itemId: overrides.itemId,
        kind: overrides.kind as never,
        verdict: (overrides.verdict ?? null) as never,
        commitSha: overrides.commitSha ?? null,
        reviewRound: overrides.reviewRound ?? 1,
        createdByType: (overrides.createdByType ?? "agent") as never,
        createdById: "test-actor",
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
    it("registers all four merge guards into the shared guardRegistry, exactly once", () => {
      expect(guardRegistry.has("merge.requires_commit")).toBe(true);
      expect(guardRegistry.has("merge.requires_approving_code_review")).toBe(true);
      expect(guardRegistry.has("merge.requires_visual_review")).toBe(true);
      expect(guardRegistry.has("merge.requires_authorisation")).toBe(true);
    });

    it("all four apply only to entering merged, not other transitions", () => {
      for (const guard of [
        mergeRequiresCommitGuard,
        mergeRequiresApprovingCodeReviewGuard,
        mergeRequiresVisualReviewGuard,
        mergeRequiresAuthorisationGuard,
      ]) {
        expect(guard.appliesTo("in_review", "merged")).toBe(true);
        expect(guard.appliesTo("executing", "merged")).toBe(true);
        expect(guard.appliesTo("in_review", "blocked")).toBe(false);
        expect(guard.appliesTo("in_review", "executing")).toBe(false);
      }
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
        reviewRound: 1,
      });
      await callTransition(id, "merged", reg);
      expect(await readState(id)).toBe("merged");
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
