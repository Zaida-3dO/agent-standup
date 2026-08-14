// MILESTONES.md #98 — the claim that one operation clears all three guards.
//
// This file is the milestone's acceptance criterion, written as a test. The
// row says: "#17's three guards refuse every item minted through the product
// … One operation clears all three." Everything else in #98 is machinery for
// that sentence, and it is the sentence a reviewer should be able to check
// without reading the machinery.
//
// **Why this is not covered by testing each guard separately.** A per-guard
// test seeds the artifact it needs with `prisma.artifact.create` and asks
// whether the guard then allows the move. That proves the guard reads the
// table correctly — it was already true before this row existed, and
// `artifact-guards.test.ts` and `merge-guards.test.ts` already assert it.
// What was *not* true, and what nothing else asserts, is that a caller with
// only the service layer in front of it can produce those rows at all. So
// this file never touches `prisma.artifact.create`: every artifact here is
// written by `record_artifact`, and the item walks the real state machine
// through the real guard registry. If the operation wrote the right rows in a
// shape the guards do not accept, this is the file that goes red.
//
// The negative half is asserted first in each block, deliberately. A guard
// that has only been seen to *allow* something has not been shown to be doing
// anything at all — the same reason CLAUDE.md gives for testing rejections.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, guardRegistry, prismaTransactionRunner } from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ServiceError {
  code: string;
  guard?: string;
}

