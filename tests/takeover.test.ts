// Takeover — displacing a session that holds an item (MILESTONES.md #99,
// SCHEMA.md §2's supersession path).
//
// Two groups, split for the same reason `liveness.test.ts` splits its own:
//
//   - **The pure decisions** (`judgeHolder`, `assertTakeoverAllowed`) — no
//     database, no clock. These are where the rules actually are, so the
//     boundary cases are asserted here where a boundary can be stated exactly
//     rather than approximated by whatever `now` a fixture happened to build.
//   - **The write** — against a real Postgres, because what is under test is
//     what lands in the row and the ledger (`liveness`, `supersededBy`,
//     `releasedAt`, and the `takeover` event's payload and body). An
//     in-memory double would answer those from its own implementation.
//
// **The refusals are the point of this file.** A takeover that always
// succeeds passes every happy-path assertion and protects nothing — the
// entire value of the feature is that displacing a *live* holder costs an
// explicit acknowledgement and a written reason, so the cases that prove it
// refuses are the ones that matter. They are marked below.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GuardRejectedError, ConflictError, NotFoundError } from "@/lib/service";
import type { TransactionHandle } from "@/lib/service";
import {
  ENFORCEMENT_NOTE,
  LIVE_HOLDER_GUARD,
  LIVE_TAKEOVER_WARNING,
  REASON_REQUIRED_GUARD,
  assertTakeoverAllowed,
  judgeHolder,
  takeoverAssignment,
} from "@/lib/takeover";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// judgeHolder — the pure decision.
// ---------------------------------------------------------------------------

describe("judgeHolder — dead or possibly alive", () => {
  const thresholds = { staleAfterSeconds: 900, deadAfterSeconds: 1800 };

  it("a running holder well inside the stale threshold is possibly alive", () => {
    expect(
      judgeHolder({ liveness: "running", releasedAt: null, quietForSeconds: 10, ...thresholds }),
    ).toBe("possibly_alive");
  });

  it("a STALLED holder is possibly alive, not dead — quiet is not gone", () => {
    // The case that decides whether the loud path or the quiet path is the
    // default for the most common real situation. SCHEMA.md §2 permits
    // superseding a stalled assignment; it does not say a stalled session has
    // stopped, and the sweep itself will move one back to `running` on its
    // next tool call. If this ever returned "dead", every stalled holder would
    // be displaceable with no warning and no reason recorded.
    expect(
      judgeHolder({ liveness: "stalled", releasedAt: null, quietForSeconds: 1000, ...thresholds }),
    ).toBe("possibly_alive");
  });

  it("does NOT judge dead one instant early — the boundary itself is still alive", () => {
    // A threshold test that only asserts the firing case passes with any
    // threshold, including one that always fires. This is the direction that
    // matters here: judging dead too eagerly is what silently removes the
    // warning from a takeover that should have had one.
    expect(
      judgeHolder({
        liveness: "running",
        releasedAt: null,
        quietForSeconds: 1799.999,
        ...thresholds,
      }),
    ).toBe("possibly_alive");
  });

  it("judges dead exactly AT the dead threshold", () => {
    expect(
      judgeHolder({ liveness: "running", releasedAt: null, quietForSeconds: 1800, ...thresholds }),
    ).toBe("dead");
  });

  it("a holder already marked dead is dead however recently it was active", () => {
    // `liveness = 'dead'` is a decision the sweep already made and committed.
    // Re-deriving it from the clock alone would let a row the sweep declared
    // dead read as alive again, which is the contradiction §2's invariants
    // exist to prevent.
    expect(
      judgeHolder({ liveness: "dead", releasedAt: null, quietForSeconds: 0, ...thresholds }),
    ).toBe("dead");
  });

  it("a holder already superseded is dead", () => {
    expect(
      judgeHolder({ liveness: "superseded", releasedAt: null, quietForSeconds: 0, ...thresholds }),
    ).toBe("dead");
  });

  it("a RELEASED row is dead without consulting the clock at all", () => {
    // `releasedAt` set means there is no holder left to interrupt, whatever
    // the liveness column says and however recently `lastActive` was stamped.
    expect(
      judgeHolder({
        liveness: "running",
        releasedAt: new Date(),
        quietForSeconds: 0,
        ...thresholds,
      }),
    ).toBe("dead");
  });

  it("respects a DIFFERENT configured dead threshold, not a hard-coded 1800", () => {
    // Proves the thresholds are parameters. A hard-coded 900/1800 passes
    // every case above.
    const tight = { staleAfterSeconds: 2, deadAfterSeconds: 4 };
    expect(
      judgeHolder({ liveness: "running", releasedAt: null, quietForSeconds: 3, ...tight }),
    ).toBe("possibly_alive");
    expect(
      judgeHolder({ liveness: "running", releasedAt: null, quietForSeconds: 4, ...tight }),
    ).toBe("dead");
  });
});

