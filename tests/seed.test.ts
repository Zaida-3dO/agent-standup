// Real Postgres, real seed script, run for real — twice. Per CLAUDE.md's
// testing tenet, a failure path "tested" only by stubbing the client does
// not satisfy this criterion, and per the task brief for this row: a test
// that seeds once and asserts row counts does not test idempotency at all.
// It has to run the seed a second time against the same, already-seeded
// database and prove the second run neither duplicates rows nor throws —
// which is exactly the failure mode a naive `prisma.person.create(...)`
// implementation (instead of `upsert`) would produce: it would work once,
// then throw a unique-constraint violation on Person's primary key the
// moment this same suite calls it again. That is the single-character-ish
// change ("upsert" -> "create") this test is built to catch.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seed } from "../prisma/seed.mjs";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const execFileAsync = promisify(execFile);
const SEED_SCRIPT_PATH = fileURLToPath(new URL("../prisma/seed.mjs", import.meta.url));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("prisma/seed.mjs — against a real Postgres", () => {
  const dbName = scratchDatabaseName("seed");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("seeds two people, the agent name roster, and an account on a clean database", async () => {
    const result = await seed(prisma);

    expect(result.people).toHaveLength(2);
    expect(result.agents.length).toBeGreaterThanOrEqual(1);
    expect(result.accounts).toHaveLength(1);

    const people = await prisma.person.findMany({ orderBy: { id: "asc" } });
    expect(people.map((p) => p.id)).toEqual(["user-a", "user-b"]);
    // Placeholders only — never a real name (CLAUDE.md, "this repository is
    // PUBLIC"). Asserted here so a future edit that swaps in a real name
    // fails this test, not just a human read-through.
    for (const person of people) {
      expect(person.id).toMatch(/^user-[a-z]$/);
      expect(person.displayName).toMatch(/^User [A-Z]$/);
    }

    const agents = await prisma.agent.findMany({ orderBy: { name: "asc" } });
    expect(agents.length).toBeGreaterThanOrEqual(1);
    for (const agent of agents) {
      // Not the real crew roster — generic invented names only.
      expect(agent.name).toMatch(/^agent-[a-z]+$/);
    }

    const accounts = await prisma.account.findMany();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.vendor).toBe("anthropic");
  });

  it("running it a second time is a no-op: no error, no duplicate rows, identical content", async () => {
    // First run establishes the baseline on a fresh, empty database — a
    // separate scratch database from the test above, so this test proves
    // idempotency on its own rather than depending on run order.
    const secondDbName = scratchDatabaseName("seed-twice");
    const secondUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, secondDbName)).url;
    const client = createTestPrismaClient(secondUrl);

    try {
      await seed(client);

      const peopleAfterFirstRun = await client.person.findMany({ orderBy: { id: "asc" } });
      const agentsAfterFirstRun = await client.agent.findMany({ orderBy: { name: "asc" } });
      const accountsAfterFirstRun = await client.account.findMany({ orderBy: { id: "asc" } });

      // The actual double-run: seed a database that is ALREADY seeded. This
      // is the call that fails loudly if the implementation ever regresses
      // to plain `create` — Person/Agent/Account primary keys would throw a
      // unique-constraint violation on this exact line.
      await expect(seed(client)).resolves.not.toThrow();

      const peopleAfterSecondRun = await client.person.findMany({ orderBy: { id: "asc" } });
      const agentsAfterSecondRun = await client.agent.findMany({ orderBy: { name: "asc" } });
      const accountsAfterSecondRun = await client.account.findMany({ orderBy: { id: "asc" } });

      // Row counts unchanged — the part a hollow test would settle for.
      expect(peopleAfterSecondRun).toHaveLength(peopleAfterFirstRun.length);
      expect(agentsAfterSecondRun).toHaveLength(agentsAfterFirstRun.length);
      expect(accountsAfterSecondRun).toHaveLength(accountsAfterFirstRun.length);

      // Content unchanged too, field by field — a duplicate-avoidance
      // strategy that silently overwrote a field (e.g. reset createdAt, or
      // dropped a column value) would pass a bare count check but fail this.
      expect(peopleAfterSecondRun).toEqual(peopleAfterFirstRun);
      expect(agentsAfterSecondRun).toEqual(agentsAfterFirstRun);
      expect(accountsAfterSecondRun).toEqual(accountsAfterFirstRun);

      // And the primary keys themselves are exactly the expected set, both
      // times — proves the second run didn't, say, silently create
      // "user-a-2" instead of colliding on "user-a".
      expect(peopleAfterSecondRun.map((p) => p.id).sort()).toEqual(["user-a", "user-b"]);
    } finally {
      await client.$disconnect();
      await dropScratchDatabase(testDatabaseUrl!, secondDbName);
    }
  }, 20_000); // creates a scratch database, migrates it, then seeds it twice — slower than vitest's 5s default

  // Every test above imports `seed` and calls it directly — none of them
  // ever runs `node prisma/seed.mjs` as a real process, so none of them
  // exercises the self-invocation guard (`process.argv[1]` compared against
  // `import.meta.url`) that `npm run db:seed` actually depends on. That
  // guard was the bug: built with a hand-rolled `file://` string that never
  // matches a Windows path's three-slash form, so the script exited 0
  // having done nothing. A `seed(prisma)` unit test cannot see that failure
  // — it has to be a real subprocess with a real `argv[1]`.
  it("`node prisma/seed.mjs`, run as a real subprocess, actually seeds the database", async () => {
    const dbName = scratchDatabaseName("seed-cli");
    const scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;

    try {
      const { stdout } = await execFileAsync(process.execPath, [SEED_SCRIPT_PATH], {
        env: { ...process.env, DATABASE_URL: scratchUrl },
      });

      // The success path's own log line — the one signal the original bug
      // report says is easy to miss in npm output. A regressed guard prints
      // nothing at all here, so this line is the first thing that fails.
      expect(stdout).toMatch(/Seeded \d+ people, \d+ agents?, \d+ accounts?\.?/i);

      const client = createTestPrismaClient(scratchUrl);
      try {
        // The actual regression: on the broken guard this subprocess exits
        // 0 and every one of these tables is empty, because `main()` never
        // ran at all.
        const people = await client.person.findMany();
        const agents = await client.agent.findMany();
        const accounts = await client.account.findMany();
        expect(people.length).toBeGreaterThan(0);
        expect(agents.length).toBeGreaterThan(0);
        expect(accounts.length).toBeGreaterThan(0);
      } finally {
        await client.$disconnect();
      }
    } finally {
      await dropScratchDatabase(testDatabaseUrl!, dbName);
    }
  }, 20_000);
});
