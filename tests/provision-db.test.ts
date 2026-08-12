// `provision-db.mjs` against a real Postgres — the half of MILESTONES.md
// #80 a mock cannot prove: that the application role Postgres itself ends
// up with is genuinely lesser-privileged, not merely a different name on
// the same rights. `tests/run-init-sequence.test.ts` proves the *wiring*
// (which URL reaches which step); this proves the *privileges* the wiring
// depends on being real.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here
// (see tests/service-transaction-db.test.ts). `TEST_DATABASE_URL`'s own
// role (`standup`, from docker-compose.yml / CI's Postgres service) is a
// database superuser by construction — the same "admin-ish" position any
// real `--provision-url` would be expected to hold.
//
// **Database-hygiene note for whoever reviews this**: every scratch
// database AND every scratch role this file creates is dropped in
// `afterAll`, unconditionally (`finally`-equivalent — dropping runs even
// when an assertion above it failed) — a role is cluster-wide, so leaving
// one behind would accumulate across every CI run, not just this file's own
// database.
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureAppRole,
  provisionAppDatabase,
  withDatabaseName,
} from "../scripts/lib/provision-db.mjs";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
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

describeIfDb("provisionAppDatabase against real Postgres", () => {
  const dbName = scratchDatabaseName("provision_db");
  const roleName = scratchDatabaseName("provision_role");
  let appUrl: string;
  let migrateUrl: string;

  beforeAll(async () => {
    const provisioned = provisionAppDatabase({
      provisionUrl: testDatabaseUrl!,
      databaseName: dbName,
      appRole: roleName,
      log: silentLog(),
    });
    appUrl = provisioned.appUrl;
    migrateUrl = provisioned.migrateUrl;

    const migration = await runMigrations({ env: { ...process.env, DATABASE_URL: migrateUrl } });
    if (!migration.ok) throw new Error(`migrate deploy failed against ${migrateUrl}`);
  }, 60_000);

  afterAll(() => {
    dropDatabase(testDatabaseUrl!, dbName);
    dropRole(testDatabaseUrl!, roleName);
  });

  it("the application role's connection string differs from the provisioning connection", () => {
    expect(appUrl).not.toBe(testDatabaseUrl);
    expect(appUrl).not.toContain(new URL(testDatabaseUrl!).username);
  });

  it("the application role can read and write a migrated table", async () => {
    const prisma = new PrismaClient({ datasourceUrl: appUrl });
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $2)`,
        "provision-test-area",
        "Provision Test Area",
      );
      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Area" WHERE "id" = $1`,
        "provision-test-area",
      );
      expect(rows).toHaveLength(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("the application role CANNOT create a table — it has no DDL rights (the least-privilege proof)", async () => {
    const prisma = new PrismaClient({ datasourceUrl: appUrl });
    try {
      await expect(
        prisma.$executeRawUnsafe(`CREATE TABLE "should_not_be_allowed" ("id" text)`),
      ).rejects.toThrow();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("re-provisioning with a new password converges the role, and the previous password stops authenticating", async () => {
    // Mirrors the exact scenario `ensureAppRole`'s own doc comment names:
    // the local config file was lost and `init --provision-url` runs again.
    const oldAppUrl = appUrl;
    ensureAppRole(testDatabaseUrl!, roleName, "a-different-password-123", silentLog());

    await expect(
      new PrismaClient({ datasourceUrl: oldAppUrl }).$queryRaw`SELECT 1`,
    ).rejects.toThrow();

    const newUrl = new URL(migrateUrl);
    newUrl.username = roleName;
    newUrl.password = "a-different-password-123";
    const prisma = new PrismaClient({ datasourceUrl: newUrl.toString() });
    try {
      const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});
