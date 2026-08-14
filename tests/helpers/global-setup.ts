// Builds ONE migrated template database for the whole test run, which every
// DB-backed test file then clones (see `createMigratedScratchDatabase` in
// `./scratch-db.ts`).
//
// Why this exists: preparing a database per test file is dominated by process
// startup, not by the work itself. The SQL is trivial and the migrations are
// quick, but every `prisma` invocation is an `npx` + CLI cold start costing
// ~2-3s, and a file that creates and migrates its own database pays several.
// Multiplied across the ~50 DB-backed files that cost would scale with the
// number of FILES rather than the number of tests, so a file with 9 tests and a
// file with 30 would take the same several seconds before asserting anything.
//
// Paying it once here instead turns each file's setup into a single
// `CREATE DATABASE ... TEMPLATE`, which Postgres serves by copying the
// template's files rather than running any migration DDL.
//
// Isolation is deliberately unchanged: every file still gets its own
// uniquely-named disposable database, so files still run in parallel without
// colliding. A shared database with truncation between tests would have been
// faster still, but it would force the DB-backed files to run serially — and
// several of them (tests/events.test.ts most explicitly) assert on transaction
// semantics that a concurrent worker's TRUNCATE would corrupt.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runMigrations } from "../../scripts/lib/run-migrations.mjs";
import { withDatabaseName } from "./scratch-db";

const isWindows = process.platform === "win32";

function adminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function execSql(url: string, sql: string): void {
  const result = spawnSync(
    isWindows ? "npx.cmd" : "npx",
    ["prisma", "db", "execute", "--url", url, "--stdin"],
    { input: sql, encoding: "utf-8", shell: isWindows },
  );
  if (result.status !== 0) {
    throw new Error(
      `prisma db execute failed for ${JSON.stringify(sql)}:\n${result.stderr || result.stdout}`,
    );
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  // Same contract as the test files themselves: without a real database the
  // DB-backed suites skip, so there is nothing to build a template for.
  if (!databaseUrl) return async () => {};

  // Named with a per-run random token for the same reason scratch databases
  // are: two environments pointed at one Postgres server (a developer's
  // machine and CI, or two CI runs) must not collide on the name.
  const templateName = `agent_standup_test_template_${randomBytes(3).toString("hex")}`;
  const admin = adminUrl(databaseUrl);

  execSql(
    admin,
    `DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE); CREATE DATABASE "${templateName}";`,
  );

  const templateUrl = withDatabaseName(databaseUrl, templateName);
  const applied = await runMigrations({ env: { ...process.env, DATABASE_URL: templateUrl } });
  if (!applied.ok) {
    execSql(admin, `DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE);`);
    throw new Error(`migrate deploy failed against the test template database ${templateName}`);
  }

  // How the worker processes find it — they cannot recompute the random token,
  // being separate processes from this one.
  process.env.TEST_TEMPLATE_DATABASE = templateName;

  // `runMigrations` shells out and leaves no connection of its own behind, and
  // nothing here opens a client, so no session is holding the template open —
  // which `CREATE DATABASE ... TEMPLATE` requires of its source.

  return async () => {
    execSql(admin, `DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE);`);
  };
}