// ---------------------------------------------------------------------------
// assertTakeoverAllowed — the refusals.
// ---------------------------------------------------------------------------

describe("assertTakeoverAllowed — the loud path", () => {
  const base = { itemId: "item-1", fromSessionId: "session-old" };

  it("a DEAD holder needs no force and no reason", () => {
    expect(() =>
      assertTakeoverAllowed({ ...base, holderLiveness: "dead", force: false, reason: null }),
    ).not.toThrow();
  });

  it("REFUSES a possibly-alive holder when force is not set", () => {
    expect(() =>
      assertTakeoverAllowed({
        ...base,
        holderLiveness: "possibly_alive",
        force: false,
        reason: "the person running this system told me to",
      }),
    ).toThrow(GuardRejectedError);
  });

  it("the refusal is attributed to the live-holder guard and names the holder", () => {
    try {
      assertTakeoverAllowed({
        ...base,
        holderLiveness: "possibly_alive",
        force: false,
        reason: null,
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GuardRejectedError);
      const rejection = (error as GuardRejectedError).toRejection();
      expect(rejection.guard).toBe(LIVE_HOLDER_GUARD);
      expect((error as GuardRejectedError).message).toContain("session-old");
    }
  });

  it("the refusal actually SAYS the dangerous thing — not just 'forbidden'", () => {
    // The substance of the warning is the feature. A message that degraded to
    // a bare refusal would still pass "it throws", so this asserts the three
    // things that make it actionable are present: that it is dangerous, that
    // a genuinely good reason is needed, and what the usual valid one is.
    try {
      assertTakeoverAllowed({
        ...base,
        holderLiveness: "possibly_alive",
        force: false,
        reason: null,
      });
      throw new Error("expected a rejection");
    } catch (error) {
      const message = (error as GuardRejectedError).message;
      expect(message).toContain(LIVE_TAKEOVER_WARNING);
      expect(LIVE_TAKEOVER_WARNING).toMatch(/DANGEROUS/);
      expect(LIVE_TAKEOVER_WARNING).toMatch(/genuinely good reason/i);
      expect(LIVE_TAKEOVER_WARNING).toMatch(/told you to/i);
      expect(LIVE_TAKEOVER_WARNING).toMatch(/force/);
    }
  });

  it("REFUSES a forced takeover with no reason", () => {
    expect(() =>
      assertTakeoverAllowed({
        ...base,
        holderLiveness: "possibly_alive",
        force: true,
        reason: null,
      }),
    ).toThrow(GuardRejectedError);
  });

  it("REFUSES a forced takeover whose reason is only whitespace", () => {
    // A reason field that accepts "   " is a required field in name only.
    expect(() =>
      assertTakeoverAllowed({
        ...base,
        holderLiveness: "possibly_alive",
        force: true,
        reason: "   ",
      }),
    ).toThrow(GuardRejectedError);
  });

  it("the missing-reason refusal is its OWN guard, not the live-holder one", () => {
    // Order matters and this is what pins it: a caller that has already set
    // `force` must be told the reason is missing, not told to set the flag it
    // just set. If the two checks were ever reordered, this goes red.
    try {
      assertTakeoverAllowed({
        ...base,
        holderLiveness: "possibly_alive",
        force: true,
        reason: null,
      });
      throw new Error("expected a rejection");
    } catch (error) {
      const rejection = (error as GuardRejectedError).toRejection();
      expect(rejection.guard).toBe(REASON_REQUIRED_GUARD);
      expect(rejection.fields).toEqual(["reason"]);
    }
  });

  it("ALLOWS a forced takeover with a real reason", () => {
    expect(() =>
      assertTakeoverAllowed({
        ...base,
        holderLiveness: "possibly_alive",
        force: true,
        reason: "The person running this system told me to pick this up now.",
      }),
    ).not.toThrow();
  });

  it("a dead holder is allowed even with force explicitly false and no reason", () => {
    // The asymmetry, asserted directly: reclaiming from a session that has
    // demonstrably stopped costs nothing. If the guard ever started requiring
    // a reason unconditionally, this is the case that catches it.
    expect(() =>
      assertTakeoverAllowed({ ...base, holderLiveness: "dead", force: false, reason: null }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres.
// ---------------------------------------------------------------------------

describeIfDb("takeoverAssignment — against a real database", () => {
  const dbName = scratchDatabaseName("takeover");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const migrated = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!migrated.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
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

  function dbHandle(): TransactionHandle {
    return {
      $queryRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$queryRawUnsafe(query, ...values),
      $executeRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$executeRawUnsafe(query, ...values),
    };
  }

  const thresholds = { staleAfterSeconds: 900, deadAfterSeconds: 1800 };

  let counter = 0;
  async function seedItem(): Promise<string> {
    counter += 1;
    const id = `item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: "executing",
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function seedAssignment(
    itemId: string,
    overrides: Partial<{
      liveness: string;
      lastActive: Date;
      sessionId: string;
      releasedAt: Date | null;
    }> = {},
  ): Promise<string> {
    const sessionId = overrides.sessionId ?? `session-old-${counter}`;
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
        releasedAt: overrides.releasedAt ?? null,
      },
    });
    return row.id;
  }

  function taker(overrides: Record<string, unknown> = {}) {
    return {
      bySessionId: "session-new",
      byHolderType: "agent" as const,
      byHolderId: "holder-b",
      ...overrides,
    };
  }

  describe("the dead-holder path — clean, no ceremony", () => {
    it("supersedes a dead holder with no force and no reason", async () => {
      const itemId = await seedItem();
      const sessionId = "session-old-dead";
      const assignmentId = await seedAssignment(itemId, {
        sessionId,
        lastActive: new Date(Date.now() - 3_600_000), // an hour of quiet
      });

      const result = await takeoverAssignment(dbHandle(), thresholds, {
        itemId,
        fromSessionId: sessionId,
        ...taker(),
      });

      expect(result.holderLiveness).toBe("dead");
      expect(result.forced).toBe(false);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("superseded");
      expect(row.supersededBy).toBe("session-new");
      expect(row.releasedAt).not.toBeNull();
    });

    it("sets liveness, supersededBy and releasedAt TOGETHER — never a superseded row that is still live", async () => {
      // SCHEMA.md §2's first invariant. Written as its own case because the
      // three fields are set by one statement precisely so this state cannot
      // be represented; a refactor that split them would leave a window this
      // catches.
      const itemId = await seedItem();
      const sessionId = "session-old-invariant";
      await seedAssignment(itemId, {
        sessionId,
        lastActive: new Date(Date.now() - 3_600_000),
      });

      await takeoverAssignment(dbHandle(), thresholds, {
        itemId,
        fromSessionId: sessionId,
        ...taker(),
      });

      const supersededButLive = await prisma.assignment.findMany({
        where: { liveness: "superseded", releasedAt: null },
      });
      expect(supersededButLive).toEqual([]);
    });

    it("frees the item so a NEW claim actually succeeds — the whole point of #99", async () => {
      // The end-to-end proof. Before this row, a stranded item could never be
      // claimed again by anyone: the claim insert absorbs its conflict and
      // nothing releases the row. This asserts the stranding is actually
      // broken, not merely that some columns changed.
      const { claimItem } = await import("@/lib/claims");
      const itemId = await seedItem();
      const sessionId = "session-old-stranded";
      await seedAssignment(itemId, {
        sessionId,
        lastActive: new Date(Date.now() - 3_600_000),
      });

      // The claim is refused while the dead session still holds the row.
      await expect(
        claimItem(dbHandle(), {
          itemId,
          role: "builder",
          holderType: "agent",
          holderId: "holder-b",
          sessionId: "session-new",
          machine: "laptop",
        }),
      ).rejects.toBeInstanceOf(Error);

      await takeoverAssignment(dbHandle(), thresholds, {
        itemId,
        fromSessionId: sessionId,
        ...taker(),
      });

      const claimed = await claimItem(dbHandle(), {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "holder-b",
        sessionId: "session-new",
        machine: "laptop",
      });
      expect(claimed.sessionId).toBe("session-new");
      expect(claimed.releasedAt).toBeNull();
    });
  });

  describe("the live-holder path — allowed, but loud", () => {
    it("REFUSES an unforced takeover of a live holder, and writes nothing", async () => {
      const itemId = await seedItem();
      const sessionId = "session-old-live";
      const assignmentId = await seedAssignment(itemId, { sessionId, lastActive: new Date() });

      await expect(
        takeoverAssignment(dbHandle(), thresholds, {
          itemId,
          fromSessionId: sessionId,
          ...taker(),
        }),
      ).rejects.toBeInstanceOf(GuardRejectedError);

      // The refusal is not merely an error return — nothing moved. A guard
      // that threw *after* the update would pass a rejects-assertion alone.
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("running");
      expect(row.supersededBy).toBeNull();
      expect(row.releasedAt).toBeNull();
      const events = await prisma.event.findMany({ where: { type: "takeover" } });
      expect(events).toEqual([]);
    });

    it("REFUSES a forced takeover of a live holder with no reason, and writes nothing", async () => {
      const itemId = await seedItem();
      const sessionId = "session-old-live-2";
      const assignmentId = await seedAssignment(itemId, { sessionId, lastActive: new Date() });

      await expect(
        takeoverAssignment(dbHandle(), thresholds, {
          itemId,
          fromSessionId: sessionId,
          force: true,
          ...taker(),
        }),
      ).rejects.toBeInstanceOf(GuardRejectedError);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.releasedAt).toBeNull();
      const events = await prisma.event.findMany({ where: { type: "takeover" } });
      expect(events).toEqual([]);
    });

    it("ALLOWS a forced takeover with a reason, and records the reason durably", async () => {
      const itemId = await seedItem();
      const sessionId = "session-old-live-3";
      const assignmentId = await seedAssignment(itemId, { sessionId, lastActive: new Date() });
      const reason = "The person running this system told me to work on this now.";

      const result = await takeoverAssignment(dbHandle(), thresholds, {
        itemId,
        fromSessionId: sessionId,
        force: true,
        reason,
        ...taker(),
      });

      expect(result.holderLiveness).toBe("possibly_alive");
      expect(result.forced).toBe(true);
      expect(result.reason).toBe(reason);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.liveness).toBe("superseded");
      expect(row.supersededBy).toBe("session-new");

      const events = await prisma.event.findMany({ where: { type: "takeover" } });
      expect(events).toHaveLength(1);
      // The reason survives in the ledger, not merely in the return value —
      // "who took over, from whom, when, and why" has to be answerable long
      // after the call that did it.
      expect(events[0]!.body).toBe(reason);
    });

    it("the takeover event names who took over, from whom, and how alive the holder was", async () => {
      const itemId = await seedItem();
      const sessionId = "session-old-live-4";
      const assignmentId = await seedAssignment(itemId, { sessionId, lastActive: new Date() });

      await takeoverAssignment(dbHandle(), thresholds, {
        itemId,
        fromSessionId: sessionId,
        force: true,
        reason: "I know the other agent is dead.",
        ...taker(),
      });

      const event = (await prisma.event.findMany({ where: { type: "takeover" } }))[0]!;
      const payload = event.payload as Record<string, unknown>;
      expect(payload.fromSessionId).toBe(sessionId);
      expect(payload.bySessionId).toBe("session-new");
      expect(payload.byHolderId).toBe("holder-b");
      expect(payload.holderLiveness).toBe("possibly_alive");
      expect(payload.forced).toBe(true);
      // §3's declared payload for `takeover` describes the assignment taken.
      expect(payload.assignmentId).toBe(assignmentId);
      expect(payload.role).toBe("builder");
      expect(payload.holderId).toBe("holder-a");
      // The actor is the session that took over, not the one displaced.
      expect(event.sessionId).toBe("session-new");
      expect(event.actorId).toBe("holder-b");
      // "when" — the ledger's own timestamp, and the row's release stamp.
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.releasedAt).not.toBeNull();
    });

    it("a STALLED holder is on the loud path — refused without force", async () => {
      // The most common real case, and the one most likely to be quietly
      // reclassified as dead by a well-meaning change. `stalled` means quiet,
      // not gone.
      const itemId = await seedItem();
      const sessionId = "session-old-stalled";
      await seedAssignment(itemId, {
        sessionId,
        liveness: "stalled",
        lastActive: new Date(Date.now() - 1_000_000), // past stale, before dead
      });

      await expect(
        takeoverAssignment(
          dbHandle(),
          { staleAfterSeconds: 900, deadAfterSeconds: 10_000_000 },
          { itemId, fromSessionId: sessionId, ...taker() },
        ),
      ).rejects.toBeInstanceOf(GuardRejectedError);
    });
  });

  describe("the refusals that are not about liveness", () => {
    it("REFUSES a takeover from a session that holds nothing on this item", async () => {
      const itemId = await seedItem();
      await seedAssignment(itemId, { sessionId: "session-actual-holder" });

      await expect(
        takeoverAssignment(dbHandle(), thresholds, {
          itemId,
          fromSessionId: "session-never-held-it",
          ...taker(),
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("REFUSES a session taking over from itself", async () => {
      const itemId = await seedItem();
      await seedAssignment(itemId, {
        sessionId: "session-self",
        lastActive: new Date(Date.now() - 3_600_000),
      });

      await expect(
        takeoverAssignment(dbHandle(), thresholds, {
          itemId,
          fromSessionId: "session-self",
          ...taker({ bySessionId: "session-self" }),
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("REFUSES a takeover of an already-released row, and says to claim instead", async () => {
      const itemId = await seedItem();
      const sessionId = "session-already-released";
      await seedAssignment(itemId, { sessionId, releasedAt: new Date() });

      try {
        await takeoverAssignment(dbHandle(), thresholds, {
          itemId,
          fromSessionId: sessionId,
          ...taker(),
        });
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictError);
        // The refusal has to tell the caller what to do instead, or it just
        // stalls them on an item that is in fact already free.
        expect((error as ConflictError).message).toMatch(/claim it directly/i);
      }
    });

    it("a second takeover of the same row is refused rather than silently overwriting the first", async () => {
      // Two agents both deciding to displace the same holder. The second must
      // not overwrite `supersededBy`, or the record of who actually displaced
      // whom becomes whichever call happened to land last.
      const itemId = await seedItem();
      const sessionId = "session-old-twice";
      const assignmentId = await seedAssignment(itemId, {
        sessionId,
        lastActive: new Date(Date.now() - 3_600_000),
      });

      await takeoverAssignment(dbHandle(), thresholds, {
        itemId,
        fromSessionId: sessionId,
        ...taker({ bySessionId: "session-first" }),
      });

      await expect(
        takeoverAssignment(dbHandle(), thresholds, {
          itemId,
          fromSessionId: sessionId,
          ...taker({ bySessionId: "session-second" }),
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.supersededBy).toBe("session-first");
    });
  });

  describe("what the caller is told about enforcement", () => {
    it("every successful takeover carries the note that the displaced session is NOT stopped", async () => {
      // The honest half. Nothing in this repository yet refuses a displaced
      // session's tool calls, and a caller that assumed otherwise would leave
      // a live agent working on an item somebody else now owns. The note is
      // returned rather than documented, so it reaches a reader who read no
      // documentation at all.
      const itemId = await seedItem();
      const sessionId = "session-old-note";
      await seedAssignment(itemId, {
        sessionId,
        lastActive: new Date(Date.now() - 3_600_000),
      });

      const result = await takeoverAssignment(dbHandle(), thresholds, {
        itemId,
        fromSessionId: sessionId,
        ...taker(),
      });

      expect(result.enforcementNote).toBe(ENFORCEMENT_NOTE);
      expect(ENFORCEMENT_NOTE).toMatch(/NOT prevented from continuing/);
    });
  });
});
