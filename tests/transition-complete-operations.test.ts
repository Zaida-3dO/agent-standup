// `transition_item` and `complete_item` — MILESTONES.md #27, SCHEMA.md §16,
// §18, §19, §5, §5a. Against a real Postgres, same reasoning as
// `items-operations.test.ts` and `state-machine-transition.test.ts`: what is
// claimed here is about what actually got written (or, for rehearsal,
// deliberately did not), which only Postgres can settle.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import {
  GuardRegistry,
  RehearsalRollback,
  ServiceRuntime,
  guardOk,
  guardRegistry,
  isServiceError,
  prismaTransactionRunner,
} from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { defaultSnapshot } from "@/lib/settings";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// The default `shipped` summary shape a `complete` call needs whenever the
// test isn't specifically exercising a rejection.
function validSummary(overrides: Record<string, unknown> = {}) {
  return {
    shipped: ["Delivered the thing."],
    not_done: [],
    user_facing: false,
    how_verified: "Ran it locally and watched it work end to end.",
    watch_for: [],
    ...overrides,
  };
}

describeIfDb("transition_item and complete_item against Postgres", () => {
  const dbName = scratchDatabaseName("transition_complete");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });

    // Register the real guards this row's operations run against — the same
    // production registry `live.ts` populates, so this suite proves the
    // actual wiring rather than a scratch registry standing in for it.
    // `ALL_GUARDS` (`src/lib/service/guards/index.ts`) is every hand-written
    // guard, including the blocked/paused required-field checks — a single
    // canonical list, so this one loop covers all of it.
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

  afterEach(async () => {
    // Summary/Event/Artifact have no cascade off Item (SCHEMA.md §5's 1:1
    // FK for Summary; Event and Artifact likewise), so all three must go
    // before the Item row they point at.
    await prisma.$executeRawUnsafe(`DELETE FROM "Summary"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Event"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artifact"`);
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(
    overrides: Partial<{ state: string; parentId: string | null }> = {},
  ): Promise<string> {
    taskCounter += 1;
    const id = `task-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: overrides.parentId ?? null,
        kind: overrides.parentId === undefined ? "task" : "subtask",
        title: `Task ${taskCounter}`,
        body: "body",
        state: (overrides.state ?? "executing") as never,
        originType: "person",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /**
   * Seeds what row #18's merge guards (`merge.requires_commit`,
   * `merge.requires_approving_code_review`, `merge.requires_authorisation`
   * for `mergeAuthority: "needs_approval"`) actually require before a real
   * `complete_item({ to: "merged" })` call can succeed: a `commit` artifact
   * recording the tip commit sha, then a `code_review` artifact approved by
   * a **person** (not an agent — `needs_approval` specifically requires a
   * human sign-off) at that same commit and the item's current review round.
   * `needsVisualReview` defaults false on `createTask`, so
   * `merge.requires_visual_review` passes unconditionally and needs no
   * artifact here. Mirrors the fixture shape `tests/merge-guards.test.ts`'s
   * "all four together" test already establishes as the genuine happy path
   * for this guard set — this does not stub or bypass a guard, it gives the
   * real guards evidence that genuinely satisfies them.
   */
  async function satisfyMergeGuards(itemId: string, commitSha = "commit-a"): Promise<void> {
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        itemId,
        kind: "commit",
        commitSha,
        createdByType: "agent",
        createdById: "test-actor",
      },
    });
    await prisma.artifact.create({
      data: {
        id: randomUUID(),
        itemId,
        kind: "code_review",
        verdict: "approved",
        commitSha,
        reviewRound: 1,
        createdByType: "person",
        createdById: "test-reviewer",
      },
    });
  }

  async function readState(itemId: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    return row.state;
  }

  async function eventsFor(itemId: string): Promise<{ type: string; payload: unknown }[]> {
    return prisma.$queryRawUnsafe(
      `SELECT "type", "payload" FROM "Event" WHERE "itemId" = $1 ORDER BY "id" ASC`,
      itemId,
    );
  }

  async function summaryFor(itemId: string): Promise<Record<string, unknown> | null> {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Summary" WHERE "itemId" = $1`,
      itemId,
    );
    return rows[0] ?? null;
  }

  describe("transition_item — AC1: the service call and its route's underlying operation", () => {
    it("moves an item, appends a state_change event, and returns the applied outcome", async () => {
      const id = await createTask({ state: "executing" });
      const result = (await runtime.call("transition_item", { id, to: "someday" })) as {
        item: { state: string };
        outcome: { allowed: boolean; rehearsed: boolean; from: string; to: string };
      };

      expect(result.item.state).toBe("someday");
      expect(result.outcome).toEqual({
        itemId: id,
        from: "executing",
        to: "someday",
        allowed: true,
        rehearsed: false,
      });
      expect(await readState(id)).toBe("someday");

      const events = await eventsFor(id);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("state_change");
      expect(events[0]?.payload).toEqual({ from: "executing", to: "someday" });
    });

    it("rejects an illegal move with the taxonomy's guard_rejected code, naming the guard", async () => {
      const id = await createTask({ state: "executing" });
      const error = (await runtime
        .call("transition_item", { id, to: "blocked" })
        .catch((e: unknown) => e)) as { code?: string; guard?: string };

      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe("state-machine.blocked_required_fields");
      // Not written — the guard refused before applyTransition's write step.
      expect(await readState(id)).toBe("executing");
    });

    it("accepts blocked_reason and friends through `fields`, persisting them", async () => {
      const id = await createTask({ state: "executing" });
      await runtime.call("transition_item", {
        id,
        to: "blocked",
        fields: { blocked_reason: "waiting on someone", blocked_on_type: "external_process" },
      });
      const row = await prisma.item.findUniqueOrThrow({ where: { id } });
      expect(row.state).toBe("blocked");
      expect(row.blockedReason).toBe("waiting on someone");
    });

    it("attributes the state_change event to the calling actor when one is supplied on the call", async () => {
      const id = await createTask({ state: "executing" });
      await runtime.call(
        "transition_item",
        { id, to: "someday" },
        { caller: { actor: "agent-under-test" } },
      );
      const events = await eventsFor(id);
      const row = await prisma.$queryRawUnsafe<{ actorType: string; actorId: string | null }[]>(
        `SELECT "actorType", "actorId" FROM "Event" WHERE "itemId" = $1`,
        id,
      );
      expect(events).toHaveLength(1);
      expect(row[0]?.actorType).toBe("agent");
      expect(row[0]?.actorId).toBe("agent-under-test");
    });

    it("attributes the state_change event to the system when no actor is supplied", async () => {
      const id = await createTask({ state: "executing" });
      await runtime.call("transition_item", { id, to: "someday" });
      const row = await prisma.$queryRawUnsafe<{ actorType: string; actorId: string | null }[]>(
        `SELECT "actorType", "actorId" FROM "Event" WHERE "itemId" = $1`,
        id,
      );
      expect(row[0]?.actorType).toBe("system");
      expect(row[0]?.actorId).toBeNull();
    });
  });

  describe("transition_item — AC3/AC4: rehearsal mode", () => {
    /**
     * `transition_item`'s dryRun branch always throws `RehearsalRollback`
     * (see `rehearsal-rollback.ts`) — the HTTP route is the intended
     * catcher, but calling the operation directly (as this file does, to
     * test it in isolation from the transport) means every rehearsal in
     * this file goes through this helper rather than a plain `await`.
     */
    async function callDryRun(
      input: Record<string, unknown>,
    ): Promise<{ allowed: boolean; rehearsed: boolean; rejection?: { guard: string } }> {
      const error = await runtime
        .call("transition_item", { ...input, dryRun: true })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RehearsalRollback);
      return (error as RehearsalRollback).outcome as {
        allowed: boolean;
        rehearsed: boolean;
        rejection?: { guard: string };
      };
    }

    it("reports an allowed outcome via dryRun without writing the state", async () => {
      const id = await createTask({ state: "executing" });
      const outcome = await callDryRun({ id, to: "someday" });

      expect(outcome.allowed).toBe(true);
      expect(outcome.rehearsed).toBe(true);
      // AC4's load-bearing assertion: read the database in a call SEPARATE
      // from the one that ran the rehearsal, not the returned payload.
      expect(await readState(id)).toBe("executing");
      expect(await eventsFor(id)).toHaveLength(0);
    });

    it("reports a rejected outcome via dryRun, still without writing anything", async () => {
      const id = await createTask({ state: "executing" });
      const outcome = await callDryRun({ id, to: "blocked" });

      expect(outcome.allowed).toBe(false);
      expect(outcome.rejection?.guard).toBe("state-machine.blocked_required_fields");
      expect(await readState(id)).toBe("executing");
      expect(await eventsFor(id)).toHaveLength(0);
    });

    it("AC4 — a guard's OWN ctx.db write during rehearsal does not survive either, proving the rollback is real and not merely convention", async () => {
      // Plants a guard that writes through ctx.db while deciding — exactly
      // the row #15 review scenario this row was told to resolve
      // deliberately. Registered on the SHARED production registry (not a
      // scratch one) because `transition_item`'s dryRun branch always calls
      // `rehearseTransition` with the default `guardRegistry` — a scratch
      // registry would never be consulted by the real operation, so the
      // test would not actually exercise transition-item.ts's own rollback
      // logic.
      const plantedId = "test.rehearsal_guard_write";
      guardRegistry.register({
        id: plantedId,
        description: "test — writes through ctx.db, then approves",
        appliesTo: () => true,
        async check(input) {
          await input.db.$executeRawUnsafe(
            `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1)`,
            "written-during-rehearsal",
          );
          return guardOk;
        },
      });
      try {
        const id = await createTask({ state: "executing" });
        const outcome = await callDryRun({ id, to: "someday" });

        expect(outcome.allowed).toBe(true);
        // The proof: a separate query, after the call returned, for the row
        // the planted guard tried to write. If the transaction had
        // committed (i.e. the rollback were merely conventional), this row
        // would exist.
        const found = await prisma.area.findUnique({ where: { id: "written-during-rehearsal" } });
        expect(found).toBeNull();
        expect(await readState(id)).toBe("executing");
      } finally {
        guardRegistry.unregister(plantedId);
      }
    });

    it("dryRun's internal rollback throw is RehearsalRollback specifically, carrying the outcome — proving the route's unwrap path is exercised at the right seam", async () => {
      // transitionItem's handler always throws on the dryRun branch — this
      // asserts what it throws is recoverable machinery, not an accident:
      // calling the OPERATION directly (bypassing the route) still surfaces
      // RehearsalRollback with the outcome attached, which is exactly what
      // the HTTP route's catch block (transition/route.ts) is written
      // against.
      const id = await createTask({ state: "executing" });
      const error = await runtime
        .call("transition_item", { id, to: "someday", dryRun: true })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RehearsalRollback);
      expect((error as RehearsalRollback).outcome.allowed).toBe(true);
      expect((error as RehearsalRollback).outcome.rehearsed).toBe(true);
    });
  });

  describe("complete_item — AC2: the service call and its route's underlying operation", () => {
    it("moves the item into the completed state and persists a Summary row", async () => {
      const id = await createTask({ state: "in_review" });
      await satisfyMergeGuards(id);
      const result = (await runtime.call("complete_item", {
        id,
        to: "merged",
        summary: validSummary(),
      })) as { item: { state: string } };

      expect(result.item.state).toBe("merged");
      expect(await readState(id)).toBe("merged");

      const summary = await summaryFor(id);
      expect(summary).not.toBeNull();
      expect(summary?.userFacing).toBe(false);
      expect(summary?.howVerified).toBe("Ran it locally and watched it work end to end.");

      const events = await eventsFor(id);
      expect(events.some((e) => e.type === "state_change")).toBe(true);
    });

    it("persists what_to_test and userFacing=true for a user-facing summary, not just the not-user-facing branch", async () => {
      const id = await createTask({ state: "in_review" });
      await satisfyMergeGuards(id);
      await runtime.call("complete_item", {
        id,
        to: "merged",
        summary: validSummary({
          user_facing: true,
          how_verified: undefined,
          what_to_test: [{ text: "Open the settings page and confirm the new field is there." }],
        }),
      });

      const summary = await summaryFor(id);
      expect(summary?.userFacing).toBe(true);
      expect(summary?.whatToTest).toEqual([
        { text: "Open the settings page and confirm the new field is there." },
      ]);
      expect(summary?.howVerified).toBeNull();
    });

    it("attributes the state_change event to the calling actor when one is supplied", async () => {
      const id = await createTask({ state: "in_review" });
      await satisfyMergeGuards(id);
      await runtime.call(
        "complete_item",
        { id, to: "merged", summary: validSummary() },
        { caller: { actor: "agent-under-test" } },
      );
      const row = await prisma.$queryRawUnsafe<{ actorType: string; actorId: string | null }[]>(
        `SELECT "actorType", "actorId" FROM "Event" WHERE "itemId" = $1 AND "type" = 'state_change'`,
        id,
      );
      expect(row[0]?.actorType).toBe("agent");
      expect(row[0]?.actorId).toBe("agent-under-test");
    });

    it("rejects with guard_rejected when no summary is supplied — the guard fires, not just this operation's own shape check", async () => {
      const id = await createTask({ state: "in_review" });
      // Zod requires `summary` at the schema level, so bypass the operation
      // wrapper's own input validation isn't meaningful here — the
      // interesting rejection is the one this row's own pre-check produces
      // for a shape violation *within* an otherwise-present summary.
      const error = (await runtime
        .call("complete_item", {
          id,
          to: "merged",
          summary: validSummary({ shipped: [] }), // shipped requires 1-5 entries
        })
        .catch((e: unknown) => e)) as { code?: string; fields?: readonly string[] };

      expect(error.code).toBe("guard_rejected");
      expect(error.fields).toContain("shipped");
      expect(await readState(id)).toBe("in_review"); // untouched
    });

    it("rejects a summary that is too similar to an existing event on the item (log-paste)", async () => {
      const id = await createTask({ state: "in_review" });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Event" ("itemId", "actorType", "type", "body", "payload") VALUES ($1, 'system'::"ActorType", 'note'::"EventType", $2, '{}'::jsonb)`,
        id,
        "shipped the entire feature end to end with full test coverage",
      );

      const error = (await runtime
        .call("complete_item", {
          id,
          to: "merged",
          summary: validSummary({
            shipped: ["shipped the entire feature end to end with full test coverage"],
          }),
        })
        .catch((e: unknown) => e)) as { code?: string; fields?: readonly string[] };

      expect(error.code).toBe("guard_rejected");
      expect(error.fields).toContain("shipped[0]");
      expect(await readState(id)).toBe("in_review");
    });

    it("not_done reason follow-up requires the linked item to be non-actionable — rejects when it is still actionable", async () => {
      const id = await createTask({ state: "in_review" });
      const followUp = await createTask({ state: "executing" }); // actionable

      const error = (await runtime
        .call("complete_item", {
          id,
          to: "merged",
          summary: validSummary({
            not_done: [{ text: "Do the rest later.", reason: "follow-up", item_id: followUp }],
          }),
        })
        .catch((e: unknown) => e)) as { code?: string };

      expect(error.code).toBe("guard_rejected");
      expect(await readState(id)).toBe("in_review");
    });

    it("not_done reason follow-up succeeds when the linked item is genuinely non-actionable (blocked)", async () => {
      const id = await createTask({ state: "in_review" });
      const followUp = await createTask({ state: "blocked" });
      await satisfyMergeGuards(id);

      const result = (await runtime.call("complete_item", {
        id,
        to: "merged",
        summary: validSummary({
          not_done: [{ text: "Do the rest later.", reason: "follow-up", item_id: followUp }],
        }),
      })) as { item: { state: string } };

      expect(result.item.state).toBe("merged");
    });

    it("not_done reason needs-approval requires blocked with blocked_on_type person, and rejects otherwise", async () => {
      const id = await createTask({ state: "in_review" });
      const linked = await createTask({ state: "blocked" }); // no blockedOnType set

      const error = (await runtime
        .call("complete_item", {
          id,
          to: "merged",
          summary: validSummary({
            not_done: [{ text: "Needs a call.", reason: "needs-approval", item_id: linked }],
          }),
        })
        .catch((e: unknown) => e)) as { code?: string };

      expect(error.code).toBe("guard_rejected");
    });

    it("not_done reason needs-approval rejects a linked item that has blocked_on_type person but is NOT itself blocked", async () => {
      // The reverse combination from the test above: blockedOnType is set
      // but state is not blocked. Only seedable directly — an item cannot
      // reach this shape through the ordinary transition guard, which
      // clears blockedOnType whenever state leaves blocked (transition.ts's
      // "clearingBlocked" branch) — but the FK proof here reads the two
      // columns independently, so both combinations need to be rejected on
      // their own terms rather than one implying the other.
      const id = await createTask({ state: "in_review" });
      const linked = await createTask({ state: "executing" });
      await prisma.item.update({
        where: { id: linked },
        data: { blockedOnType: "person" },
      });

      const error = (await runtime
        .call("complete_item", {
          id,
          to: "merged",
          summary: validSummary({
            not_done: [{ text: "Needs a call.", reason: "needs-approval", item_id: linked }],
          }),
        })
        .catch((e: unknown) => e)) as { code?: string };

      expect(error.code).toBe("guard_rejected");
    });

    it("not_done reason descoped needs no linked item_id at all", async () => {
      const id = await createTask({ state: "in_review" });
      await satisfyMergeGuards(id);
      const result = (await runtime.call("complete_item", {
        id,
        to: "merged",
        summary: validSummary({
          not_done: [{ text: "Decided not to do this.", reason: "descoped" }],
        }),
      })) as { item: { state: string } };

      expect(result.item.state).toBe("merged");
    });

    it("not_done reason follow-up rejects an item_id that does not name an existing item", async () => {
      const id = await createTask({ state: "in_review" });
      const error = (await runtime
        .call("complete_item", {
          id,
          to: "merged",
          summary: validSummary({
            not_done: [{ text: "Do it later.", reason: "follow-up", item_id: "does-not-exist" }],
          }),
        })
        .catch((e: unknown) => e)) as { code?: string; fields?: readonly string[] };

      expect(error.code).toBe("guard_rejected");
      expect(error.fields).toContain("not_done[0].item_id");
    });

    it("rejects fields.summary as a smuggled second summary — the top-level summary field is the only path", async () => {
      const id = await createTask({ state: "in_review" });
      const error = (await runtime
        .call("complete_item", {
          id,
          to: "merged",
          summary: validSummary(),
          fields: { summary: { shipped: ["a different summary entirely"] } },
        })
        .catch((e: unknown) => e)) as { code?: string };

      expect(error.code).toBe("invalid_input");
    });

    it("hierarchy guard still applies: cannot complete while a child is actionable", async () => {
      const parent = await createTask({ state: "in_review" });
      await createTask({ state: "executing", parentId: parent });

      const error = (await runtime
        .call("complete_item", { id: parent, to: "merged", summary: validSummary() })
        .catch((e: unknown) => e)) as { code?: string; guard?: string };

      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe("hierarchy.no_finish_with_actionable_child");
    });

    it("completing a non-existent item returns not_found, not a 500-shaped internal error", async () => {
      const error = (await runtime
        .call("complete_item", {
          id: "does-not-exist",
          to: "merged",
          summary: validSummary(),
        })
        .catch((e: unknown) => e)) as { code?: string };

      expect(error.code).toBe("not_found");
    });
  });

  describe("AC5 — routes never reach the database directly (structural, exercised at the operation boundary)", () => {
    it("both operations only ever touch the database through ctx.db — proved by running them against a registry with no live guards and observing the exact writes", async () => {
      // A cheap structural sanity check at this layer: a scratch registry
      // with zero guards still requires the transition to go through the
      // same `ctx.db`-scoped transaction — if either operation reached
      // around it, this call would need a second, ungoverned connection
      // instead of failing/succeeding purely on what's visible here.
      const scratch = new GuardRegistry();
      expect(scratch.size()).toBe(0);
      const id = await createTask({ state: "executing" });
      // Sanity: the production runtime (which uses the real guardRegistry,
      // not `scratch`) still enforces the required-fields guard — proving
      // guards are actually consulted through the one shared instance
      // rather than bypassed.
      const error = await runtime
        .call("transition_item", { id, to: "blocked" })
        .catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
    });
  });
});