describeIfDb("record_artifact clears the guards that had no writer (#98)", () => {
  const dbName = scratchDatabaseName("artifact_clears_guards");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });

    // The real production guards, not a scratch registry — the point of this
    // file is the actual wiring.
    for (const guard of ALL_GUARDS) {
      if (!guardRegistry.has(guard.id)) guardRegistry.register(guard);
    }

    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  let counter = 0;
  /** A fresh item in `state`, minted the way the product mints one. */
  async function freshItem(state: string, overrides: Record<string, unknown> = {}) {
    counter += 1;
    const id = `guard-task-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${counter}`,
        body: "body",
        state: state as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "needs_approval",
        ...overrides,
      },
    });
    return id;
  }

  async function transitionFails(id: string, to: string): Promise<ServiceError> {
    return (await runtime
      .call("transition_item", { id, to })
      .then(() => {
        throw new Error(`expected the move to ${to} to be refused, but it was allowed`);
      })
      .catch((error: unknown) => error)) as ServiceError;
  }

  it("clears artifact.review_requested — entering in_review", async () => {
    const id = await freshItem("executing");

    const refused = await transitionFails(id, "in_review");
    expect(refused.code).toBe("guard_rejected");
    expect(refused.guard).toBe("artifact.review_requested");

    await runtime.call("request_review", { itemId: id, actorType: "agent", actorId: "agent-b" });

    const result = (await runtime.call("transition_item", { id, to: "in_review" })) as {
      item: { state: string };
    };
    expect(result.item.state).toBe("in_review");
  });

  it("clears artifact.plan_approval and artifact.evidence_at_tip — plan_review to executing", async () => {
    const id = await freshItem("plan_review");

    const refused = await transitionFails(id, "executing");
    expect(refused.code).toBe("guard_rejected");
    expect(refused.guard).toBe("artifact.plan_approval");

    // A plan_review artifact that does NOT approve leaves the guard refusing
    // — otherwise this test would pass on an operation that wrote any row at
    // all, which is the failure mode a happy-path-only suite has.
    await runtime.call("record_artifact", {
      itemId: id,
      kind: "plan_review",
      verdict: "changes_required",
      createdByType: "person",
      createdById: "user-a",
    });
    const stillRefused = await transitionFails(id, "executing");
    expect(stillRefused.guard).toBe("artifact.plan_approval");

    await runtime.call("record_artifact", {
      itemId: id,
      kind: "plan_review",
      verdict: "approved",
      createdByType: "person",
      createdById: "user-a",
    });

    const result = (await runtime.call("transition_item", { id, to: "executing" })) as {
      item: { state: string };
    };
    expect(result.item.state).toBe("executing");
  });

  it("refuses plan approval that is stale against a commit recorded since", async () => {
    const id = await freshItem("plan_review");

    // Approved with no commitSha, while a commit artifact exists: the tip is
    // a real sha, the approval names none, so it cannot be shown to be
    // current. This is `artifact.evidence_at_tip`'s job and it is a distinct
    // rejection from "never approved".
    await runtime.call("record_artifact", {
      itemId: id,
      kind: "commit",
      commitSha: "sha-tip",
      createdByType: "agent",
      createdById: "agent-a",
    });
    await runtime.call("record_artifact", {
      itemId: id,
      kind: "plan_review",
      verdict: "approved",
      createdByType: "person",
      createdById: "user-a",
    });

    const refused = await transitionFails(id, "executing");
    expect(refused.guard).toBe("artifact.evidence_at_tip");

    // Naming the tip clears it — so the operation can express "this approval
    // is for this commit", which is the whole content of the tip check.
    await runtime.call("record_artifact", {
      itemId: id,
      kind: "plan_review",
      verdict: "approved",
      commitSha: "sha-tip",
      createdByType: "person",
      createdById: "user-a",
    });

    const result = (await runtime.call("transition_item", { id, to: "executing" })) as {
      item: { state: string };
    };
    expect(result.item.state).toBe("executing");
  });

  it("clears the merge cluster — commit plus an approving code review at round and tip", async () => {
    const id = await freshItem("in_review");

    const noCommit = await transitionFails(id, "merged");
    expect(noCommit.guard).toBe("merge.requires_commit");

    await runtime.call("record_artifact", {
      itemId: id,
      kind: "commit",
      commitSha: "sha-1",
      createdByType: "agent",
      createdById: "agent-a",
    });

    const noReview = await transitionFails(id, "merged");
    expect(noReview.guard).toBe("merge.requires_approving_code_review");

    // An AGENT's approval satisfies the code-review clause but not the
    // authorisation clause, because this item's merge_authority is
    // needs_approval. Two distinct guards, and the item is still refused —
    // the case that would slip through if `createdByType` were defaulted.
    await runtime.call("record_artifact", {
      itemId: id,
      kind: "code_review",
      verdict: "lgtm",
      commitSha: "sha-1",
      createdByType: "agent",
      createdById: "agent-a",
    });
    const agentOnly = await transitionFails(id, "merged");
    expect(agentOnly.guard).toBe("merge.requires_authorisation");

    await runtime.call("record_artifact", {
      itemId: id,
      kind: "code_review",
      verdict: "lgtm",
      commitSha: "sha-1",
      createdByType: "person",
      createdById: "user-a",
    });

    const result = (await runtime.call("transition_item", { id, to: "merged" })) as {
      item: { state: string };
    };
    expect(result.item.state).toBe("merged");
  });

  it("refuses a merge whose approval is for a superseded commit", async () => {
    const id = await freshItem("in_review");

    await runtime.call("record_artifact", {
      itemId: id,
      kind: "commit",
      commitSha: "sha-1",
      createdByType: "agent",
      createdById: "agent-a",
    });
    await runtime.call("record_artifact", {
      itemId: id,
      kind: "code_review",
      verdict: "lgtm",
      commitSha: "sha-1",
      createdByType: "person",
      createdById: "user-a",
    });
    // A newer commit moves the tip past what was reviewed.
    await runtime.call("record_artifact", {
      itemId: id,
      kind: "commit",
      commitSha: "sha-2",
      createdByType: "agent",
      createdById: "agent-a",
    });

    const refused = await transitionFails(id, "merged");
    expect(refused.guard).toBe("merge.requires_approving_code_review");
  });

  it("walks a fresh item from plan_review to merged using only service calls", async () => {
    // The milestone's own done-when, end to end: "an agent can be handed an
    // item and work it to merged using only MCP". Every write below is a
    // service operation; nothing reaches past it into the tables.
    const id = await freshItem("plan_review", { mergeAuthority: "pre_approved" });

    await runtime.call("record_artifact", {
      itemId: id,
      kind: "plan_review",
      verdict: "approved",
      createdByType: "person",
      createdById: "user-a",
    });
    await runtime.call("transition_item", { id, to: "executing" });

    await runtime.call("record_artifact", {
      itemId: id,
      kind: "commit",
      commitSha: "sha-final",
      createdByType: "agent",
      createdById: "agent-a",
    });
    await runtime.call("request_review", { itemId: id, actorType: "agent", actorId: "agent-b" });
    await runtime.call("transition_item", { id, to: "in_review" });

    await runtime.call("record_artifact", {
      itemId: id,
      kind: "code_review",
      verdict: "lgtm",
      commitSha: "sha-final",
      createdByType: "agent",
      createdById: "reviewer-agent",
    });
    const merged = (await runtime.call("transition_item", { id, to: "merged" })) as {
      item: { state: string };
    };

    expect(merged.item.state).toBe("merged");
  });
});
