// Crew naming (SCHEMA.md §9, MILESTONES.md #34) against a real Postgres.
//
// The atomicity claim under test — that handing out a name never gives two
// concurrent callers the same one — is a property of what *Postgres* does
// with `UPDATE ... WHERE name = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`.
// An in-memory double would decide that question by whatever its own
// implementation happens to do, which is exactly the thing that must not be
// trusted here — same reasoning tests/claims.test.ts states for its own
// races.
//
// **On loop counts.** Every concurrency case below runs its race many times,
// not once. A single green run cannot tell a genuinely atomic allocator
// apart from a lucky one — this repo already shipped that mistake once (a
// `prisma.upsert`-based allocator whose concurrency test passed at merge
// time and flaked later; see areas.ts's header). Each loop count is asserted
// on rather than left implicit, so an edit that quietly drops it to one
// iteration fails here instead of silently weakening the test.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { ConflictError, NotFoundError, isServiceError } from "@/lib/service";
import {
  assignName,
  handOutName,
  listActiveNames,
  releaseName,
  retireName,
  type AgentNameRow,
} from "@/lib/agent-names";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

/** How many times every concurrency case runs its race. */
const RACE_ROUNDS = 25;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("agent-names — against a real database", () => {
  const dbName = scratchDatabaseName("agent_names");
  let scratchUrl: string;
  let prisma: PrismaClient;

  /** Agent names seeded by this file, cleaned between cases. */
  const seeded: string[] = [];
  let seedCounter = 0;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.agent.deleteMany({ where: { name: { in: seeded } } });
    seeded.length = 0;
  });

  /** Seeds `count` fresh, unheld, unretired agent names and returns them. */
  async function seedNames(count: number, prefix = "agent"): Promise<string[]> {
    seedCounter += 1;
    const names = Array.from(
      { length: count },
      (_, i) => `${prefix}-${seedCounter}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await prisma.agent.createMany({ data: names.map((name) => ({ name })) });
    seeded.push(...names);
    return names;
  }

  /** How many agent rows in `names` are held (`heldBySessionId` not `null`). */
  async function heldCount(names: string[]): Promise<number> {
    return prisma.agent.count({ where: { name: { in: names }, heldBySessionId: { not: null } } });
  }

  /** Seeds exactly one fresh name and returns it directly (no array destructure). */
  async function seedOneName(prefix = "agent"): Promise<string> {
    const [name] = await seedNames(1, prefix);
    if (!name) {
      throw new Error("seedOneName: seedNames(1) returned no name");
    }
    return name;
  }

  // -- AC1: hand-out is atomic under genuine concurrency ------------------
  //
  // Runs the race RACE_ROUNDS times. Two sequential hand-outs prove nothing
  // about atomicity — sequential calls never contend for the same row in
  // the first place. The assertion that matters each round is that the
  // *set* of names handed out has no duplicates and is no larger than the
  // pool, however many callers raced for it.

  it(`${RACE_ROUNDS} rounds: N sessions racing a pool of N names — every session gets a DIFFERENT name, none left over`, async () => {
    const CONCURRENT = 5;
    let rounds = 0;
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const pool = await seedNames(CONCURRENT, `race-exact-${round}`);
      const sessions = pool.map((_, i) => `session-${round}-${i}`);

      const results = await Promise.all(
        sessions.map((sessionId) => handOutName(prisma, sessionId)),
      );

      const handedOut = results.map((r) => r?.name);
      // Nobody came back empty-handed — the pool exactly matched demand.
      expect(handedOut.every((name) => name !== undefined)).toBe(true);
      // No two sessions received the same name — the actual atomicity claim.
      expect(new Set(handedOut).size).toBe(CONCURRENT);
      // Every handed-out name is recorded as held by the session that got it.
      results.forEach((result, i) => {
        expect(result?.heldBySessionId).toBe(sessions[i]);
      });
      expect(await heldCount(pool)).toBe(CONCURRENT);
      rounds += 1;
    }
    expect(rounds).toBe(RACE_ROUNDS);
    expect(RACE_ROUNDS).toBeGreaterThanOrEqual(20);
  }, 180_000);

  it(`${RACE_ROUNDS} rounds: more sessions than names — exactly one loser per surplus session, pool exhausted cleanly`, async () => {
    let rounds = 0;
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const pool = await seedNames(3, `race-scarce-${round}`);
      const sessions = Array.from({ length: 5 }, (_, i) => `s-${round}-${i}`);

      const results = await Promise.all(
        sessions.map((sessionId) => handOutName(prisma, sessionId)),
      );

      const winners = results.filter((r): r is AgentNameRow => r !== undefined);
      const losers = results.filter((r) => r === undefined);
      // Exactly as many winners as there were names, however many sessions
      // raced for them — a non-atomic implementation's failure mode is
      // MORE winners than names, handing the same row to two sessions.
      expect(winners).toHaveLength(3);
      expect(losers).toHaveLength(2);
      expect(new Set(winners.map((w) => w.name)).size).toBe(3);
      expect(await heldCount(pool)).toBe(3);
      rounds += 1;
    }
    expect(rounds).toBe(RACE_ROUNDS);
    expect(RACE_ROUNDS).toBeGreaterThanOrEqual(20);
  }, 180_000);

  // -- hand-out: sequential behaviour --------------------------------------

  it("hands out an available name and records the holding session", async () => {
    const name = await seedOneName();
    const result = await handOutName(prisma, "session-a");
    expect(result?.name).toBe(name);
    expect(result?.heldBySessionId).toBe("session-a");
    expect(result?.heldAt).toBeInstanceOf(Date);
  });

  it("does not hand out a name that is already held", async () => {
    await seedNames(1, "held");
    const first = await handOutName(prisma, "session-a");
    expect(first).toBeDefined();

    // No other unheld, unretired names in this scratch DB at this point in
    // the file (each case seeds and cleans its own), so a second hand-out
    // must come back empty.
    const second = await handOutName(prisma, "session-b");
    expect(second).toBeUndefined();
  });

  it("does not hand out a retired name", async () => {
    const name = await seedOneName("retired-pool");
    await retireName(prisma, name);

    const result = await handOutName(prisma, "session-a");
    expect(result).toBeUndefined();
  });

  it("returns undefined, not an error, when the pool is exhausted", async () => {
    // No seeded names at all for this case.
    await expect(handOutName(prisma, "session-a")).resolves.toBeUndefined();
  });

  // -- AC2: assign a specific name -----------------------------------------

  it("assigns a specific available name to a session", async () => {
    const name = await seedOneName();
    const result = await assignName(prisma, name, "session-a");
    expect(result.name).toBe(name);
    expect(result.heldBySessionId).toBe("session-a");
  });

  it("refuses to assign a name that does not exist", async () => {
    await expect(assignName(prisma, "no-such-name-ever", "session-a")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("refuses to assign an already-held name, naming the current holder", async () => {
    const name = await seedOneName();
    await assignName(prisma, name, "session-a");

    let thrown: unknown;
    try {
      await assignName(prisma, name, "session-b");
    } catch (error) {
      thrown = error;
    }
    expect(isServiceError(thrown)).toBe(true);
    const error = thrown as ConflictError;
    expect(error.code).toBe("conflict");
    expect(error.details?.rule).toBe("name_already_held");
    expect(error.details?.heldBySessionId).toBe("session-a");
  });

  it("refuses to assign a retired name, distinctly from an already-held one", async () => {
    const name = await seedOneName();
    await retireName(prisma, name);

    let thrown: unknown;
    try {
      await assignName(prisma, name, "session-a");
    } catch (error) {
      thrown = error;
    }
    const error = thrown as ConflictError;
    expect(error.details?.rule).toBe("name_retired");
  });

  it(`${RACE_ROUNDS} rounds: two sessions racing to assign the SAME name — exactly one wins`, async () => {
    let rounds = 0;
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const name = await seedOneName(`race-assign-${round}`);
      const settled = await Promise.allSettled([
        assignName(prisma, name, `a-${round}`),
        assignName(prisma, name, `b-${round}`),
      ]);

      const won = settled.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      for (const result of settled) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(ConflictError);
        }
      }
      expect(await heldCount([name])).toBe(1);
      rounds += 1;
    }
    expect(rounds).toBe(RACE_ROUNDS);
    expect(RACE_ROUNDS).toBeGreaterThanOrEqual(20);
  }, 180_000);

  // -- release --------------------------------------------------------------

  it("releases a held name, clearing both hold columns", async () => {
    const name = await seedOneName();
    await assignName(prisma, name, "session-a");

    const released = await releaseName(prisma, name, "session-a");
    expect(released?.heldBySessionId).toBeNull();
    expect(released?.heldAt).toBeNull();

    const row = await prisma.agent.findUniqueOrThrow({ where: { name } });
    expect(row.heldBySessionId).toBeNull();
  });

  it("a released name can be handed out again", async () => {
    const name = await seedOneName();
    await assignName(prisma, name, "session-a");
    await releaseName(prisma, name, "session-a");

    const result = await handOutName(prisma, "session-b");
    expect(result?.name).toBe(name);
    expect(result?.heldBySessionId).toBe("session-b");
  });

  it("releasing with the WRONG session is a no-op, not a takeover", async () => {
    const name = await seedOneName();
    await assignName(prisma, name, "session-a");

    const result = await releaseName(prisma, name, "session-b");
    expect(result).toBeUndefined();

    // Still held by session-a — the wrong-session release did nothing.
    const row = await prisma.agent.findUniqueOrThrow({ where: { name } });
    expect(row.heldBySessionId).toBe("session-a");
  });

  it("releasing a name that was never held is a no-op", async () => {
    const name = await seedOneName();
    const result = await releaseName(prisma, name, "session-a");
    expect(result).toBeUndefined();
  });

  // -- AC3 + AC4: retire, and reuse semantics --------------------------------
  //
  // Reading of SCHEMA.md §9 taken here (stated in the PR/handoff, not just
  // in code): retiring a name is permanent and does NOT clear an existing
  // hold. "Names appear throughout history" — a name retired mid-use keeps
  // recording who was using it rather than erasing the fact, and a retired
  // name can never be handed out or assigned again, held or not.

  it("retires a name, setting retiredAt", async () => {
    const name = await seedOneName();
    const result = await retireName(prisma, name);
    expect(result.retiredAt).toBeInstanceOf(Date);
  });

  it("retiring a HELD name does not clear the hold — history is kept, not erased", async () => {
    const name = await seedOneName();
    await assignName(prisma, name, "session-a");

    const retired = await retireName(prisma, name);
    expect(retired.retiredAt).toBeInstanceOf(Date);
    expect(retired.heldBySessionId).toBe("session-a");

    const row = await prisma.agent.findUniqueOrThrow({ where: { name } });
    expect(row.heldBySessionId).toBe("session-a");
  });

  it("a retired name can never be handed out again, even after its holder releases it", async () => {
    const name = await seedOneName();
    await assignName(prisma, name, "session-a");
    await retireName(prisma, name);
    await releaseName(prisma, name, "session-a");

    // Unheld now (released), but retired — must still be unavailable.
    const row = await prisma.agent.findUniqueOrThrow({ where: { name } });
    expect(row.heldBySessionId).toBeNull();
    expect(row.retiredAt).not.toBeNull();

    const result = await handOutName(prisma, "session-b");
    expect(result).toBeUndefined();
  });

  it("retiring an already-retired name is refused, not a silent second success", async () => {
    const name = await seedOneName();
    await retireName(prisma, name);

    await expect(retireName(prisma, name)).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to retire a name that does not exist", async () => {
    await expect(retireName(prisma, "no-such-name-ever")).rejects.toBeInstanceOf(NotFoundError);
  });

  it(`${RACE_ROUNDS} rounds: two callers racing to retire the SAME name — exactly one succeeds`, async () => {
    let rounds = 0;
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const name = await seedOneName(`race-retire-${round}`);
      const settled = await Promise.allSettled([
        retireName(prisma, name),
        retireName(prisma, name),
      ]);

      expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const result of settled) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(ConflictError);
        }
      }
      const row = await prisma.agent.findUniqueOrThrow({ where: { name } });
      expect(row.retiredAt).not.toBeNull();
      rounds += 1;
    }
    expect(rounds).toBe(RACE_ROUNDS);
    expect(RACE_ROUNDS).toBeGreaterThanOrEqual(20);
  }, 180_000);

  // -- listActiveNames --------------------------------------------------------

  it("listActiveNames excludes retired names but includes held ones", async () => {
    const names = await seedNames(3, "list");
    const held = names[0]!;
    const retired = names[1]!;
    const free = names[2]!;
    await assignName(prisma, held, "session-a");
    await retireName(prisma, retired);

    const active = await listActiveNames(prisma);
    const activeNames = active.map((a) => a.name);
    expect(activeNames).toContain(held);
    expect(activeNames).toContain(free);
    expect(activeNames).not.toContain(retired);
  });
});
