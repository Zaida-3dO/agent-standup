// The liveness ladder and the capability-document sweep (SCHEMA.md §2, §17.5;
// MILESTONES.md #24).
//
// Two groups of tests:
//   - `nextLivenessRung` — pure, no database, no clock. Every threshold
//     boundary is a table-driven case so a fencepost error in either
//     direction fails a NAMED case rather than surviving as an off-by-one
//     nobody wrote a row for.
//   - The rest — against a real Postgres, because the property under test
//     is what the sweep actually writes (assignment liveness, released_at,
//     item.resumeAttempts, item.state, capability_checks rows), which an
//     in-memory double would decide by its own implementation.
//
// **On loop counts.** Nothing here depends on a real sleep. Every
// "how long has it been quiet" question is answered by handing `sweepLiveness`
// an explicit `now`, computed from a `lastActive` written directly into the
// database — so a boundary test is exact and instant rather than
// probabilistic, and there is no loop count to report for this file (unlike
// claims.test.ts's genuine concurrency races, timing here is deterministic
// by construction, not by chance).
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BLOCKED_PAUSED_GUARDS, GuardRegistry } from "@/lib/service";
import type { TransactionHandle } from "@/lib/service";
import { resolveSettings } from "@/lib/settings";
import {
  nextLivenessRung,
  sweepCapabilityDocuments,
  sweepLiveness,
  type CapabilityFsCheck,
} from "@/lib/liveness";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// The pure ladder.
// ---------------------------------------------------------------------------

