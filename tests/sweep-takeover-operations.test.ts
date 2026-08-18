// The `sweep` and `takeover` service operations (MILESTONES.md #99), against
// a real Postgres — same shape as
// tests/claim-release-heartbeat-checkpoint-note.test.ts, for the same reason:
// what these operations do is write, and rollback and constraint behaviour are
// things only Postgres can prove.
//
// `tests/takeover.test.ts` covers the *rules*. This file covers the
// **operations** — that they are registered, that they validate their input
// through the shared schema, that the refusals survive the service layer with
// the right codes, and that `sweep` is genuinely a caller for the ladder
// rather than a name in the registry with nothing behind it.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  ServiceRuntime,
  isServiceError,
  prismaTransactionRunner,
} from "@/lib/service";
import { defaultSnapshot, resolveSettings } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Registration — no database needed.
// ---------------------------------------------------------------------------

describe("sweep and takeover are registered service operations", () => {
  it("both appear in the operation registry", () => {
    // Not decorative: the MCP adapter derives its tool list from the registry
    // and the conformance harness iterates it, so an operation absent here is
    // unreachable through every adapter at once.
    expect(OPERATION_NAMES).toContain("sweep");
    expect(OPERATION_NAMES).toContain("takeover");
  });
  // Every operation declares three pieces of metadata in the object it hands
  // `defineOperation`, and all three are load-bearing rather than decorative:
  // `name` is the key every adapter dispatches on, `kind` decides whether an
  // adapter may waive the operation under SCHEMA.md §22's read-only rule, and
  // `summary` is the text an agent reads when choosing a tool. Nothing that
  // ran against them could observe them, and the reason is worth recording
  // because it generalises to every operation, not just these two.
  //
  // `tests/service-registry.test.ts` already asserts all three across the
  // whole registry, correctly, and those assertions genuinely fail when the
  // metadata is emptied. But the object passed to `defineOperation` is
  // evaluated once when the module is imported, not inside any test body, so
  // per-test coverage analysis attributes it to no test at all — the
  // registry-wide assertions are recorded as covering zero of it. A gate that
  // cannot see a test cannot credit it, so emptying `name`, `kind` or
  // `summary` was a change no run objected to.
  //
  // Reading the metadata off the registry *here*, inside the test body, is
  // what makes the coverage real: this executes while the run is watching,
  // against the same registry entry an adapter resolves at dispatch.
  it("declares the metadata every adapter dispatches on", () => {
    for (const name of ["sweep", "takeover"] as const) {
      const operation = OPERATION_REGISTRY[name];

      // A `name` disagreeing with its key makes a lookup return an operation
      // reporting a different one — invisible on whichever side is not read.
      expect(operation.name).toBe(name);

      // Both of these WRITE. Declared as reads, §22 would let a read-only
      // adapter waive them while they still release other sessions' claims.
      expect(operation.kind).toBe("write");

      // Long enough to actually describe the operation, matching the bar
      // `service-registry.test.ts` and `adapter-registry.test.ts` both use.
      expect(operation.summary.trim().length).toBeGreaterThan(10);
    }

    // Pinned verbatim rather than by shape: the summary is the whole of what
    // an agent sees before choosing this tool, and "releases claims held by
    // dead sessions" is the part that has to survive an edit.
    expect(OPERATION_REGISTRY.sweep.summary).toBe(
      "Runs the liveness sweep: ages quiet sessions, releases claims held by dead ones, escalates stuck items.",
    );
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres.
// ---------------------------------------------------------------------------

describeIfDb("sweep / takeover operations — against Postgres", () => {
  const dbName = scratchDatabaseName("sweep_takeover_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let itemCounter = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  /**
   * A runtime whose settings snapshot has the liveness thresholds turned
   * right down, so a row whose `lastActive` is a few seconds behind the clock
   * is already dead.
   * The alternative — seeding `lastActive` half an hour back — works too, but
   * this proves the operations read the thresholds from the snapshot rather
   * than from a constant, which a fixture with a huge time offset cannot
   * distinguish.
   */
  function runtimeWithThresholds(overrides: Record<string, unknown>): ServiceRuntime {
    return new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () =>
        resolveSettings({
          overrides: Object.entries(overrides).map(([key, value]) => ({ key, value })),
          revision: 1n,
        }),
    });
  }

  async function seedItem(state = "executing"): Promise<string> {
    itemCounter += 1;
    const id = `item-${itemCounter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: state as never,
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function seedAssignment(
    itemId: string,
    overrides: Partial<{ liveness: string; lastActive: Date; sessionId: string }> = {},
  ): Promise<string> {
    const sessionId = overrides.sessionId ?? `session-${itemCounter}`;
    const row = await prisma.assignment.create({
      data: {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "holder-a",
        sessionId,
        rootSessionId: sessionId,
        machine: "laptop",
        liveness: (overrides.liveness ?? "running") as never,
        lastActive: overrides.lastActive ?? new Date(),
      },
    });
    return row.id;
  }

  // -------------------------------------------------------------------------
  // sweep
  // -------------------------------------------------------------------------

  describe("sweep — the ladder finally has a caller", () => {
    it("RELEASES a claim held by a session past the dead threshold", async () => {
      // The failure #99 exists to fix, asserted end to end through the
      // operation. Before this row nothing invoked the ladder, so this row
      // stayed live forever.
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        lastActive: new Date(Date.now() - 60_000),
      });

      const result = (await runtimeWithThresholds({
        "liveness.stale_after_seconds": 1,
        "liveness.dead_after_seconds": 2,
      }).call("sweep", {})) as unknown as {
        released: string[];
        moves: unknown[];
        checkedAt: string;
      };

      expect(result.released).toContain(assignmentId);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("dead");
      expect(row.releasedAt).not.toBeNull();
    });

    it("credits the release to the caller's agent when the caller identifies itself", async () => {
      // **The operation's own choice of actor, which nothing asserted.**
      //
      // `liveness.test.ts` covers `sweepLiveness` propagating an actor it is
      // *handed* — it calls the function directly with a literal
      // `{ actorType: "agent", actorId: "sweeper-1" }` and never imports this
      // operation at all. So it proves propagation and says nothing about the
      // ternary in `operations/sweep.ts` that *decides* the actor. Hard-coding
      // that ternary either way survived the entire 3874-test suite.
      //
      // That is the same shape as the React-scheduling gap (#128): a guard one
      // layer below the code it is supposed to protect. This drives the real
      // path — `runtime.call("sweep", …)` with a caller — so the choice itself
      // is what is under test.
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        lastActive: new Date(Date.now() - 60_000),
      });

      await runtimeWithThresholds({
        "liveness.stale_after_seconds": 1,
        "liveness.dead_after_seconds": 2,
      }).call("sweep", {}, { caller: { sessionId: "session-sweeper", actor: "agent-sweeper" } });

      const release = await prisma.event.findFirstOrThrow({
        where: { itemId, type: "release" },
        orderBy: { id: "desc" },
      });
      expect(release.assignmentId).toBe(assignmentId);
      expect(release.actorType).toBe("agent");
      expect(release.actorId).toBe("agent-sweeper");
    });

    it("credits the release to `system` when no caller identifies itself", async () => {
      // The other half, and the half that carries the meaning: a scheduled
      // invocation has no agent behind it, and attributing an automatic
      // release to one would put a name on a decision no session made.
      //
      // Both directions are needed. A mutant hard-coding `system` passes the
      // case above only if that case is absent; a mutant hard-coding an agent
      // passes this one only if this one is absent. Together they pin the
      // ternary rather than either of its branches.
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        lastActive: new Date(Date.now() - 60_000),
      });

      await runtimeWithThresholds({
        "liveness.stale_after_seconds": 1,
        "liveness.dead_after_seconds": 2,
      }).call("sweep", {});

      const release = await prisma.event.findFirstOrThrow({
        where: { itemId, type: "release" },
        orderBy: { id: "desc" },
      });
      expect(release.assignmentId).toBe(assignmentId);
      expect(release.actorType).toBe("system");
      expect(release.actorId).toBeNull();
    });

    it("does NOT release a claim inside the thresholds", async () => {
      // The negative control. A sweep that released everything would pass the
      // case above and be catastrophic; this is what separates the two.
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, { lastActive: new Date() });

      const result = (await runtime.call("sweep", {})) as unknown as { released: string[] };

      expect(result.released).toEqual([]);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("running");
      expect(row.releasedAt).toBeNull();
    });

    it("moves a quiet-but-not-dead session to stalled without releasing it", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        lastActive: new Date(Date.now() - 60_000),
      });

      const result = (await runtimeWithThresholds({
        "liveness.stale_after_seconds": 1,
        "liveness.dead_after_seconds": 100_000,
      }).call("sweep", {})) as unknown as {
        released: string[];
        moves: { assignmentId: string; to: string }[];
      };

      expect(result.moves).toContainEqual(expect.objectContaining({ assignmentId, to: "stalled" }));
      expect(result.released).toEqual([]);
    });

    it("escalates an item to blocked once its resume attempts reach the configured limit", async () => {
      const itemId = await seedItem();
      await seedAssignment(itemId, { lastActive: new Date(Date.now() - 60_000) });

      const result = (await runtimeWithThresholds({
        "liveness.stale_after_seconds": 1,
        "liveness.dead_after_seconds": 2,
        "dispatch.resume_attempts_before_blocked": 1,
      }).call("sweep", {})) as unknown as { escalated: { itemId: string }[] };

      expect(result.escalated).toContainEqual(expect.objectContaining({ itemId }));
      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.state).toBe("blocked");
    });

    it("does NOT escalate before the limit is reached", async () => {
      // Same negative control, on the other axis: with the default limit of 3
      // a single dead assignment must not blocked-escalate anything.
      const itemId = await seedItem();
      await seedAssignment(itemId, { lastActive: new Date(Date.now() - 60_000) });

      const result = (await runtimeWithThresholds({
        "liveness.stale_after_seconds": 1,
        "liveness.dead_after_seconds": 2,
        "dispatch.resume_attempts_before_blocked": 3,
      }).call("sweep", {})) as unknown as { escalated: unknown[] };

      expect(result.escalated).toEqual([]);
      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.state).toBe("executing");
    });

    it("REFUSES an input with unrecognised fields rather than ignoring them", async () => {
      // `sweep`'s schema is `.strict()` and takes nothing. A caller that
      // believed it could pass `now` or a filter must be told it cannot, not
      // silently given a full sweep.
      await expect(runtime.call("sweep", { now: "2020-01-01T00:00:00Z" })).rejects.toSatisfy(
        (error: unknown) => isServiceError(error) && error.code === "invalid_input",
      );
    });
  });

  // -------------------------------------------------------------------------
  // takeover
  // -------------------------------------------------------------------------

  describe("takeover — through the service layer", () => {
    function takeoverInput(itemId: string, overrides: Record<string, unknown> = {}) {
      return {
        itemId,
        fromSessionId: "session-old",
        bySessionId: "session-new",
        holderType: "agent",
        holderId: "holder-b",
        ...overrides,
      };
    }

    it("takes over from a dead holder with no force and no reason", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        sessionId: "session-old",
        lastActive: new Date(Date.now() - 3_600_000),
      });

      const result = (await runtime.call("takeover", takeoverInput(itemId))) as {
        holderLiveness: string;
        forced: boolean;
        enforcementNote: string;
      };

      expect(result.holderLiveness).toBe("dead");
      expect(result.forced).toBe(false);
      expect(result.enforcementNote).toMatch(/NOT prevented from continuing/);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.supersededBy).toBe("session-new");
    });

    it("REFUSES an unforced takeover of a live holder with guard_rejected", async () => {
      const itemId = await seedItem();
      await seedAssignment(itemId, { sessionId: "session-old", lastActive: new Date() });

      await expect(runtime.call("takeover", takeoverInput(itemId))).rejects.toSatisfy(
        (error: unknown) => isServiceError(error) && error.code === "guard_rejected",
      );
    });

    it("REFUSES a forced takeover of a live holder with no reason", async () => {
      const itemId = await seedItem();
      await seedAssignment(itemId, { sessionId: "session-old", lastActive: new Date() });

      await expect(
        runtime.call("takeover", takeoverInput(itemId, { force: true })),
      ).rejects.toSatisfy(
        (error: unknown) => isServiceError(error) && error.code === "guard_rejected",
      );
    });

    it("the refusal rolls the whole call back — the transaction commits nothing", async () => {
      // `callOperation` runs the body in one transaction and a throw abandons
      // it. Asserted because a guard that fired after a partial write would
      // still surface as a rejection to the caller while having changed the
      // row.
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        sessionId: "session-old",
        lastActive: new Date(),
      });

      await expect(runtime.call("takeover", takeoverInput(itemId))).rejects.toBeTruthy();

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("running");
      expect(row.releasedAt).toBeNull();
      expect(row.supersededBy).toBeNull();
      expect(await prisma.event.count({ where: { type: "takeover" } })).toBe(0);
    });

    it("ALLOWS a forced takeover of a live holder with a reason", async () => {
      const itemId = await seedItem();
      await seedAssignment(itemId, { sessionId: "session-old", lastActive: new Date() });

      const result = (await runtime.call(
        "takeover",
        takeoverInput(itemId, {
          force: true,
          reason: "The person running this system told me to take this over.",
        }),
      )) as { forced: boolean; reason: string };

      expect(result.forced).toBe(true);
      expect(result.reason).toBe("The person running this system told me to take this over.");
    });

    it("REFUSES a takeover naming an item that does not exist, as not_found", async () => {
      await expect(runtime.call("takeover", takeoverInput("no-such-item"))).rejects.toSatisfy(
        (error: unknown) => isServiceError(error) && error.code === "not_found",
      );
    });

    it("REFUSES an input missing bySessionId, as invalid_input naming the field", async () => {
      const itemId = await seedItem();
      await expect(
        runtime.call("takeover", {
          itemId,
          fromSessionId: "session-old",
          holderType: "agent",
          holderId: "holder-b",
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isServiceError(error) &&
          error.code === "invalid_input" &&
          error.toRejection().fields?.includes("bySessionId") === true,
      );
    });

    it("REFUSES an unrecognised field rather than dropping it", async () => {
      // `.strict()`. A caller that spelled `sessionId` instead of
      // `bySessionId` must be told, not quietly given a different call.
      const itemId = await seedItem();
      await expect(
        runtime.call("takeover", takeoverInput(itemId, { sessionId: "session-new" })),
      ).rejects.toSatisfy(
        (error: unknown) => isServiceError(error) && error.code === "invalid_input",
      );
    });

    it("reads the dead threshold from settings, not from a constant", async () => {
      // A holder quiet for a minute is alive under the default 1800s dead
      // threshold and dead under a 2s one. Same fixture, two snapshots,
      // opposite outcomes — which a hard-coded threshold could not produce.
      const itemId = await seedItem();
      await seedAssignment(itemId, {
        sessionId: "session-old",
        lastActive: new Date(Date.now() - 60_000),
      });

      await expect(runtime.call("takeover", takeoverInput(itemId))).rejects.toSatisfy(
        (error: unknown) => isServiceError(error) && error.code === "guard_rejected",
      );

      const result = (await runtimeWithThresholds({
        "liveness.stale_after_seconds": 1,
        "liveness.dead_after_seconds": 2,
      }).call("takeover", takeoverInput(itemId))) as { holderLiveness: string };
      expect(result.holderLiveness).toBe("dead");
    });
  });
});
