// `runInitSequence` end to end, against real Postgres, nothing mocked —
// the actual proof behind MILESTONES.md #80's "prove it with a live round
// trip". `tests/run-init-sequence.test.ts` proves the routing with fakes in
// milliseconds; `tests/provision-db.test.ts` proves the provisioning SQL's
// privileges are real; this is the one place all of it runs together for
// real: provision a role, migrate as the provisioning connection, seed and
// verify as the application role, exactly as `standup init` would.
//
// Skips without TEST_DATABASE_URL (see tests/service-transaction-db.test.ts
// for the same pattern). Drops its scratch database and role in `afterEach`
// — see tests/provision-db.test.ts's header for why the role also has to go.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { withDatabaseName } from "../scripts/lib/provision-db.mjs";
import { runInitSequence } from "../scripts/lib/run-init.mjs";
import { scratchDatabaseName } from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;
const isWindows = process.platform === "win32";

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function dropRole(provisionUrl: string, role: string) {
  spawnSync(
    isWindows ? "npx.cmd" : "npx",
    ["prisma", "db", "execute", "--url", provisionUrl, "--stdin"],
    {
      input: `DROP ROLE IF EXISTS "${role}";`,
      encoding: "utf-8",
      shell: isWindows,
    },
  );
}

function dropDatabase(provisionUrl: string, name: string) {
  const adminUrl = withDatabaseName(provisionUrl, "postgres");
  spawnSync(
    isWindows ? "npx.cmd" : "npx",
    ["prisma", "db", "execute", "--url", adminUrl, "--stdin"],
    {
      input: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`,
      encoding: "utf-8",
      shell: isWindows,
    },
  );
}

describeIfDb("runInitSequence end to end against real Postgres", () => {
  const dbName = scratchDatabaseName("run_init_db");
  const roleName = scratchDatabaseName("run_init_role");

  afterEach(() => {
    dropDatabase(testDatabaseUrl!, dbName);
    dropRole(testDatabaseUrl!, roleName);
  });

  it("provisions, migrates, seeds and proves a live round trip — all real", async () => {
    const result = await runInitSequence({
      source: {
        kind: "provision",
        provisionUrl: testDatabaseUrl!,
        databaseName: dbName,
        appRole: roleName,
      },
      log: silentLog(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unreachable: ${result.stage} — ${result.message}`);
    expect(result.source).toBe("provisioned");
    expect(result.appRole).toBe(roleName);
    expect(result.steps).toEqual({ migrated: true, seeded: true, verified: true });
    // The application role's connection, never the provisioning one.
    expect(result.databaseUrl).toContain(roleName);
    expect(new URL(result.databaseUrl).username).toBe(roleName);
  }, 120_000);
});