describe("nextLivenessRung — the pure ladder", () => {
  const thresholds = { staleAfterSeconds: 900, deadAfterSeconds: 1800 };

  it("stays running well inside the stale threshold", () => {
    expect(nextLivenessRung({ quietForSeconds: 0, ...thresholds })).toBe("running");
    expect(nextLivenessRung({ quietForSeconds: 899, ...thresholds })).toBe("running");
  });

  it("does NOT fire stalled one second early — the boundary itself is still running", () => {
    // The threshold test that matters: a check that only asserts the firing
    // case passes with ANY threshold, including one that always fires. This
    // is the case that would catch `>=` silently becoming `>` in the wrong
    // direction, or the boundary constant drifting by one.
    expect(nextLivenessRung({ quietForSeconds: 899.999, ...thresholds })).toBe("running");
  });

  it("fires stalled exactly AT the stale threshold", () => {
    expect(nextLivenessRung({ quietForSeconds: 900, ...thresholds })).toBe("stalled");
  });

  it("stays stalled well inside the dead threshold", () => {
    expect(nextLivenessRung({ quietForSeconds: 901, ...thresholds })).toBe("stalled");
    expect(nextLivenessRung({ quietForSeconds: 1799, ...thresholds })).toBe("stalled");
  });

  it("does NOT fire dead one second early — the boundary itself is still stalled", () => {
    expect(nextLivenessRung({ quietForSeconds: 1799.999, ...thresholds })).toBe("stalled");
  });

  it("fires dead exactly AT the dead threshold", () => {
    expect(nextLivenessRung({ quietForSeconds: 1800, ...thresholds })).toBe("dead");
  });

  it("stays dead arbitrarily far past the threshold", () => {
    expect(nextLivenessRung({ quietForSeconds: 100_000, ...thresholds })).toBe("dead");
  });

  it("respects a DIFFERENT configured threshold, not a hard-coded 900/1800", () => {
    // Proves the thresholds are read as parameters, not baked in. A
    // hard-coded 900/1800 would still pass every case above.
    const tight = { staleAfterSeconds: 5, deadAfterSeconds: 10 };
    expect(nextLivenessRung({ quietForSeconds: 4, ...tight })).toBe("running");
    expect(nextLivenessRung({ quietForSeconds: 5, ...tight })).toBe("stalled");
    expect(nextLivenessRung({ quietForSeconds: 9, ...tight })).toBe("stalled");
    expect(nextLivenessRung({ quietForSeconds: 10, ...tight })).toBe("dead");
  });

  it("the dead check wins the overlap — a row quiet long enough for both is dead, not stalled", () => {
    // If the two `if`s in nextLivenessRung were ever reordered (stale
    // checked first, unconditionally returning "stalled"), this is the case
    // that would go red: quietForSeconds is past BOTH thresholds at once.
    expect(
      nextLivenessRung({ quietForSeconds: 1800, staleAfterSeconds: 900, deadAfterSeconds: 1800 }),
    ).toBe("dead");
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres.
// ---------------------------------------------------------------------------

describeIfDb("sweepLiveness — against a real database", () => {
  const dbName = scratchDatabaseName("liveness");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let guards: GuardRegistry;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
    await prisma.capabilityCheck.deleteMany({});
  });

  function dbHandle(): TransactionHandle {
    return {
      $queryRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$queryRawUnsafe(query, ...values),
      $executeRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$executeRawUnsafe(query, ...values),
    };
  }

  function snapshot(overrides: Record<string, unknown> = {}) {
    return resolveSettings({
      overrides: Object.entries(overrides).map(([key, value]) => ({ key, value })),
      revision: 1n,
    });
  }

  const actor = { actorType: "system" as const, actorId: null };

  let counter = 0;
  async function seedItem(overrides: Partial<{ state: string; resumeAttempts: number }> = {}) {
    counter += 1;
    const id = `item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: (overrides.state ?? "executing") as never,
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
        resumeAttempts: overrides.resumeAttempts ?? 0,
      },
    });
    return id;
  }

  async function seedAssignment(
    itemId: string,
    overrides: Partial<{ liveness: string; lastActive: Date; sessionId: string }> = {},
  ) {
    const row = await prisma.assignment.create({
      data: {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "crew-member",
        sessionId: overrides.sessionId ?? `session-${counter}`,
        rootSessionId: overrides.sessionId ?? `session-${counter}`,
        machine: "laptop",
        liveness: (overrides.liveness ?? "running") as never,
        lastActive: overrides.lastActive ?? new Date(),
      },
    });
    return row.id;
  }

  beforeAll(() => {
    // Builds its own scratch registry rather than reaching for the shared
    // `guardRegistry` singleton (the one `src/lib/service/guards` populates
    // as a side effect of `live.ts`'s import) — same isolation every other
    // state-machine test uses, so this file's guard state never depends on
    // import order relative to the composition root. Registration into an
    // arbitrary registry is a fixed side effect of importing
    // `guards/index.ts` for the shared singleton, so a scratch registry
    // needs its own skip-if-already-registered loop directly over the
    // exported guard list, `BLOCKED_PAUSED_GUARDS`.
    guards = new GuardRegistry();
    for (const guard of BLOCKED_PAUSED_GUARDS) {
      if (!guards.has(guard.id)) {
        guards.register(guard);
      }
    }
  });

  // -- AC1: the ladder itself -----------------------------------------------

  describe("criterion 1 — the ladder, thresholds read from settings", () => {
    it("does not move a running assignment before the stale threshold", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "running",
        lastActive: new Date(Date.now() - 800_000), // 800s of quiet
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.moves).toEqual([]);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("running");
    });

    it("moves running -> stalled once the stale threshold is crossed", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "running",
        lastActive: new Date(Date.now() - 901_000),
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.moves).toEqual([{ assignmentId, itemId, from: "running", to: "stalled" }]);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("stalled");
      expect(row.releasedAt).toBeNull();
    });

    it("does not move a stalled assignment to dead before the dead threshold", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_700_000), // past stale, before dead
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.moves).toEqual([]);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("stalled");
    });

    it("moves stalled -> dead and releases the claim once the dead threshold is crossed", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.moves).toEqual([{ assignmentId, itemId, from: "stalled", to: "dead" }]);
      expect(result.released).toEqual([assignmentId]);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("dead");
      expect(row.releasedAt).not.toBeNull();
    });

    it("a RUNNING assignment quiet past BOTH thresholds skips straight to dead in one sweep", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "running",
        lastActive: new Date(Date.now() - 5_000_000),
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.moves).toEqual([{ assignmentId, itemId, from: "running", to: "dead" }]);
    });

    it("never touches a SUPERSEDED assignment, however long it has been quiet", async () => {
      // SCHEMA.md §2's second invariant: liveness freezes at `superseded`.
      // The query in sweepLiveness only selects `running`/`stalled` rows —
      // this proves that filter holds, not merely that the ladder function
      // would refuse to move it if asked.
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "superseded",
        lastActive: new Date(Date.now() - 5_000_000),
      });

      const result = await sweepLiveness(dbHandle(), snapshot(), actor, { guards });

      expect(result.moves).toEqual([]);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("superseded");
      expect(row.releasedAt).toBeNull();
    });

    it("never touches an already-DEAD assignment a second time", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "dead",
        lastActive: new Date(Date.now() - 5_000_000),
      });
      await prisma.assignment.update({
        where: { id: assignmentId },
        data: { releasedAt: new Date() },
      });

      const result = await sweepLiveness(dbHandle(), snapshot(), actor, { guards });

      expect(result.moves).toEqual([]);
      expect(result.released).toEqual([]);
    });

    it("thresholds come from SETTINGS, not a hard-coded default — a tight override fires sooner", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "running",
        lastActive: new Date(Date.now() - 10_000), // 10s quiet — nowhere near the 900s default
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 5, "liveness.dead_after_seconds": 20 }),
        actor,
        { guards },
      );

      expect(result.moves).toEqual([{ assignmentId, itemId, from: "running", to: "stalled" }]);
    });
  });

  // -- AC2/AC3: resume attempts and escalation -------------------------------

  describe("criteria 2/3 — resume attempts and escalation to blocked", () => {
    it("the scratch registry actually holds the blocked/paused guards escalation depends on", () => {
      // `escalateToBlocked` runs through the real, guarded transition path
      // (`applyTransition`) — but `runGuards` silently allows anything
      // through an EMPTY registry (an empty array has no guard to reject
      // it), so every test in this describe block would pass just as well
      // against a `guards` that was constructed but never populated. This
      // is the one direct check on the registration this file's `beforeAll`
      // performs, so a regression there (the registry going empty again)
      // fails HERE by name instead of silently by nothing failing at all.
      for (const guard of BLOCKED_PAUSED_GUARDS) {
        expect(guards.has(guard.id)).toBe(true);
      }
    });

    it("going dead increments the item's resumeAttempts by exactly one", async () => {
      const itemId = await seedItem({ resumeAttempts: 0 });
      await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      await sweepLiveness(dbHandle(), snapshot(), actor, { guards });

      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.resumeAttempts).toBe(1);
    });

    it("does NOT escalate before the configured attempt count is reached", async () => {
      // The threshold test that matters for this criterion: a check that
      // only asserts the firing case would pass even if escalation fired on
      // attempt 1 against a limit of 3.
      const itemId = await seedItem({ resumeAttempts: 1 }); // one more -> 2, limit is 3
      await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "dispatch.resume_attempts_before_blocked": 3 }),
        actor,
        { guards },
      );

      expect(result.escalated).toEqual([]);
      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.resumeAttempts).toBe(2);
      expect(item.state).toBe("executing");
    });

    it("escalates to blocked exactly when the attempt count reaches the configured limit", async () => {
      const itemId = await seedItem({ resumeAttempts: 2 }); // one more -> 3, limit is 3
      await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "dispatch.resume_attempts_before_blocked": 3 }),
        actor,
        { guards },
      );

      expect(result.escalated).toEqual([{ itemId, resumeAttempts: 3 }]);
      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.state).toBe("blocked");
      expect(item.blockedReason).toContain("3");
      expect(item.blockedOnType).toBe("external_process");
    });

    it("escalation goes through the REAL guarded transition — blocked_on_type is set, not left null", async () => {
      // If escalateToBlocked wrote a raw UPDATE instead of calling
      // applyTransition, this is the case that would still pass "state is
      // blocked" while silently skipping row #16's required-fields guard —
      // this asserts the guard-required field actually landed.
      const itemId = await seedItem({ resumeAttempts: 2 });
      await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      await sweepLiveness(
        dbHandle(),
        snapshot({ "dispatch.resume_attempts_before_blocked": 3 }),
        actor,
        { guards },
      );

      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.blockedOnType).not.toBeNull();
      expect(item.blockedReason).not.toBeNull();
    });

    it("an item already blocked is not re-escalated (no duplicate escalation event)", async () => {
      const itemId = await seedItem({ state: "blocked", resumeAttempts: 5 });
      await prisma.item.update({
        where: { id: itemId },
        data: { blockedReason: "already blocked", blockedOnType: "person" },
      });
      await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "dispatch.resume_attempts_before_blocked": 3 }),
        actor,
        { guards },
      );

      expect(result.escalated).toEqual([]);
      // The pre-existing blocked reason must survive untouched.
      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.blockedReason).toBe("already blocked");
    });

    it("appends a `release` event and an `escalation` event, attributed to the sweep actor", async () => {
      const itemId = await seedItem({ resumeAttempts: 2 });
      const assignmentId = await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      await sweepLiveness(
        dbHandle(),
        snapshot({ "dispatch.resume_attempts_before_blocked": 3 }),
        { actorType: "agent", actorId: "sweeper-1" },
        { guards },
      );

      const events = await prisma.event.findMany({ where: { itemId }, orderBy: { id: "asc" } });
      const types = events.map((event) => event.type);
      expect(types).toContain("release");
      expect(types).toContain("escalation");
      const releaseEvent = events.find((event) => event.type === "release");
      expect(releaseEvent?.assignmentId).toBe(assignmentId);
      expect(releaseEvent?.actorId).toBe("sweeper-1");
      const escalationEvent = events.find((event) => event.type === "escalation");
      expect(escalationEvent?.actorId).toBe("sweeper-1");
    });
  });

  // -- transactional behaviour ------------------------------------------------

  describe("the sweep runs inside the caller's transaction", () => {
    it("a sweep that is rolled back leaves no trace", async () => {
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      await expect(
        prisma.$transaction(async (tx) => {
          const handle: TransactionHandle = {
            $queryRawUnsafe: (q: string, ...v: unknown[]) => tx.$queryRawUnsafe(q, ...v),
            $executeRawUnsafe: (q: string, ...v: unknown[]) => tx.$executeRawUnsafe(q, ...v),
          };
          await sweepLiveness(handle, snapshot(), actor, { guards });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("stalled");
      expect(row.releasedAt).toBeNull();
    });
  });

  // -- AC4: capability document re-verification ------------------------------

  describe("criterion 4 — capability document re-verification", () => {
    it("skips a capability whose setting is null — nothing to check, no row written", async () => {
      const result = await sweepCapabilityDocuments(
        dbHandle(),
        snapshot({ "notify.doc": null, "visual_review.doc": null }),
        actor,
        new Date(),
        { exists: async () => true },
      );

      expect(result).toEqual([]);
      expect(await prisma.capabilityCheck.count()).toBe(0);
    });

    it("records `exists` and the checker identity when the path is found", async () => {
      const fs: CapabilityFsCheck = { exists: async () => true };
      const now = new Date();

      const result = await sweepCapabilityDocuments(
        dbHandle(),
        snapshot({ "notify.doc": "/docs/notify.md" }),
        { actorType: "system", actorId: null },
        now,
        fs,
      );

      expect(result).toEqual([{ key: "notify.doc", path: "/docs/notify.md", result: "exists" }]);
      const row = await prisma.capabilityCheck.findUniqueOrThrow({ where: { key: "notify.doc" } });
      expect(row.result).toBe("exists");
      expect(row.path).toBe("/docs/notify.md");
      expect(row.lastCheckedByType).toBe("system");
      expect(row.lastCheckedAt.getTime()).toBe(now.getTime());
    });

    it("records `missing` when the path is not found — the loud-warning case", async () => {
      const fs: CapabilityFsCheck = { exists: async () => false };

      const result = await sweepCapabilityDocuments(
        dbHandle(),
        snapshot({ "visual_review.doc": "/docs/gone.md" }),
        actor,
        new Date(),
        fs,
      );

      expect(result).toEqual([
        { key: "visual_review.doc", path: "/docs/gone.md", result: "missing" },
      ]);
    });

    it("records `unverified` for a URL — the core never fetches one to check it", async () => {
      const fs: CapabilityFsCheck = { exists: async () => true }; // must be ignored for a URL
      const result = await sweepCapabilityDocuments(
        dbHandle(),
        snapshot({ "notify.doc": "https://example.com/notify" }),
        actor,
        new Date(),
        fs,
      );
      expect(result).toEqual([
        { key: "notify.doc", path: "https://example.com/notify", result: "unverified" },
      ]);
    });

    it("records `unverified` when the checking process cannot see the filesystem", async () => {
      const fs: CapabilityFsCheck = { exists: async () => "unknown" };
      const result = await sweepCapabilityDocuments(
        dbHandle(),
        snapshot({ "notify.doc": "/some/path.md" }),
        actor,
        new Date(),
        fs,
      );
      expect(result).toEqual([{ key: "notify.doc", path: "/some/path.md", result: "unverified" }]);
    });

    it("re-checking overwrites the previous row in place — latest result, not a history", async () => {
      const first = new Date(Date.now() - 60_000);
      await sweepCapabilityDocuments(
        dbHandle(),
        snapshot({ "notify.doc": "/docs/notify.md" }),
        { actorType: "agent", actorId: "checker-1" },
        first,
        { exists: async () => true },
      );

      const second = new Date();
      await sweepCapabilityDocuments(
        dbHandle(),
        snapshot({ "notify.doc": "/docs/notify.md" }),
        { actorType: "agent", actorId: "checker-2" },
        second,
        { exists: async () => false },
      );

      expect(await prisma.capabilityCheck.count()).toBe(1);
      const row = await prisma.capabilityCheck.findUniqueOrThrow({ where: { key: "notify.doc" } });
      expect(row.result).toBe("missing");
      expect(row.lastCheckedById).toBe("checker-2");
      expect(row.lastCheckedAt.getTime()).toBe(second.getTime());
    });

    it("checks BOTH capabilities independently when both are configured", async () => {
      const result = await sweepCapabilityDocuments(
        dbHandle(),
        snapshot({ "notify.doc": "/docs/a.md", "visual_review.doc": "/docs/b.md" }),
        actor,
        new Date(),
        { exists: async () => true },
      );
      expect(result.map((r) => r.key).sort()).toEqual(["notify.doc", "visual_review.doc"]);
      expect(await prisma.capabilityCheck.count()).toBe(2);
    });

    it("is included in a full sweepLiveness pass, not just callable standalone", async () => {
      // No injected fs check here — sweepLiveness uses the production
      // default, so this asserts against a path that genuinely does not
      // exist on this filesystem ("missing"), proving the capability check
      // actually runs as part of the combined pass rather than merely being
      // callable on its own.
      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "notify.doc": "/docs/notify.md" }),
        actor,
        { guards },
      );
      expect(result.capabilityChecks).toEqual([
        { key: "notify.doc", path: "/docs/notify.md", result: "missing" },
      ]);
    });
  });
  // -------------------------------------------------------------------------
  // The hook-aware exemption, and the rehearsal. Both added for the incident
  // where one sweep released the claims of two sessions that were alive and
  // mid-build.
  // -------------------------------------------------------------------------

  describe("the exemption for a holder that never had a way to signal", () => {
    /**
     * Seeds a holder the way a real claim arrives: `lastActive` equal to
     * `claimedAt`, because nothing has stamped it. `quietForSeconds` is then
     * really the age of the claim, which is the whole point — this holder
     * looks identically quiet whether it is working or dead.
     */
    async function seedNeverSignalledHolder(
      itemId: string,
      opts: { quietForSeconds: number; hookVersion: number | null; sessionId: string },
    ) {
      const stamp = new Date(Date.now() - opts.quietForSeconds * 1000);
      await prisma.session.create({
        data: {
          id: opts.sessionId,
          machine: "laptop",
          transport: "cli_direct" as never,
          hookVersion: opts.hookVersion,
        },
      });
      const row = await prisma.assignment.create({
        data: {
          itemId,
          role: "builder",
          holderType: "agent",
          holderId: "crew-member",
          sessionId: opts.sessionId,
          rootSessionId: opts.sessionId,
          machine: "laptop",
          liveness: "running" as never,
          lastActive: stamp,
          claimedAt: stamp,
        },
      });
      return row.id;
    }

    afterEach(async () => {
      await prisma.toolCall.deleteMany({});
      await prisma.session.deleteMany({});
    });

    it("does NOT release the claim of an unhooked holder quiet past the dead threshold", async () => {
      // The incident, reduced. Past the 1800s dead threshold, and this holder
      // registered no hook, so nothing was ever going to stamp `lastActive`
      // for it. Its silence is its configuration, not evidence that it died.
      const itemId = await seedItem();
      const assignmentId = await seedNeverSignalledHolder(itemId, {
        quietForSeconds: 2_000,
        hookVersion: null,
        sessionId: "session-unhooked",
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.released).toEqual([]);
      expect(result.exempted).toEqual([
        expect.objectContaining({ assignmentId, itemId, sessionId: "session-unhooked" }),
      ]);

      // The claim actually survives in the database — not merely absent from
      // a returned list.
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.releasedAt).toBeNull();
    });

    it("still marks that exempt holder STALLED, so it is visible rather than hidden", async () => {
      // The exemption caps the rung; it does not suppress the observation. An
      // operator has to be able to see a quiet unhooked holder in order to
      // reach for `takeover`, which is its only route back.
      const itemId = await seedItem();
      const assignmentId = await seedNeverSignalledHolder(itemId, {
        quietForSeconds: 2_000,
        hookVersion: null,
        sessionId: "session-unhooked-visible",
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.moves).toEqual([{ assignmentId, itemId, from: "running", to: "stalled" }]);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("stalled");
    });

    it("DOES release a hooked holder quiet for the same time — the exemption is not a blanket reprieve", async () => {
      // Same silence, same threshold, one difference: this session declared a
      // hook, so it had a mechanism that stamps on every flush. Silence from
      // it is a real observation. This is the test that stops the exemption
      // from simply disabling reclamation.
      const itemId = await seedItem();
      const assignmentId = await seedNeverSignalledHolder(itemId, {
        quietForSeconds: 2_000,
        hookVersion: 3,
        sessionId: "session-hooked",
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.exempted).toEqual([]);
      expect(result.released).toEqual([assignmentId]);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.releasedAt).not.toBeNull();
      expect(row.liveness).toBe("dead");
    });

    it("DOES release an unhooked holder that has emitted a tool call — one signal retires the exemption", async () => {
      // The escape hatch, and the thing that keeps the exemption from being a
      // permanent hiding place. This holder registered no hook but has
      // demonstrably been seen, so its later silence is evidence again.
      const itemId = await seedItem();
      const assignmentId = await seedNeverSignalledHolder(itemId, {
        quietForSeconds: 2_000,
        hookVersion: null,
        sessionId: "session-unhooked-but-seen",
      });
      await prisma.toolCall.create({
        data: {
          sessionId: "session-unhooked-but-seen",
          tool: "Read",
          ts: new Date(Date.now() - 1_900 * 1000),
        },
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.exempted).toEqual([]);
      expect(result.released).toEqual([assignmentId]);
    });

    it("does not exempt a row whose lastActive sits well BEHIND its own claim", async () => {
      // The state the shared predicate's deliberately-loose `<=` also admits,
      // and which is not the exempt case: an activity timestamp older than the
      // claim it belongs to is an inconsistency, not silence. Without the
      // ordering allowance this row would receive an indefinite claim.
      const itemId = await seedItem();
      const claimedAt = new Date(Date.now() - 2_000 * 1000);
      const row = await prisma.assignment.create({
        data: {
          itemId,
          role: "builder",
          holderType: "agent",
          holderId: "crew-member",
          sessionId: "session-inconsistent",
          rootSessionId: "session-inconsistent",
          machine: "laptop",
          liveness: "running" as never,
          lastActive: new Date(claimedAt.getTime() - 60 * 60 * 1000),
          claimedAt,
        },
      });
      await prisma.session.create({
        data: {
          id: "session-inconsistent",
          machine: "laptop",
          transport: "cli_direct" as never,
          hookVersion: null,
        },
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards },
      );

      expect(result.exempted).toEqual([]);
      expect(result.released).toEqual([row.id]);
    });
  });

  describe("dryRun — a rehearsal that writes nothing", () => {
    it("reports the release it would make and leaves the database untouched", async () => {
      // The assertion that matters is against the DATABASE, not against the
      // returned shape: a rehearsal that reported correctly and still wrote
      // would satisfy any check made on its return value alone.
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });
      const before = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      const eventsBefore = await prisma.event.count();
      const itemBefore = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards, dryRun: true },
      );

      // It still says what it would have done.
      expect(result.dryRun).toBe(true);
      expect(result.moves).toEqual([{ assignmentId, itemId, from: "stalled", to: "dead" }]);
      expect(result.released).toEqual([assignmentId]);

      // ...and nothing moved.
      const after = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(after.liveness).toBe(before.liveness);
      expect(after.releasedAt).toBeNull();
      expect(await prisma.event.count()).toBe(eventsBefore);
      const itemAfter = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(itemAfter.resumeAttempts).toBe(itemBefore.resumeAttempts);
      expect(itemAfter.state).toBe(itemBefore.state);
    });

    it("does not record a capability check", async () => {
      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "notify.doc": "/docs/notify.md" }),
        actor,
        { guards, dryRun: true },
      );

      // Resolved and reported...
      expect(result.capabilityChecks).toEqual([
        { key: "notify.doc", path: "/docs/notify.md", result: "missing" },
      ]);
      // ...but not written down.
      expect(await prisma.capabilityCheck.count()).toBe(0);
    });

    it("reports the escalation it would make without blocking the item", async () => {
      // The subtlest write in the pass: a real sweep increments the resume
      // count with `UPDATE ... RETURNING` and escalates on the result. The
      // rehearsal has to reach the same verdict from a read.
      const itemId = await seedItem({ resumeAttempts: 2 });
      await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({
          "liveness.stale_after_seconds": 900,
          "liveness.dead_after_seconds": 1800,
          "dispatch.resume_attempts_before_blocked": 3,
        }),
        actor,
        { guards, dryRun: true },
      );

      expect(result.escalated).toEqual([{ itemId, resumeAttempts: 3 }]);
      const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.state).not.toBe("blocked");
      expect(item.resumeAttempts).toBe(2);
    });

    it("a real sweep still writes — the rehearsal flag is what suppresses it, not the code path", async () => {
      // The control. Without this, every assertion above would still pass if
      // the sweep had simply stopped working.
      const itemId = await seedItem();
      const assignmentId = await seedAssignment(itemId, {
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_801_000),
      });

      const result = await sweepLiveness(
        dbHandle(),
        snapshot({ "liveness.stale_after_seconds": 900, "liveness.dead_after_seconds": 1800 }),
        actor,
        { guards, dryRun: false },
      );

      expect(result.dryRun).toBe(false);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("dead");
      expect(row.releasedAt).not.toBeNull();
    });
  });
});
