// Migration-state comparison — is this package's own migration history
// current with what the database has applied. MILESTONES.md (item
// "MCP: transport-aware tool descriptions, describe_tool transport
// reporting, migration-drift warning"), DECISIONS.md §13f: "the command
// line *is* the app — hook, rules and migrations are one installed package —
// so the hook cannot be a different version from the rules it enforces, and
// the only remaining question is whether that package is current with the
// database's migration state."
//
// ── Why this is worth checking only in a no-server installation ─────────
//
// A hosted installation applies migrations centrally (`scripts/entrypoint.mjs`
// runs `prisma migrate deploy` once, against the one database the one image
// talks to) — every process serving traffic was built from the schema it
// migrated. A no-server installation (`standup mcp`, §13f) has no such
// choke point: each of ~N boxes resolves its own copy of the package
// independently (`npx`, plus npm's own caching), so two boxes against the
// *same* shared Postgres can genuinely be running different migration
// histories. §13f's own words: "the only remaining question is whether that
// package is current with the database's migration state" — this module is
// that question, answered as a pure comparison so it can be unit-tested
// without a database.
//
// ── Two different skews, two different responses ─────────────────────────
//
// **The database is ahead of this package** — someone else's newer install
// already applied a migration this package's own history does not contain.
// That is the case worth naming loudly: a stale CLI reading a newer schema
// fails at the point of use, as a Prisma column-not-found error that names
// nothing about *why*, which is exactly the failure DECISIONS.md's §16
// fail-open reasoning says a diagnostic should pre-empt rather than let
// happen silently.
//
// **This package is ahead of the database** — ordinary pending migrations,
// the ordinary state of a box that has not yet run `standup init` again
// after an upgrade. §13f's own calibration for the hook applies here by the
// same reasoning: "refusing everything on a version bump would make every
// fix a breaking change." This is advisory, not a refusal condition — see
// `driftSeverity` below.
import { readdirSync } from "node:fs";
import path from "node:path";

/** One migration this package's own history and/or the database's ledger names. */
export interface MigrationRecord {
  /** Prisma's own migration folder name, e.g. `20260913090000_intervention_score_confidence`. */
  readonly name: string;
}

/** What this package's own `prisma/migrations` directory contains, or that it could not be read. */
export type PackageMigrationHistory =
  | { readonly ok: true; readonly migrations: readonly MigrationRecord[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the migration folder names shipped next to this process, sorted the
 * same way Prisma applies them — lexically, which is also chronologically
 * for this repo's `YYYYMMDDHHMMSS_name` convention (`scripts/lib/run-migrations.mjs`'s
 * own `prisma migrate deploy` relies on the identical ordering).
 *
 * **Deliberately tolerant of a missing directory rather than throwing.** A
 * no-server install run via a globally-installed npm package may have no
 * `prisma/migrations` alongside it at all — this package's own `files` field
 * ships only `dist`, the same gap `standup init` already has by resolving
 * `prisma/schema.prisma` relative to `process.cwd()`
 * (`scripts/lib/run-init.mjs`). That is a packaging question this row does
 * not fix; what it must not do is turn "I could not check" into either a
 * false "you are incompatible" refusal or a silent, wrong "you are current."
 * `ok: false` is the honest third answer, and `driftSeverity` treats it as
 * advisory, never as grounds to refuse.
 */
export function readPackageMigrationHistory(
  migrationsDir: string,
  readdir: (
    dir: string,
    options: { withFileTypes: true },
  ) => { name: string; isDirectory(): boolean }[] = readdirSync,
): PackageMigrationHistory {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdir(migrationsDir, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason:
        `Could not read ${migrationsDir}: ${message}. This package may not ship its ` +
        "migration history alongside the running process — see this module's header.",
    };
  }

  const migrations = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "migration_lock.toml")
    .map((entry) => ({ name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, migrations };
}

/** The package root's conventional migrations directory, for a caller that has not overridden it. */
export function defaultMigrationsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, "prisma", "migrations");
}

/** One migration the database's own ledger recorded as finished (never rolled back). */
export interface AppliedMigration {
  readonly name: string;
}

