// Claims against a real Postgres (SCHEMA.md §2, MILESTONES.md #23).
//
// Every atomicity assertion here needs a real database and cannot be faked:
// the property under test is that *Postgres* serialises two concurrent
// inserts on a partial unique index, and an in-memory double would decide
// that question by whatever its own implementation happens to do, which is
// exactly the thing that must not be trusted.
//
// **On loop counts.** The concurrency cases below run their race many times
// rather than once, deliberately. A find-then-create claim passes a single
// concurrent run *most of the time* — the window it leaves is small, so one
// green run is evidence of timing, not of correctness. Looping is what turns
// "it didn't happen this time" into "it doesn't happen". Each loop count is
// asserted on rather than left implicit, so a later edit that quietly drops
// the loop to one iteration fails here instead of silently weakening the
// test.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, GuardRejectedError, isServiceError } from "@/lib/service";
import {
  CUSTOM_ROLE_GUARD,
  ROOT_SESSION_GUARD,
  assertRoleCustom,
  assertSameCrew,
  claimItem,
  liveAssignments,
  type Assignment,
  type ClaimInput,
} from "@/lib/claims";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

/** How many times every concurrency case runs its race. */
const RACE_ROUNDS = 25;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A claim with every required field filled, overridable per case. */
function claim(
  overrides: Partial<ClaimInput> & Pick<ClaimInput, "itemId" | "sessionId">,
): ClaimInput {
  return {
    role: "builder",
    holderType: "agent",
    holderId: "crew-member",
    machine: "laptop",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure units — no database needed, so they run everywhere.
// ---------------------------------------------------------------------------

/** Builds just enough of an Assignment for the pure checks to read. */
function liveRow(overrides: Partial<Assignment>): Assignment {
  return {
    id: "assignment-1",
    itemId: "item-1",
    role: "builder",
    roleCustom: null,
    holderType: "agent",
    holderId: "crew-member",
    sessionId: "session-1",
    parentSessionId: null,
    rootSessionId: "root-1",
    machine: "laptop",
    pid: null,
    branch: null,
    worktree: null,
    liveness: "running",
    supersededBy: null,
    claimedAt: new Date(0),
    lastActive: new Date(0),
    releasedAt: null,
    model: null,
    effort: null,
    ...overrides,
  };
}

describe("assertSameCrew — the root-session check", () => {
  it("allows a claim onto an item with no live assignment at all", () => {
    expect(() => assertSameCrew([], "root-a")).not.toThrow();
  });

  it("allows a second member of the SAME crew — the case a unique index could not express", () => {
    // An orchestrator and its own builder both hold the item. This is the
    // reason the crew rule is application code: a unique index on
    // (itemId, rootSessionId) would reject exactly this.
    const live = [liveRow({ role: "orchestrator", sessionId: "s1", rootSessionId: "root-a" })];
    expect(() => assertSameCrew(live, "root-a")).not.toThrow();
  });

  it("rejects a claim from a DIFFERENT crew", () => {
    const live = [liveRow({ rootSessionId: "root-a", sessionId: "s1" })];
    expect(() => assertSameCrew(live, "root-b")).toThrow(GuardRejectedError);
  });

  it("names the current holder in the rejection rather than failing blankly", () => {
    const live = [liveRow({ rootSessionId: "root-a", sessionId: "s1", role: "orchestrator" })];
    let thrown: unknown;
    try {
      assertSameCrew(live, "root-b");
    } catch (error) {
      thrown = error;
    }
    expect(isServiceError(thrown)).toBe(true);
    const error = thrown as GuardRejectedError;
    expect(error.guard).toBe(ROOT_SESSION_GUARD);
    expect(error.code).toBe("guard_rejected");
    // The holder's root session must appear in the message — that is the
    // "name the current holder" half of the rule, and a rejection that
    // merely said "held by another crew" would pass a `toThrow` check
    // while telling the caller nothing it can act on.
    expect(error.message).toContain("root-a");
    expect(error.fields).toEqual(["rootSessionId"]);
    expect(error.details?.heldByRootSessions).toEqual(["root-a"]);
  });

  it("ignores a released row — a crew that has let go is not still holding it", () => {
    // `releasedAt` is set, so this row is not live. If the check ranged
    // over released rows too, an item would be permanently unclaimable by
    // anyone but the first crew ever to touch it.
    const stale = liveRow({ rootSessionId: "root-a", releasedAt: new Date(0) });
    // liveAssignments filters these out in the real path; assertSameCrew is
    // documented to receive only live rows, so this asserts the contract
    // boundary rather than re-testing the filter.
    expect(() => assertSameCrew([], "root-b")).not.toThrow();
    expect(stale.releasedAt).not.toBeNull();
  });
});

describe("assertRoleCustom", () => {
  it("accepts a named custom role", () => {
    expect(() => assertRoleCustom("custom", "release-manager")).not.toThrow();
  });

  it("rejects role=custom with no name", () => {
    expect(() => assertRoleCustom("custom", null)).toThrow(GuardRejectedError);
  });

  it("rejects role=custom whose name is only whitespace", () => {
    // Trimmed, not merely checked for presence: "  " is not a role name,
    // and accepting it would put a blank into the column the enum exists
    // to keep meaningful.
    expect(() => assertRoleCustom("custom", "   ")).toThrow(GuardRejectedError);
  });

  it("rejects a custom name supplied alongside a REAL role — the quiet direction", () => {
    expect(() => assertRoleCustom("builder", "release-manager")).toThrow(GuardRejectedError);
  });

  it("accepts a real role with no custom name", () => {
    expect(() => assertRoleCustom("builder", null)).not.toThrow();
    expect(() => assertRoleCustom("orchestrator", undefined)).not.toThrow();
  });

  it("rejects under the named guard, not a bare Error", () => {
    let thrown: unknown;
    try {
      assertRoleCustom("custom", "");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as GuardRejectedError).guard).toBe(CUSTOM_ROLE_GUARD);
    expect((thrown as GuardRejectedError).fields).toEqual(["roleCustom"]);
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres.
// ---------------------------------------------------------------------------

describeIfDb("claims — against a real database", () => {
  const dbName = scratchDatabaseName("claims");
  let scratchUrl: string;
  let prisma: PrismaClient;

  /** Item ids seeded by this file, cleaned between cases. */
  const seeded: string[] = [];

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    // Events reference assignments, so they go first.
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
    seeded.length = 0;
  });

  async function seedItem(id: string): Promise<string> {
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: "on_deck",
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
      },
    });
    seeded.push(id);
    return id;
  }

  /** Runs one claim in its own transaction, as a real caller would. */
  function claimInOwnTransaction(input: ClaimInput): Promise<Assignment> {
    return prisma.$transaction((tx) => claimItem(tx, input));
  }

  /** How many rows exist on an item, live or not. */
  async function rowCount(itemId: string): Promise<number> {
    return prisma.assignment.count({ where: { itemId } });
  }

  // -- the partial unique indexes themselves ------------------------------

  it("both partial unique indexes exist in the database, with their predicates", async () => {
    // Pinning what the hand-written migration produced. Prisma's own drift
    // check cannot see a partial index at all — it has no way to represent
    // one — so nothing else in this repository would notice if the
    // migration were edited to drop the WHERE clause, which would silently
    // turn "one LIVE orchestrator" into "one orchestrator ever".
    const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'Assignment'`,
    );
    const defs = rows.map((row) => row.indexdef);

    const orchestrator = defs.find((def) => def.includes("one_live_orchestrator_per_item"));
    expect(orchestrator).toBeDefined();
    expect(orchestrator).toContain("UNIQUE");
    expect(orchestrator).toMatch(/WHERE.*orchestrator/s);
    expect(orchestrator).toMatch(/WHERE.*releasedAt.*IS NULL/s);

    const perSession = defs.find((def) => def.includes("one_live_row_per_session_per_item"));
    expect(perSession).toBeDefined();
    expect(perSession).toContain("UNIQUE");
    expect(perSession).toMatch(/WHERE.*releasedAt.*IS NULL/s);
    // The per-session index must key on BOTH columns: on itemId alone it
    // would allow one assignment per item in total, and the whole point of
    // §2's "narrower than it first looks" is that several sessions work
    // one item at once.
    expect(perSession).toMatch(/\("itemId", "sessionId"\)/);
  });

  // -- AC2: one live orchestrator per item --------------------------------

  it("a second orchestrator on the same item is refused", async () => {
    const itemId = await seedItem("item-orch");
    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "orchestrator" }));

    await expect(
      claimInOwnTransaction(
        claim({ itemId, sessionId: "s2", role: "orchestrator", rootSessionId: "s1" }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await rowCount(itemId)).toBe(1);
  });

  it("the refusal names which rule fired and who holds the item", async () => {
    const itemId = await seedItem("item-orch-named");
    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "orchestrator" }));

    let thrown: unknown;
    try {
      await claimInOwnTransaction(
        claim({ itemId, sessionId: "s2", role: "orchestrator", rootSessionId: "s1" }),
      );
    } catch (error) {
      thrown = error;
    }
    const error = thrown as ConflictError;
    expect(error.code).toBe("conflict");
    expect(error.details?.rule).toBe("one_live_orchestrator_per_item");
    expect(error.details?.heldBy).toBe("s1");
    expect(error.message).toContain("s1");
  });

  it("an orchestrator and a builder from the same crew both hold the item", async () => {
    // The rule is one ORCHESTRATOR, not one holder. If the index were on
    // (itemId) unqualified, this would fail — so this case is what stops
    // the constraint being tightened into uselessness.
    const itemId = await seedItem("item-crew");
    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "orchestrator" }));
    await claimInOwnTransaction(
      claim({ itemId, sessionId: "s2", role: "builder", rootSessionId: "s1" }),
    );
    await claimInOwnTransaction(
      claim({ itemId, sessionId: "s3", role: "reviewer", rootSessionId: "s1" }),
    );

    expect(await rowCount(itemId)).toBe(3);
  });

  it("a RELEASED orchestrator does not block a new one — the WHERE clause earning its place", async () => {
    const itemId = await seedItem("item-released");
    const first = await claimInOwnTransaction(
      claim({ itemId, sessionId: "s1", role: "orchestrator" }),
    );
    await prisma.assignment.update({
      where: { id: first.id },
      data: { releasedAt: new Date() },
    });

    // Without `WHERE ... releasedAt IS NULL` on the index, this insert
    // would collide with the released row and an item could never change
    // hands. `previous_sessions` is kept, not deleted (§2), so this is the
    // normal path, not an edge case.
    await claimInOwnTransaction(claim({ itemId, sessionId: "s2", role: "orchestrator" }));
    expect(await rowCount(itemId)).toBe(2);
    expect(await prisma.assignment.count({ where: { itemId, releasedAt: null } })).toBe(1);
  });

  // -- AC3: one row per session per item ----------------------------------

  it("one session cannot hold two live rows on one item", async () => {
    const itemId = await seedItem("item-session");
    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "builder" }));

    await expect(
      claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "reviewer" })),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await rowCount(itemId)).toBe(1);
  });

  it("the same session CAN hold rows on two different items", async () => {
    // The index is (itemId, sessionId), not (sessionId). One agent working
    // two items at once is ordinary; forbidding it would be a bug this
    // case would catch.
    const a = await seedItem("item-a");
    const b = await seedItem("item-b");
    await claimInOwnTransaction(claim({ itemId: a, sessionId: "s1" }));
    await claimInOwnTransaction(claim({ itemId: b, sessionId: "s1" }));

    expect(await rowCount(a)).toBe(1);
    expect(await rowCount(b)).toBe(1);
  });

  it("a session that released its row may claim the same item again", async () => {
    const itemId = await seedItem("item-reclaim");
    const first = await claimInOwnTransaction(claim({ itemId, sessionId: "s1" }));
    await prisma.assignment.update({
      where: { id: first.id },
      data: { releasedAt: new Date() },
    });

    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "reviewer" }));
    expect(await rowCount(itemId)).toBe(2);
  });

  it("the session refusal is reported as the session rule even when the claim asked to orchestrate", async () => {
    // Both rules apply at once here. The more specific one — "you already
    // hold this item" — is the actionable answer; reporting the
    // orchestrator rule instead would send the caller looking for a
    // session other than itself.
    const itemId = await seedItem("item-both-rules");
    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "orchestrator" }));

    let thrown: unknown;
    try {
      await claimInOwnTransaction(
        claim({ itemId, sessionId: "s1", role: "builder", rootSessionId: "s1" }),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ConflictError).details?.rule).toBe("one_row_per_session_per_item");
  });

  // -- AC4: the root-session check, end to end ----------------------------

  it("a claim from a different crew is refused and the item keeps one crew", async () => {
    const itemId = await seedItem("item-crews");
    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "orchestrator" }));

    await expect(
      claimInOwnTransaction(
        claim({ itemId, sessionId: "other", role: "builder", rootSessionId: "root-b" }),
      ),
    ).rejects.toBeInstanceOf(GuardRejectedError);

    expect(await rowCount(itemId)).toBe(1);
  });

  it("a root claim defaults its root session to itself", async () => {
    // Omitting rootSessionId means "I am a root", not "unknown". If it
    // defaulted to null or to the parent, the crew check on the NEXT claim
    // would compare against the wrong value.
    const itemId = await seedItem("item-root");
    const assignment = await claimInOwnTransaction(claim({ itemId, sessionId: "s1" }));
    expect(assignment.rootSessionId).toBe("s1");
    expect(assignment.parentSessionId).toBeNull();
  });

  it("an omitted root session means THIS session, even when a parent is named", async () => {
    // The two fields answer different questions, and defaulting the root to
    // the parent would conflate them. A grandchild's parent is its builder;
    // its root is the orchestrator above that. So an omitted root must mean
    // "I am a root", never "whatever my parent was" — otherwise a claim
    // three levels deep records the wrong crew, and every later crew check
    // compares against a value that names the middle of the tree.
    //
    // A caller that omits the root while naming a parent is stating exactly
    // that: a session with a parent that is nonetheless the top of its own
    // crew for this item.
    const itemId = await seedItem("item-root-vs-parent");
    const assignment = await claimInOwnTransaction(
      claim({ itemId, sessionId: "child", parentSessionId: "some-parent" }),
    );
    expect(assignment.parentSessionId).toBe("some-parent");
    expect(assignment.rootSessionId).toBe("child");
    expect(assignment.rootSessionId).not.toBe("some-parent");
  });

  it("a spawned session inherits the crew and is allowed alongside its root", async () => {
    const itemId = await seedItem("item-spawn");
    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "orchestrator" }));
    const child = await claimInOwnTransaction(
      claim({
        itemId,
        sessionId: "s2",
        role: "builder",
        parentSessionId: "s1",
        rootSessionId: "s1",
      }),
    );
    expect(child.rootSessionId).toBe("s1");
    expect(child.parentSessionId).toBe("s1");
  });

  // -- the claim event ----------------------------------------------------

  it("a successful claim appends exactly one `claim` event, in the same transaction", async () => {
    const itemId = await seedItem("item-event");
    const assignment = await claimInOwnTransaction(
      claim({ itemId, sessionId: "s1", role: "orchestrator" }),
    );

    const events = await prisma.event.findMany({ where: { itemId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("claim");
    expect(events[0]?.assignmentId).toBe(assignment.id);
    expect(events[0]?.sessionId).toBe("s1");
  });

  it("a refused claim appends NO event — the whole transaction rolls back", async () => {
    const itemId = await seedItem("item-event-rollback");
    await claimInOwnTransaction(claim({ itemId, sessionId: "s1", role: "orchestrator" }));

    await expect(
      claimInOwnTransaction(
        claim({ itemId, sessionId: "s2", role: "orchestrator", rootSessionId: "s1" }),
      ),
    ).rejects.toThrow();

    // Exactly one event: the first claim's. A second would mean the
    // refusal path wrote before failing.
    expect(await prisma.event.count({ where: { itemId } })).toBe(1);
  });

  // -- AC1: atomicity under genuine concurrency ---------------------------
  //
  // Each of these runs the same race RACE_ROUNDS times. Two sequential
  // claims prove nothing about atomicity — a find-then-create implementation
  // passes that every time. The assertion that matters in each round is
  // that the row count did not grow past what the rule allows.

  it(`${RACE_ROUNDS} rounds: concurrent orchestrator claims — exactly one wins each round`, async () => {
    let rounds = 0;
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const itemId = await seedItem(`race-orch-${round}`);
      const attempts = ["a", "b", "c", "d"].map((suffix) =>
        claimInOwnTransaction(
          claim({
            itemId,
            sessionId: `${suffix}-${round}`,
            role: "orchestrator",
            // Every attempt declares the SAME crew, so the root-session
            // check cannot be what refuses them. The only thing left to
            // refuse a second orchestrator is the index.
            rootSessionId: "shared-root",
          }),
        ),
      );
      const settled = await Promise.allSettled(attempts);

      const won = settled.filter((result) => result.status === "fulfilled");
      expect(won).toHaveLength(1);
      // The count is the real assertion. A non-atomic claim's failure mode
      // is two rows, not two thrown errors.
      expect(await rowCount(itemId)).toBe(1);

      for (const result of settled) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(ConflictError);
        }
      }
      rounds += 1;
    }
    // Pinned so a later edit that drops the loop fails here rather than
    // quietly turning this into a single lucky run.
    expect(rounds).toBe(RACE_ROUNDS);
    expect(RACE_ROUNDS).toBeGreaterThanOrEqual(20);
  }, 180_000);

  it(`${RACE_ROUNDS} rounds: concurrent claims from ONE session — exactly one row each round`, async () => {
    let rounds = 0;
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const itemId = await seedItem(`race-session-${round}`);
      // Same session, DIFFERENT roles, so the orchestrator index is not
      // what refuses them — this isolates the per-session index.
      const roles = ["builder", "reviewer", "scout", "visual_reviewer"] as const;
      const settled = await Promise.allSettled(
        roles.map((role) =>
          claimInOwnTransaction(
            claim({ itemId, sessionId: "one-session", role, rootSessionId: "one-session" }),
          ),
        ),
      );

      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await rowCount(itemId)).toBe(1);
      rounds += 1;
    }
    expect(rounds).toBe(RACE_ROUNDS);
    expect(RACE_ROUNDS).toBeGreaterThanOrEqual(20);
  }, 180_000);

  it(`${RACE_ROUNDS} rounds: concurrent DIFFERENT-role claims from the same crew all succeed`, async () => {
    // The negative control for the two races above. If the claim path
    // were serialising everything — say by taking a table lock, or by an
    // index too broad to be correct — the two tests above would still
    // pass while this one failed. Concurrency that refuses everything is
    // not the property being asked for.
    let rounds = 0;
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const itemId = await seedItem(`race-ok-${round}`);
      const settled = await Promise.allSettled([
        claimInOwnTransaction(
          claim({ itemId, sessionId: `p-${round}`, role: "builder", rootSessionId: "crew" }),
        ),
        claimInOwnTransaction(
          claim({ itemId, sessionId: `q-${round}`, role: "reviewer", rootSessionId: "crew" }),
        ),
        claimInOwnTransaction(
          claim({ itemId, sessionId: `r-${round}`, role: "scout", rootSessionId: "crew" }),
        ),
      ]);

      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(3);
      expect(await rowCount(itemId)).toBe(3);
      rounds += 1;
    }
    expect(rounds).toBe(RACE_ROUNDS);
    expect(RACE_ROUNDS).toBeGreaterThanOrEqual(20);
  }, 180_000);

  // -- liveAssignments ----------------------------------------------------

  it("liveAssignments returns only unreleased rows", async () => {
    const itemId = await seedItem("item-live");
    const first = await claimInOwnTransaction(claim({ itemId, sessionId: "s1" }));
    await claimInOwnTransaction(
      claim({ itemId, sessionId: "s2", role: "reviewer", rootSessionId: "s1" }),
    );
    await prisma.assignment.update({
      where: { id: first.id },
      data: { releasedAt: new Date() },
    });

    const live = await prisma.$transaction((tx) => liveAssignments(tx, itemId));
    expect(live.map((row) => row.sessionId)).toEqual(["s2"]);
  });
});
