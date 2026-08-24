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

/**
 * The prefix every scratch database name carries. Shared by the sweeper in
 * `scripts/sweep-scratch-databases.mjs`, which must match the same shape.
 */
const SCRATCH_PREFIX = "agent_standup_test_";

/**
 * Environment variable carrying the token that identifies ONE test run.
 *
 * Set by `tests/helpers/global-setup.ts` before any worker starts, and
 * inherited by every worker process from there.
 */
export const RUN_TOKEN_ENV_VAR = "TEST_RUN_TOKEN";

/**
 * One random token per test RUN, appended to every scratch database name in
 * that run. Named for what's being tested, never for who or what ran it (this
 * repo is public — see CLAUDE.md's "Private project names"). The token lets
 * two environments hitting the same Postgres server at once — a developer's
 * machine and CI, or two CI runs — share it without colliding on a name.
 *
 * Read from the environment rather than generated per process, and that
 * distinction is what makes cleanup possible. Vitest runs each test file in
 * its own worker process, so a module-level `randomBytes` gives every FILE a
 * different token, and the run as a whole has no shared identity: nothing can
 * afterwards say which databases belonged to it. Since teardown is per-file
 * `afterAll`, any worker killed before it gets there — Ctrl-C, OOM, a hard
 * timeout, a crash — leaks its database with nothing able to reclaim it. That
 * is how ~670 of them accumulated by 2026-08-24.
 *
 * With one token for the whole run, `global-teardown.ts` can sweep exactly
 * the databases this run created and nothing else, whatever happened to the
 * individual workers.
 *
 * Falls back to a locally-generated token when unset, so a single test file
 * run directly (no global setup) still works — it just cannot be swept by
 * token afterwards, which is why the standalone sweeper also has an age-based
 * guard.
 */
const runToken = process.env[RUN_TOKEN_ENV_VAR] ?? randomBytes(3).toString("hex");

/** Builds a scratch-database name: `agent_standup_test_<purpose>_<random>`. */
export function scratchDatabaseName(purpose: string): string {
  return `${SCRATCH_PREFIX}${purpose}_${runToken}`;
}

/**
 * Drops every scratch database belonging to `token`, regardless of which
 * worker created it or whether that worker ever reached its `afterAll`.
 *
 * Scoped to the token on purpose: it is the one thing that distinguishes this
 * run's databases from a concurrently-running suite's. A broader match — the
 * `agent_standup_test_` prefix alone — would sweep another run's databases out
 * from under it, which is exactly the mistake that destroyed two databases on
 * 2026-08-24.
 *
 * Returns the names it dropped, so the caller can report a leak rather than
 * hiding it: on a clean run every file drops its own database and this finds
 * nothing.
 */
export async function dropScratchDatabasesForToken(
  databaseUrl: string,
  token: string,
): Promise<string[]> {
  const client = new Client({ connectionString: adminUrl(databaseUrl) });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      `select datname from pg_database
        where datname like $1 and datname like $2
        order by datname`,
      [`${SCRATCH_PREFIX}%`, `%\\_${token}`],
    );
    const dropped: string[] = [];
    for (const { datname } of rows) {
      // FORCE is right here (unlike in the standalone sweeper): these are this
      // run's OWN databases, and a worker that died may have left a connection
      // behind that nothing else will ever close.
      await client.query(`DROP DATABASE IF EXISTS ${JSON.stringify(datname)} WITH (FORCE)`);
      dropped.push(datname);
    }
    return dropped;
  } finally {
    await client.end();
  }
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
 * setup and the test workers are separate processes, and the template's name
 * uses a token of its own that a worker has no way to reproduce.
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