export type DriftSeverity =
  /** Nothing to report — the two histories agree exactly, or could not be compared and neither is assumed. */
  | "none"
  /** The database is ahead: it has applied migrations this package's history does not contain. */
  | "database_ahead"
  /** This package is ahead: it ships migrations the database has not applied yet. Ordinary. */
  | "package_ahead"
  /**
   * Genuine incompatibility — the database's *oldest* applied migration is
   * not one this package recognises at all, meaning the two histories do
   * not share a common base. A package this far behind cannot safely
   * reason about the schema in front of it, which is the one case §13f's
   * calibration ("a stale hook is advisory; an incompatible one may not
   * claim") says is worth refusing over rather than merely warning about.
   */
  | "incompatible";

export interface MigrationDriftReport {
  readonly severity: DriftSeverity;
  /** One line naming both states and the remedy — what a startup warning prints verbatim. */
  readonly message: string;
  /** The newest migration this package ships, when its history could be read. */
  readonly packageNewest: string | null;
  /** The newest migration the database has applied, when any have. */
  readonly databaseNewest: string | null;
}

/**
 * Compares this package's own migration history to what the database has
 * applied. Pure — no filesystem, no database — so every branch is a unit
 * test rather than something only provable against a live Postgres.
 *
 * `packageHistory: { ok: false }` and `appliedMigrations: []` both produce
 * `severity: "none"`: an unreadable local history means this comparison
 * cannot be made at all, and an empty ledger means the database has nothing
 * yet to be ahead *of* this package with (a freshly provisioned database
 * mid-`standup init`, say) — neither is evidence of drift, and reporting
 * either as drift would be inventing a fact this function does not have.
 */
export function compareMigrationState(
  packageHistory: PackageMigrationHistory,
  appliedMigrations: readonly AppliedMigration[],
): MigrationDriftReport {
  if (!packageHistory.ok) {
    return {
      severity: "none",
      message: `Migration drift could not be checked: ${packageHistory.reason}`,
      packageNewest: null,
      databaseNewest: null,
    };
  }

  const packageNames = new Set(packageHistory.migrations.map((migration) => migration.name));
  const packageNewest = packageHistory.migrations.at(-1)?.name ?? null;

  if (appliedMigrations.length === 0) {
    return {
      severity: "none",
      message: "No migrations recorded as applied yet.",
      packageNewest,
      databaseNewest: null,
    };
  }

  const appliedSorted = [...appliedMigrations]
    .map((m) => m.name)
    .sort((a, b) => a.localeCompare(b));
  const databaseNewest = appliedSorted.at(-1) ?? null;
  const databaseOldest = appliedSorted[0] ?? null;

  // Genuine incompatibility: the database's oldest applied migration is not
  // one this package's own history contains at all, so the two histories
  // share no recognisable common base — this package cannot reason about
  // what schema it is actually looking at.
  if (databaseOldest !== null && !packageNames.has(databaseOldest)) {
    return {
      severity: "incompatible",
      message:
        `This package's migration history does not include ${databaseOldest}, the oldest ` +
        "migration the database has applied — the two histories share no common base. " +
        "Update the package (or reinstall from the release matching the database) before " +
        "continuing.",
      packageNewest,
      databaseNewest,
    };
  }

  const databaseAhead = appliedSorted.filter((name) => !packageNames.has(name));
  if (databaseAhead.length > 0) {
    const newestUnknown = databaseAhead.at(-1);
    return {
      severity: "database_ahead",
      message:
        `The database has applied ${databaseAhead.length} migration(s) this package does not ` +
        `recognise, including ${newestUnknown} — this package's migration history stops at ` +
        `${packageNewest ?? "(none)"}. Update the package before running further commands ` +
        "against this database; a stale package reading a newer schema fails at the point of " +
        "use rather than here.",
      packageNewest,
      databaseNewest,
    };
  }

  if (packageNewest !== null && packageNewest !== databaseNewest) {
    return {
      severity: "package_ahead",
      message:
        `This package ships migrations the database has not applied yet (newest: ` +
        `${packageNewest}, database is at ${databaseNewest ?? "(none)"}). Run \`standup init\` ` +
        "or `prisma migrate deploy` against this database to bring it current.",
      packageNewest,
      databaseNewest,
    };
  }

  return { severity: "none", message: "Migration state matches.", packageNewest, databaseNewest };
}
