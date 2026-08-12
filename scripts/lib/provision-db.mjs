#!/usr/bin/env node
// Provisions a database and a separate, lesser-privileged application role
// for `standup init` (docs/plans/MILESTONES.md #80).
//
// **The provisioning connection and the application connection are never the
// same value.** The caller hands this module an admin-ish "provisioning"
// connection string (able to create a database and a role); this module
// creates a dedicated application role, migrates the schema as the
// provisioning role (so the provisioning role owns what it creates), grants
// the application role only DML on it, and hands back a *different*
// connection string built from the application role's own credentials. The
// provisioning connection is never returned, logged or written anywhere —
// only its host and port, which are not secrets, ever leave this module.
//
// Same subprocess pattern as scripts/lib/run-migrations.mjs and
// tests/helpers/scratch-db.ts: `prisma db execute` as a real child process,
// never a `PrismaClient` constructed in this file. That is not a style
// choice — `src/lib/cli/init.ts` (the only caller) sits outside the
// database-import allowlist (CLAUDE.md, "Working in this repo"), so nothing
// it depends on may construct a client either.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const isWindows = process.platform === "win32";

/**
 * @typedef {{ info: (message: string) => void, warn: (message: string) => void, error: (message: string, err?: unknown) => void }} Logger
 */

/** A bare SQL identifier — letters, digits, underscore, not leading with a digit. Nothing else is trusted unquoted. */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class InvalidIdentifierError extends Error {
  constructor(kind, value) {
    super(
      `${kind} ${JSON.stringify(value)} is not a safe identifier — only letters, digits and ` +
        "underscore, not starting with a digit, are accepted.",
    );
    this.name = "InvalidIdentifierError";
  }
}

/** Refuses anything that is not a bare SQL identifier before it is interpolated into DDL. */
export function assertSafeIdentifier(kind, value) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new InvalidIdentifierError(kind, value);
  }
  return value;
}

/** Escapes a value for use inside a single-quoted SQL string literal. */
export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Generates an application-role password with no characters a connection-string URL needs escaped. */
export function generatePassword() {
  return randomBytes(24).toString("hex");
}

/** Returns `url` pointed at a different database name on the same server. */
export function withDatabaseName(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/** Builds the application role's own connection string — never the provisioning one. */
export function buildAppUrl(provisionUrl, { databaseName, appRole, appPassword }) {
  const parsed = new URL(provisionUrl);
  parsed.username = encodeURIComponent(appRole);
  parsed.password = encodeURIComponent(appPassword);
  parsed.pathname = `/${databaseName}`;
  parsed.search = "";
  return parsed.toString();
}

/**
 * Runs one SQL statement via `prisma db execute --stdin`, exactly the
 * pattern tests/helpers/scratch-db.ts already uses for its own admin
 * operations.
 *
 * @param {string} url
 * @param {string} sql
 * @returns {{ ok: true } | { ok: false, alreadyExists: boolean }}
 */
function execute(url, sql) {
  const result = spawnSync(
    isWindows ? "npx.cmd" : "npx",
    ["prisma", "db", "execute", "--url", url, "--stdin"],
    { input: sql, encoding: "utf-8", shell: isWindows },
  );
  if (result.status === 0) return { ok: true };

  const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  // Postgres error 42P04 ("database already exists") / 42710 ("role already
  // exists") — Prisma's own CLI surfaces the driver's message text rather
  // than a stable machine code, so this matches on the wording Postgres
  // itself uses. `CREATE DATABASE` cannot be made idempotent with `IF NOT
  // EXISTS` (Postgres has no such clause for it, unlike `CREATE ROLE`, which
  // this module makes idempotent with a `DO` block instead — see
  // `ensureAppRole`), so tolerating this specific failure is how "create it"
  // stays safe to call against a database that is already there.
  const alreadyExists = /already exists/i.test(output);
  return { ok: false, alreadyExists, output };
}

/**
 * Ensures `databaseName` exists on the server `provisionUrl` points at.
 * Never drops anything — an already-existing database (this app's own, from
 * a prior `init`, or one an operator created by hand) is left exactly as it
 * is. Connects to the server's own `postgres` maintenance database to issue
 * `CREATE DATABASE`, because Postgres refuses to create a database while
 * connected to the one being created.
 *
 * @param {string} provisionUrl
 * @param {string} databaseName
 * @param {Logger} [log]
 */
export function ensureDatabase(provisionUrl, databaseName, log = console) {
  assertSafeIdentifier("database name", databaseName);
  const adminUrl = withDatabaseName(provisionUrl, "postgres");
  const result = execute(adminUrl, `CREATE DATABASE "${databaseName}";`);
  if (result.ok) {
    log.info(`Created database "${databaseName}".`);
    return;
  }
  if (result.alreadyExists) {
    log.info(`Database "${databaseName}" already exists; leaving it as it is.`);
    return;
  }
  throw new Error(`Could not create database "${databaseName}" (see prisma's own output above).`);
}

/**
 * Ensures the application role exists **and its password matches
 * `appPassword`** — a single idempotent statement rather than "create once,
 * then never touch again", because the local configuration file this
 * password is about to be written into must always describe the role's
 * *real* current password. Re-running `standup init` with `--provision-url`
 * a second time (the local config was lost, say) converges the role to the
 * newly generated password rather than writing a config that can never
 * authenticate.
 *
 * Runs against the server's `postgres` maintenance database — roles are
 * cluster-wide, not per-database, so which database the statement runs
 * against doesn't matter beyond "one that's reachable".
 *
 * @param {string} provisionUrl
 * @param {string} appRole
 * @param {string} appPassword
 * @param {Logger} [log]
 */
export function ensureAppRole(provisionUrl, appRole, appPassword, log = console) {
  assertSafeIdentifier("application role", appRole);
  const adminUrl = withDatabaseName(provisionUrl, "postgres");
  const sql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${quoteLiteral(appRole)}) THEN
    CREATE ROLE "${appRole}" WITH LOGIN PASSWORD ${quoteLiteral(appPassword)};
  ELSE
    ALTER ROLE "${appRole}" WITH LOGIN PASSWORD ${quoteLiteral(appPassword)};
  END IF;
END
$$;`;
  const result = execute(adminUrl, sql);
  if (!result.ok) {
    throw new Error(
      `Could not create or update role "${appRole}" (see prisma's own output above).`,
    );
  }
  log.info(`Application role "${appRole}" is ready.`);
}

