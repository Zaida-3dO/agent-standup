#!/usr/bin/env node
// The whole `standup init` sequence (docs/plans/MILESTONES.md #80): find,
// accept or provision a database; create it; migrate; seed; prove it with a
// live round trip. `src/lib/cli/init.ts` is the adapter — it resolves *which*
// of the three sources applies (`src/lib/cli/init/resolve.ts`, pure, no I/O)
// and writes the local configuration file; this module does the actual work
// for whichever source was chosen, and is the only place in the sequence
// that touches a database.
//
// Three sources, three different relationships to the "provisioning
// connection is separate from the application role" rule (SCHEMA.md §20):
//
//   - `accept`  — the caller supplied a connection string directly (a flag,
//     `DATABASE_URL`, or a previous `init`'s local config). There is no
//     provisioning step and no role to separate: whatever role that string
//     names is trusted as-is, migrated and seeded through directly. This is
//     also the fallback path MILESTONES.md #80 names explicitly — "falls
//     back to a supplied connection string rather than abandoning" — for
//     when a `provision`/`auto` attempt can't complete.
//   - `provision` — the caller supplied a provisioning connection
//     (`--provision-url`). `provision-db.mjs` creates a fresh application
//     role, distinct from whatever role `provisionUrl` authenticates as, and
//     the connection this sequence hands back to be written into local
//     configuration is the *application* role's, never the provisioning one.
//   - `auto` — neither was supplied. Tries `container-provision.mjs` (the
//     dev compose service) to obtain a provisioning connection, then
//     proceeds exactly like `provision`.
import { runMigrations } from "./run-migrations.mjs";
import { verifyRoundTrip } from "./verify-round-trip.mjs";
import { provisionAppDatabase } from "./provision-db.mjs";
import { attemptContainerProvision } from "./container-provision.mjs";
import { spawn } from "node:child_process";

/**
 * @typedef {{ info: (message: string) => void, warn: (message: string) => void, error: (message: string, err?: unknown) => void }} Logger
 */

/** Runs `node prisma/seed.mjs` against `databaseUrl` as a real subprocess — the same script `npm run db:seed` runs. */
function runSeed({ databaseUrl, cwd, env, log }) {
  return new Promise((resolve) => {
    log.info("Seeding reference data...");
    const child = spawn("node", ["prisma/seed.mjs"], {
      cwd,
      env: { ...env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    });
    child.on("error", () => resolve({ ok: false }));
    child.on("exit", (code) => resolve({ ok: (code ?? 1) === 0 }));
  });
}

/** Host, port and database name only — never a credential — for the report `standup init` renders. */
export function describeDatabase(databaseUrl) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port || undefined,
    name: url.pathname.replace(/^\//, ""),
  };
}

/**
 * Runs the sequence for one resolved source (`src/lib/cli/init/resolve.ts`'s
 * output). Never throws for an ordinary provisioning/migration/seed/verify
 * failure — those come back as `{ ok: false, stage, message }` so
 * `src/lib/cli/init.ts` can turn them into an envelope without a raw driver
 * message ever reaching it (SCHEMA.md §20: the connection string, and by the
 * same logic anything that could embed it, is never printed by any
 * command).
 *
 * @param {{
 *   source:
 *     | { kind: "accept", databaseUrl: string }
 *     | { kind: "provision", provisionUrl: string, databaseName: string, appRole: string, appPassword?: string }
 *     | { kind: "auto", databaseName: string, appRole: string, appPassword?: string },
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   log?: Logger,
 * }} options
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       databaseUrl: string,
 *       source: "accepted" | "provisioned" | "provisioned-via-container",
 *       database: { host: string, port?: string, name: string },
 *       appRole?: string,
 *       steps: { migrated: boolean, seeded: boolean, verified: boolean },
 *     }
 *   | {
 *       ok: false,
 *       stage: "container" | "provision" | "migrate" | "seed" | "verify",
 *       message: string,
 *     }
 * >}
 */
export async function runInitSequence({
  source,
  cwd = process.cwd(),
  env = process.env,
  log = console,
}) {
  let appUrl;
  let migrateUrl;
  let resultSource;
  let appRole;

  if (source.kind === "accept") {
    appUrl = source.databaseUrl;
    migrateUrl = source.databaseUrl;
    resultSource = "accepted";
  } else {
    let provisionUrl = source.kind === "provision" ? source.provisionUrl : undefined;

    if (source.kind === "auto") {
      const attempt = await attemptContainerProvision({ cwd, log });
      if (!attempt.ok) {
        return {
          ok: false,
          stage: "container",
          message:
            "Could not find or provision a database automatically " +
            `(${attempt.reason}). Supply one with --database-url (a connection string to use ` +
            "directly) or --provision-url (an admin connection to provision a fresh database " +
            "and role from), then run `standup init` again.",
        };
      }
      provisionUrl = attempt.provisionUrl;
    }

    try {
      const provisioned = provisionAppDatabase({
        provisionUrl,
        databaseName: source.databaseName,
        appRole: source.appRole,
        appPassword: source.appPassword,
        log,
      });
      appUrl = provisioned.appUrl;
      migrateUrl = provisioned.migrateUrl;
    } catch (cause) {
      log.error("Provisioning the database and application role failed.", cause);
      return {
        ok: false,
        stage: "provision",
        message: "Could not provision the database and application role (see the output above).",
      };
    }
    resultSource = source.kind === "auto" ? "provisioned-via-container" : "provisioned";
    appRole = source.appRole;
  }

  const migration = await runMigrations({ env: { ...env, DATABASE_URL: migrateUrl }, cwd, log });
  if (!migration.ok) {
    return { ok: false, stage: "migrate", message: "Migrations did not apply cleanly." };
  }

  const seeded = await runSeed({ databaseUrl: appUrl, cwd, env, log });
  if (!seeded.ok) {
    return { ok: false, stage: "seed", message: "Seeding reference data failed." };
  }

  try {
    await verifyRoundTrip({ databaseUrl: appUrl, log });
  } catch {
    return {
      ok: false,
      stage: "verify",
      message: "Migrated and seeded, but the live round trip (write, then read it back) failed.",
    };
  }

  return {
    ok: true,
    databaseUrl: appUrl,
    source: resultSource,
    database: describeDatabase(appUrl),
    ...(appRole === undefined ? {} : { appRole }),
    steps: { migrated: true, seeded: true, verified: true },
  };
}
