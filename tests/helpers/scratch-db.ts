// Creates and drops disposable, uniquely-named Postgres databases on the
// same server as TEST_DATABASE_URL, so the DB-integration tests never touch
// the shared dev/CI `standup` database (and never collide with each other,
// even running in parallel across test files).
//
// Statements go over a direct `pg` connection rather than through
// `prisma db execute`. The SQL is trivial either way; what differs is that the
// CLI route pays an `npx` + Prisma-CLI cold start per call, which measures
// ~1.5s against ~90ms for a connection — and with a database created and
// dropped per test file, that startup is most of what the DB-backed suites
// spend their time on. A direct connection also carries no transaction
// wrapper, so DROP/CREATE DATABASE (which Postgres refuses to run inside one)
// can share a single connection.
import { randomBytes } from "node:crypto";
import { Client } from "pg";

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

/**
 * Runs `statements` in order on one connection to `url`, then closes it.
 *
 * Sequential on purpose: the callers' statements depend on each other (drop
 * before create), and sharing the connection is what keeps this to a single
 * round of connection setup.
 */
async function run(url: string, ...statements: string[]): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const sql of statements) {
      await client.query(sql);
    }
  } catch (cause) {
    throw new Error(`SQL failed against ${new URL(url).pathname.slice(1)}: ${String(cause)}`, {
      cause,
    });
  } finally {
    await client.end();
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
export async function createScratchDatabase(databaseUrl: string, name: string): Promise<string> {
  await run(
    adminUrl(databaseUrl),
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`,
    `CREATE DATABASE "${name}";`,
  );
  return withDatabaseName(databaseUrl, name);
}

/**
 * Like `createScratchDatabase`, but clones the already-migrated template
 * database instead of returning an empty one — so the caller does NOT need to
 * run `prisma migrate deploy` afterwards.
 *
 * This is the fast path: Postgres populates the new database by copying the
 * template's files rather than re-executing any migration DDL.
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
export async function createMigratedScratchDatabase(
  databaseUrl: string,
  name: string,
): Promise<{ url: string; migrated: boolean }> {
  const template = process.env[TEMPLATE_ENV_VAR];
  if (!template) {
    return { url: await createScratchDatabase(databaseUrl, name), migrated: false };
  }

  // `CREATE DATABASE ... TEMPLATE` refuses to run while any other session is
  // connected to the template, so the global setup disconnects before workers
  // start. Nothing reconnects to it for the rest of the run.
  await run(
    adminUrl(databaseUrl),
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`,
    `CREATE DATABASE "${name}" TEMPLATE "${template}";`,
  );
  return { url: withDatabaseName(databaseUrl, name), migrated: true };
}

export async function dropScratchDatabase(databaseUrl: string, name: string): Promise<void> {
  await run(adminUrl(databaseUrl), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
}