/**
 * Grants the application role exactly what it needs to run the app and
 * nothing else: connect, use the schema, read/write existing tables and
 * sequences, and the same on anything a later migration creates. No DDL
 * privilege of any kind — creating tables stays the provisioning role's job,
 * via `prisma migrate deploy` run against the provisioning connection.
 *
 * Must run *before* `prisma migrate deploy` for the `ALTER DEFAULT
 * PRIVILEGES` half to cover tables the migration is about to create — it
 * only affects objects created afterwards by the same role that ran it. The
 * explicit `GRANT … ON ALL TABLES` half is belt-and-braces for anything that
 * already existed (e.g. a previous partial run).
 *
 * @param {string} provisionUrl
 * @param {string} databaseName
 * @param {string} appRole
 * @param {Logger} [log]
 */
export function grantAppRole(provisionUrl, databaseName, appRole, log = console) {
  assertSafeIdentifier("database name", databaseName);
  assertSafeIdentifier("application role", appRole);
  const targetUrl = withDatabaseName(provisionUrl, databaseName);

  const statements = [
    `GRANT CONNECT ON DATABASE "${databaseName}" TO "${appRole}";`,
    `GRANT USAGE ON SCHEMA public TO "${appRole}";`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appRole}";`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRole}";`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appRole}";`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${appRole}";`,
  ];

  for (const sql of statements) {
    const result = execute(targetUrl, sql);
    if (!result.ok) {
      throw new Error(
        `Could not grant privileges to role "${appRole}" (see prisma's own output above).`,
      );
    }
  }
  log.info(`Granted "${appRole}" read/write on "${databaseName}".`);
}

/**
 * The whole provisioning sequence: create the database, create-or-update the
 * application role, grant it, and hand back its own connection string. Does
 * **not** migrate or seed — those run against the returned application URL
 * (seed, the round-trip proof) or the provisioning URL (migrate, which needs
 * DDL rights the application role deliberately does not have); that
 * sequencing lives in `run-init.mjs`, which is what actually calls this.
 *
 * @param {{
 *   provisionUrl: string,
 *   databaseName: string,
 *   appRole: string,
 *   appPassword?: string,
 *   log?: Logger,
 * }} options
 * @returns {{ appUrl: string, migrateUrl: string, generatedPassword: boolean }}
 */
export function provisionAppDatabase({
  provisionUrl,
  databaseName,
  appRole,
  appPassword,
  log = console,
}) {
  const password = appPassword ?? generatePassword();
  ensureDatabase(provisionUrl, databaseName, log);
  ensureAppRole(provisionUrl, appRole, password, log);
  grantAppRole(provisionUrl, databaseName, appRole, log);
  return {
    appUrl: buildAppUrl(provisionUrl, { databaseName, appRole, appPassword: password }),
    migrateUrl: withDatabaseName(provisionUrl, databaseName),
    generatedPassword: appPassword === undefined,
  };
}
