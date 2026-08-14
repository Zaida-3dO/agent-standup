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
import { Client } from "pg";
import { runMigrations } from "../../scripts/lib/run-migrations.mjs";
import { withDatabaseName } from "./scratch-db";

function adminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

/** Runs `statements` in order on one connection to `url`, then closes it. */
async function execSql(url: string, ...statements: string[]): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const sql of statements) {
      await client.query(sql);
    }
  } finally {
    await client.end();
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

  // Both on one connection: a direct `pg` connection carries no transaction
  // wrapper, which DROP/CREATE DATABASE could not run inside.
  await execSql(
    admin,
    `DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE);`,
    `CREATE DATABASE "${templateName}";`,
  );

  const templateUrl = withDatabaseName(databaseUrl, templateName);
  const applied = await runMigrations({ env: { ...process.env, DATABASE_URL: templateUrl } });
  if (!applied.ok) {
    await execSql(admin, `DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE);`);
    throw new Error(`migrate deploy failed against the test template database ${templateName}`);
  }

  // How the worker processes find it — they cannot recompute the random token,
  // being separate processes from this one.
  process.env.TEST_TEMPLATE_DATABASE = templateName;

  // `runMigrations` shells out and leaves no connection of its own behind, and
  // nothing here opens a client, so no session is holding the template open —
  // which `CREATE DATABASE ... TEMPLATE` requires of its source.

  return async () => {
    await execSql(admin, `DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE);`);
  };
}
