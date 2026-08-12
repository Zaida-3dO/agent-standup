// Row #17's guards: review-requested, plan-approval, and evidence-at-tip.
// See docs/plans/MILESTONES.md #17, SCHEMA.md §6, §16.
//
// Runs against a real Postgres, like state-machine-transition.test.ts — the
// claims here are about rows actually present (or absent) in `Artifact`
// and `Event`, which an in-memory model cannot settle, and staleness in
// particular is a claim about which of several real rows is newest. Skips
// without TEST_DATABASE_URL, same convention as every other DB-backed file.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { GuardRegistry, applyTransition } from "@/lib/service/state-machine";
import {
  currentTipCommitSha,
  evidenceAtTipGuard,
  hasApproval,
  latestApprovalAtTip,
  planApprovalGuard,
  reviewRequestedGuard,
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
  createScratchDatabase,
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
  });
});
