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

/** Drops (if present) and recreates `name` on the same server as `databaseUrl`, returning its URL. */
export function createScratchDatabase(databaseUrl: string, name: string): string {
  const admin = adminUrl(databaseUrl);
  run(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
  run(admin, `CREATE DATABASE "${name}";`);
  return withDatabaseName(databaseUrl, name);
}

export function dropScratchDatabase(databaseUrl: string, name: string): void {
  run(adminUrl(databaseUrl), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
}
