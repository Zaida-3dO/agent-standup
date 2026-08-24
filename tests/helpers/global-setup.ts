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
import { buildCli } from "../../scripts/build-cli.mjs";
import { assertPrismaClientReady } from "../../scripts/lib/prisma-client-state.mjs";
import { runMigrations } from "../../scripts/lib/run-migrations.mjs";
import { RUN_TOKEN_ENV_VAR, dropScratchDatabasesForToken, withDatabaseName } from "./scratch-db";

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
  // Before anything else, because the alternative is six suites failing in
  // ways that read as defects in the code rather than as a missing build
  // step. See the module's own header for what the failures look like.
  assertPrismaClientReady();

  // Builds `dist/` exactly once for the whole run, and it has to happen ABOVE
  // the database guard below: the files that exercise the built artefacts
  // (`tests/cli-package-publish.test.ts`, `tests/hook-built-script.test.ts`)
  // need it whether or not a database is configured, and a run without
  // TEST_DATABASE_URL returns early a few lines down.
  //
  // Building here rather than in each file's `beforeAll` is a correctness
  // requirement, not a saved second. `buildCli` opens by deleting `dist/`
  // wholesale, and vitest runs those two files in separate parallel workers
  // against one shared repository root — so two concurrent builds interleave
  // a delete with the other's writes. With code splitting the entry point and
  // its chunks are separate files, giving a window where the entry exists and
  // the chunk it imports does not, and a test that spawns the built binary in
  // that window fails with a module-resolution error. Running it once, before
  // any worker starts, leaves a single writer.
  await buildCli();

  const databaseUrl = process.env.TEST_DATABASE_URL;
  // Same contract as the test files themselves: without a real database the
  // DB-backed suites skip, so there is nothing to build a template for.
  if (!databaseUrl) return async () => {};

  // Named with a per-run random token for the same reason scratch databases
  // are: two environments pointed at one Postgres server (a developer's
  // machine and CI, or two CI runs) must not collide on the name.
  const templateName = `agent_standup_test_template_${randomBytes(3).toString("hex")}`;
  const admin = adminUrl(databaseUrl);

  // One token identifying THIS run, published before any worker starts so all
  // of them inherit it and name their scratch databases with it. It is what
  // lets the teardown below reclaim the databases of workers that died before
  // reaching their own `afterAll` — see `scratch-db.ts` for the full reasoning.
  const runToken = randomBytes(3).toString("hex");
  process.env[RUN_TOKEN_ENV_VAR] = runToken;

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

    // Reclaim any scratch database this run created that its own file never
    // dropped. On a clean run every file drops its own in `afterAll` and this
    // finds nothing; it earns its keep when a worker is killed by Ctrl-C, an
    // OOM or a hard timeout, which skips `afterAll` entirely and used to leak
    // the database permanently.
    //
    // Scoped to this run's token, so a suite running concurrently against the
    // same server keeps its own databases.
    //
    // Deliberately not fatal: this is cleanup after the results are already
    // decided, and failing the run over it would turn a green suite red for a
    // stray database. It reports instead, so a leak is visible rather than
    // silent.
    try {
      const leaked = await dropScratchDatabasesForToken(databaseUrl, runToken);
      if (leaked.length > 0) {
        console.warn(
          `[global-teardown] reclaimed ${leaked.length} scratch database(s) whose test file did not drop them: ${leaked.join(", ")}`,
        );
      }
    } catch (cause) {
      console.warn(`[global-teardown] could not sweep scratch databases: ${String(cause)}`);
    }
  };
}
