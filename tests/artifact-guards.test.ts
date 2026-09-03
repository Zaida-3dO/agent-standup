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
