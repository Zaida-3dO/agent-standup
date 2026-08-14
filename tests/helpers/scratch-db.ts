// Creates and drops disposable, uniquely-named Postgres databases on the
// same server as TEST_DATABASE_URL, so the DB-integration tests never touch
// the shared dev/CI `standup` database (and never collide with each other,
// even running in parallel across test files). Same `prisma db execute`
// pattern scripts/check-migration-drift.mjs already uses for its shadow
// database.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";

// One random token per test-file evaluation, appended to every scratch
// database name in that file. Named for what's being tested, never for who
// or what ran it (this repo is public — see CLAUDE.md's "Private project
// names"). The token lets two environments hitting the same Postgres server
// at once — a developer's machine and CI, or two CI runs — share it without
// colliding on a database name.
const runToken = randomBytes(3).toString("hex");

/** Builds a scratch-database name: `agent_standup_test_<purpose>_<random>`. */
export function scratchDatabaseName(purpose: string): string {
  return `agent_standup_test_${purpose}_${runToken}`;
}

function run(url: string, sql: string): void {
  const result = spawnSync(
    isWindows ? "npx.cmd" : "npx",
    ["prisma", "db", "execute", "--url", url, "--stdin"],
    {
      input: sql,
      encoding: "utf-8",
      shell: isWindows,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `prisma db execute failed for ${JSON.stringify(sql)}:\n${result.stderr || result.stdout}`,
    );
  }
}

function adminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function withDatabaseName(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Name of the pre-migrated template database, created once per test run by
 * `tests/helpers/global-setup.ts` and cloned by `createMigratedScratchDatabase`
 * below. Read from the environment rather than recomputed here: the global
 * setup and the test workers are separate processes, so they cannot share a
 * module-level random token (the `runToken` above is per-process, and would
 * differ between them).
 */
const TEMPLATE_ENV_VAR = "TEST_TEMPLATE_DATABASE";

/** Drops (if present) and recreates `name` on the same server as `databaseUrl`, returning its URL. */
export function createScratchDatabase(databaseUrl: string, name: string): string {
  const admin = adminUrl(databaseUrl);
  // One statement per invocation, deliberately. `prisma db execute` wraps
  // multi-statement input in a transaction, and neither DROP DATABASE nor
  // CREATE DATABASE may run inside one ("cannot run inside a transaction
  // block") — so batching them to save a process spawn does not work.
  run(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
  run(admin, `CREATE DATABASE "${name}";`);
  return withDatabaseName(databaseUrl, name);
}

/**
 * Like `createScratchDatabase`, but clones the already-migrated template
 * database instead of returning an empty one — so the caller does NOT need to
 * run `prisma migrate deploy` afterwards.
 *
 * This is the fast path, and it is what keeps the DB-backed suites' setup cost
 * off the critical path. Preparing a database per test file costs one `npx` +
 * Prisma-CLI cold start per subprocess spawned (~2-3s each, dwarfing the SQL),
 * so this keeps that count at one: Postgres populates the new database by
 * copying the template's files rather than re-executing any migration DDL.
 *
 * Isolation is unchanged: every caller still gets its own uniquely-named,
 * disposable database, so files still run in parallel without colliding. The
 * template is only ever read from, never written to.
 *
 * Falls back to a migrate-yourself empty database when no template exists
 * (`TEST_TEMPLATE_DATABASE` unset) — e.g. a single test file run directly
 * without vitest's global setup. Callers can detect this via the returned
 * `migrated` flag.
 */
export function createMigratedScratchDatabase(
  databaseUrl: string,
  name: string,
): { url: string; migrated: boolean } {
  const template = process.env[TEMPLATE_ENV_VAR];
  if (!template) {
    return { url: createScratchDatabase(databaseUrl, name), migrated: false };
  }

  // Separate invocations: `prisma db execute` wraps multi-statement input in a
  // transaction, which neither statement may run inside.
  //
  // `CREATE DATABASE ... TEMPLATE` also refuses to run while any other session
  // is connected to the template, so the global setup disconnects before
  // workers start. Nothing reconnects to it for the rest of the run.
  const admin = adminUrl(databaseUrl);
  run(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
  run(admin, `CREATE DATABASE "${name}" TEMPLATE "${template}";`);
  return { url: withDatabaseName(databaseUrl, name), migrated: true };
}

export function dropScratchDatabase(databaseUrl: string, name: string): void {
  run(adminUrl(databaseUrl), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
}
