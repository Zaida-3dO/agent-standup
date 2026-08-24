// Covers the two mechanisms that stop scratch databases accumulating on the
// dev Postgres: the run token that gives a whole run one identity, and the
// token-scoped sweep that reclaims databases a dead worker never dropped.
//
// The failure being guarded against is a silent, monotonic leak. Every
// DB-backed test file creates a database and drops it in `afterAll`, which
// runs on the happy path only — a worker killed by Ctrl-C, an OOM or a hard
// timeout skips it and leaks the database forever. Roughly 670 had
// accumulated by 2026-08-24.
//
// The danger in the fix is as important as the fix. Cleanup here means
// dropping databases on a server other agents are using concurrently, and a
// too-broad match has already destroyed two databases that were not its own
// (2026-08-24). So the tests below assert just as hard on what the sweep must
// NOT touch as on what it must remove.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createScratchDatabase,
  dropScratchDatabase,
  dropScratchDatabasesForToken,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

function adminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

async function databaseExists(databaseUrl: string, name: string): Promise<boolean> {
  const client = new Client({ connectionString: adminUrl(databaseUrl) });
  await client.connect();
  try {
    const { rows } = await client.query(`select 1 from pg_database where datname = $1`, [name]);
    return rows.length === 1;
  } finally {
    await client.end();
  }
}

describeIfDb("scratch database naming and token-scoped sweep", () => {
  const url = testDatabaseUrl!;

  describe("scratchDatabaseName", () => {
    it("carries the shared prefix and the purpose, so a name says what it was for", () => {
      const name = scratchDatabaseName("sweep_naming");
      expect(name.startsWith("agent_standup_test_")).toBe(true);
      expect(name).toContain("sweep_naming");
    });

    it("ends with the run token from the environment, which is what makes a run sweepable", () => {
      // The whole cleanup design rests on this: every database in one run ends
      // with the same token. If the name stopped ending with it, the sweep
      // below would silently match nothing and the leak would return.
      const token = process.env.TEST_RUN_TOKEN;
      // Only meaningful under the global setup that publishes a token.
      if (!token) return;
      expect(scratchDatabaseName("sweep_naming").endsWith(`_${token}`)).toBe(true);
    });
  });

  describe("dropScratchDatabasesForToken", () => {
    // A token of this test's own, so nothing here can collide with the real
    // run token or with a concurrent suite.
    const token = randomBytes(3).toString("hex");
    const otherToken = randomBytes(3).toString("hex");

    const leaked = `agent_standup_test_sweep_leaked_${token}`;
    const alsoLeaked = `agent_standup_test_sweep_also_${token}`;
    const otherRun = `agent_standup_test_sweep_other_${otherToken}`;

    beforeAll(async () => {
      // Two databases standing in for ones whose worker died before `afterAll`,
      // plus one standing in for a DIFFERENT run happening at the same time.
      await createScratchDatabase(url, leaked);
      await createScratchDatabase(url, alsoLeaked);
      await createScratchDatabase(url, otherRun);
    }, 60_000);

    afterAll(async () => {
      // `otherRun` is the only one expected to survive the assertions.
      await dropScratchDatabase(url, otherRun);
      await dropScratchDatabase(url, leaked);
      await dropScratchDatabase(url, alsoLeaked);
    });

    it("drops every database bearing the token, including ones no afterAll ever reached", async () => {
      expect(await databaseExists(url, leaked)).toBe(true);
      expect(await databaseExists(url, alsoLeaked)).toBe(true);

      const dropped = await dropScratchDatabasesForToken(url, token);

      expect(dropped).toEqual([alsoLeaked, leaked].sort());
      expect(await databaseExists(url, leaked)).toBe(false);
      expect(await databaseExists(url, alsoLeaked)).toBe(false);
    }, 60_000);

    it("leaves a concurrent run's databases alone — the 2026-08-24 incident in test form", async () => {
      // This is the assertion that matters most. Sweeping by the
      // `agent_standup_test_` prefix instead of by token would pass every other
      // test in this file and destroy another agent's in-flight database.
      await dropScratchDatabasesForToken(url, token);

      expect(await databaseExists(url, otherRun)).toBe(true);
    }, 60_000);

    it("reports nothing on a clean run, so a leak is distinguishable from none", async () => {
      const dropped = await dropScratchDatabasesForToken(url, randomBytes(3).toString("hex"));

      expect(dropped).toEqual([]);
    }, 60_000);
  });
});
