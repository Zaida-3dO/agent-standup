// MILESTONES.md #98 — the claim that one operation clears all three guards.
//
// This file is the milestone's acceptance criterion, written as a test. The
// row says: "#17's three guards refuse every item minted through the product
// … One operation clears all three." Everything else in #98 is machinery for
// that sentence, and it is the sentence a reviewer should be able to check
// without reading the machinery. The nudge conversion has since changed the
// first clause's tense — the guards warn now and the move lands — but
// "one operation clears all three" is still exactly what this file proves:
// record the evidence and the warnings go quiet, one guard at a time.
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
// The warning half is asserted first in each block, deliberately, on a
// `dry_run` probe: an item that has not recorded the evidence still lands,
// but the guard must speak up for it. A guard only ever seen *silent* has
// not been shown to be doing anything at all — the same posture CLAUDE.md
// takes on testing refusals. The probe keeps the item where it is, so each
// block below can show one warning going quiet at a time.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, guardRegistry, prismaTransactionRunner } from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { defaultSnapshot } from "@/lib/settings";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ProbeOutcome {
  allowed: boolean;
  nudges?: { guard: string; message: string }[];
  rejection?: { guard: string };
}

describeIfDb("record_artifact clears the guards that had no writer (#98)", () => {
  const dbName = scratchDatabaseName("artifact_clears_guards");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    // `record_artifact` refuses a `createdByType: "person"` whose id names
    // nobody (#134), so the person these fixtures credit has to exist.
    await prisma.person.create({ data: { id: "user-a", displayName: "User A" } });

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

  /**
   * A `dry_run` probe: what a move to `to` would answer, with the item
   * staying put. `fields` carries what a real call would carry — including
   * the summary a completing state needs, so a probe reports the evidence
   * warnings this file is about rather than the summary guard's refusal.
   */
  async function probe(id: string, to: string, fields: Record<string, unknown> = {}) {
    const result = (await runtime.call("transition_item", { id, to, dryRun: true, fields })) as {
      outcome: ProbeOutcome;
    };
    return result.outcome;
  }

  /** Probes in this file are all moves that land; returns the warning guard ids. */
  function warnedGuards(outcome: ProbeOutcome): string[] {
    expect(outcome.allowed).toBe(true);
    return (outcome.nudges ?? []).map((n) => n.guard);
  }

  /** A real move; warnings ride on `outcome.nudges`, omitted when silent. */
  async function moved(id: string, to: string) {
    return (await runtime.call("transition_item", { id, to })) as {
      item: { state: string };
      outcome: { nudges?: unknown[] };
    };
  }

  /**
   * A summary good enough for `summaries.required_and_valid`.
   *
   * `merged` is a completing state, so it is reached through `complete_item`
   * and carries a summary — the summary guard is a separate requirement from
   * the artifact evidence this file is about, and it applies whether or not
   * the artifacts are in place. Supplying a valid one (the same candidate
   * rides the merge probes' `fields.summary`) keeps the probes and the
   * completion below reporting the artifact warnings each assertion names:
   * without it every merge probe would answer the
   * `summaries.required_and_valid` refusal instead, and this file would
   * prove nothing about artifacts at all.
   */
  function validSummary() {
    return {
      shipped: ["Delivered the thing."],
      not_done: [],
      user_facing: false,
      how_verified: "Ran it locally and watched it work end to end.",
      watch_for: [],
    };
  }

  it("clears artifact.review_requested — entering in_review", async () => {
    const id = await freshItem("executing");

    expect(warnedGuards(await probe(id, "in_review"))).toEqual(["artifact.review_requested"]);

    await runtime.call("request_review", { itemId: id, actorType: "agent", actorId: "agent-b" });

    // The event the operation wrote is what the guard reads — the probe
    // goes silent, and the real move lands with nothing to say.
    expect(warnedGuards(await probe(id, "in_review"))).toEqual([]);

    const result = await moved(id, "in_review");
    expect(result.item.state).toBe("in_review");
    expect(result.outcome.nudges).toBeUndefined();
  });

  it("clears artifact.plan_approval and artifact.evidence_at_tip — plan_review to executing", async () => {
    const id = await freshItem("plan_review");

    expect(warnedGuards(await probe(id, "executing"))).toEqual(["artifact.plan_approval"]);

    // A plan_review artifact that does NOT approve leaves the guard warning
    // — otherwise this test would pass on an operation that wrote any row at
    // all, which is the failure mode a happy-path-only suite has.
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "plan_review",
      verdict: "changes_required",
      createdByType: "person",
      createdById: "user-a",
    });
    expect(warnedGuards(await probe(id, "executing"))).toEqual(["artifact.plan_approval"]);

    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "plan_review",
      verdict: "approved",
      createdByType: "person",
      createdById: "user-a",
    });
    // With an approval on the record and no commit to be current against,
    // `artifact.evidence_at_tip` has nothing to add either.
    expect(warnedGuards(await probe(id, "executing"))).toEqual([]);

    const result = await moved(id, "executing");
    expect(result.item.state).toBe("executing");
    expect(result.outcome.nudges).toBeUndefined();
  });

  it("clears a stale plan approval against a recorded commit — by naming the tip", async () => {
    const id = await freshItem("plan_review");

    // Approved with no commitSha, while a commit artifact exists: the tip is
    // a real sha, the approval names none, so it cannot be shown to be
    // current. This is `artifact.evidence_at_tip`'s warning to make, and it
    // is a distinct cause from "never approved".
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "commit",
      commitSha: "5ba71100",
      createdByType: "agent",
      createdById: "agent-a",
    });
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "plan_review",
      verdict: "approved",
      createdByType: "person",
      createdById: "user-a",
    });

    const stale = await probe(id, "executing");
    expect(warnedGuards(stale)).toEqual(["artifact.evidence_at_tip"]);
    expect(stale.nudges?.[0]?.message).toContain("not for the current tip commit");

    // Naming the tip clears it — so the operation can express "this approval
    // is for this commit", which is the whole content of the tip check.
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "plan_review",
      verdict: "approved",
      commitSha: "5ba71100",
      createdByType: "person",
      createdById: "user-a",
    });
    expect(warnedGuards(await probe(id, "executing"))).toEqual([]);

    const result = await moved(id, "executing");
    expect(result.item.state).toBe("executing");
    expect(result.outcome.nudges).toBeUndefined();
  });

  it("clears the merge cluster — commit plus an approving code review at round and tip", async () => {
    const id = await freshItem("in_review");
    const mergeProbe = () => probe(id, "merged", { summary: validSummary() });

    // With nothing on the record, every merge guard whose evidence is
    // missing warns on the SAME probe — each names its own cause, none of
    // them swallows the others.
    expect(warnedGuards(await mergeProbe()).sort()).toEqual(
      [
        "merge.requires_approving_code_review",
        "merge.requires_authorisation",
        "merge.requires_commit",
      ].sort(),
    );

    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "commit",
      commitSha: "5ba00001",
      createdByType: "agent",
      createdById: "agent-a",
    });

    expect(warnedGuards(await mergeProbe()).sort()).toEqual(
      ["merge.requires_approving_code_review", "merge.requires_authorisation"].sort(),
    );

    // An AGENT's approval satisfies the code-review clause but not the
    // authorisation clause, because this item's merge_authority is
    // needs_approval. Two distinct guards: the review warning goes quiet
    // while the authorisation one keeps sounding — the case that would slip
    // through if `createdByType` were defaulted.
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "code_review",
      verdict: "lgtm",
      commitSha: "5ba00001",
      createdByType: "agent",
      createdById: "agent-a",
    });
    expect(warnedGuards(await mergeProbe())).toEqual(["merge.requires_authorisation"]);

    // Recording the review a second time as a person does NOT clear it: a
    // review states the code is sound, not that a human decided it may land,
    // and `createdByType` records who wrote the artifact either way.
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "code_review",
      verdict: "lgtm",
      commitSha: "5ba00001",
      createdByType: "person",
      createdById: "user-a",
    });
    expect(warnedGuards(await mergeProbe())).toEqual(["merge.requires_authorisation"]);

    // The person's recorded DECISION is what clears it (SCHEMA.md §6e).
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "merge_approval",
      commitSha: "5ba00001",
      createdByType: "person",
      createdById: "user-a",
    });

    const result = (await runtime.call("complete_item", {
      id,
      to: "merged",
      summary: validSummary(),
    })) as { item: { state: string }; nudges?: unknown[] };
    expect(result.item.state).toBe("merged");
    expect(result.nudges).toBeUndefined(); // fully evidenced: the completion is silent
  });

  it("warns for a merge whose approval is for a superseded commit", async () => {
    const id = await freshItem("in_review");

    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "commit",
      commitSha: "5ba00001",
      createdByType: "agent",
      createdById: "agent-a",
    });
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "code_review",
      verdict: "lgtm",
      commitSha: "5ba00001",
      createdByType: "person",
      createdById: "user-a",
    });
    // A newer commit moves the tip past what was reviewed.
    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "commit",
      commitSha: "5ba00002",
      createdByType: "agent",
      createdById: "agent-a",
    });

    // The review warning rides alongside the authorisation one — this item
    // is still needs_approval with no recorded decision — neither cause
    // silences the other.
    expect(warnedGuards(await probe(id, "merged", { summary: validSummary() })).sort()).toEqual(
      ["merge.requires_approving_code_review", "merge.requires_authorisation"].sort(),
    );

    const result = (await runtime.call("complete_item", {
      id,
      to: "merged",
      summary: validSummary(),
    })) as { item: { state: string }; nudges?: { guard: string }[] };
    expect(result.item.state).toBe("merged"); // the merge lands; the warnings ride along
    expect((result.nudges ?? []).map((n) => n.guard).sort()).toEqual(
      ["merge.requires_approving_code_review", "merge.requires_authorisation"].sort(),
    );
  });

  it("walks a fresh item from plan_review to merged using only service calls", async () => {
    // The milestone's own done-when, end to end: "an agent can be handed an
    // item and work it to merged using only MCP". Every write below is a
    // service operation; nothing reaches past it into the tables.
    const id = await freshItem("plan_review", { mergeAuthority: "pre_approved" });

    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "plan_review",
      verdict: "approved",
      createdByType: "person",
      createdById: "user-a",
    });
    const toExecuting = (await runtime.call("transition_item", { id, to: "executing" })) as {
      outcome: { nudges?: unknown[] };
    };
    expect(toExecuting.outcome.nudges).toBeUndefined();

    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "commit",
      commitSha: "5ba0f1a1",
      createdByType: "agent",
      createdById: "agent-a",
    });
    await runtime.call("request_review", { itemId: id, actorType: "agent", actorId: "agent-b" });
    const toReview = (await runtime.call("transition_item", { id, to: "in_review" })) as {
      outcome: { nudges?: unknown[] };
    };
    expect(toReview.outcome.nudges).toBeUndefined();

    await runtime.call("record_artifact", {
      itemId: id,
      artifactKind: "code_review",
      verdict: "lgtm",
      commitSha: "5ba0f1a1",
      createdByType: "agent",
      createdById: "reviewer-agent",
    });
    const merged = (await runtime.call("complete_item", {
      id,
      to: "merged",
      summary: validSummary(),
    })) as { item: { state: string }; nudges?: unknown[] };

    expect(merged.item.state).toBe("merged");
    // The walk's real done-when: every move landed, and none of them needed
    // a warning to say so — an agent can work an item to merged on evidence
    // alone.
    expect(merged.nudges).toBeUndefined();
  });
});
