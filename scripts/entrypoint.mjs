#!/usr/bin/env node
// Container boot sequence: wait for Postgres to accept queries, apply
// migrations, and only then start the app.
//
// Two separate, loud failure modes on purpose — a database that isn't up
// YET (see lib/wait-for-db.mjs) is a different problem from a database that
// IS up but the migration itself failed (see lib/run-migrations.mjs), and
// conflating them into one generic error would send an operator down the
// wrong path. Either one refuses to start the server: this process must
// never hand off to the app pointed at a half-migrated (or unmigrated)
// database.
//
// The server command defaults to `node server.js` (the Next standalone
// output) but can be overridden with args after `--`, so tests can hand it
// a stub process instead of needing a full production build.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_DB_WAIT_INTERVAL_SECONDS,
  DEFAULT_DB_WAIT_TIMEOUT_SECONDS,
  InvalidDurationEnvError,
  parseDurationSecondsMs,
} from "./lib/boot-env.mjs";
import { DatabaseUnreachableError, waitForDatabase } from "./lib/wait-for-db.mjs";
import { runMigrations } from "./lib/run-migrations.mjs";

function parseServerCommand(argv) {
  const sep = argv.indexOf("--");
  if (sep === -1) return ["node", "server.js"];
  const rest = argv.slice(sep + 1);
  return rest.length > 0 ? rest : ["node", "server.js"];
}

function defaultSpawnServer(command, args, { env, log }) {
  return new Promise((resolve) => {
    log.info(`Starting the application: ${[command, ...args].join(" ")}`);
    const child = spawn(command, args, { env, stdio: "inherit" });

    const forward = (signal) => () => child.kill(signal);
    const sigterm = forward("SIGTERM");
    const sigint = forward("SIGINT");
    process.on("SIGTERM", sigterm);
    process.on("SIGINT", sigint);

    child.on("error", (err) => {
      log.error("FATAL: failed to start the application process.", err);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGTERM", sigterm);
      process.off("SIGINT", sigint);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * Runs the full boot sequence. Returns the process exit code the caller
 * should use — 0 only if the server itself later exits cleanly.
 */
/**
 * The startup line warning that the backfill window is open, or `null` when
 * it is closed.
 *
 * **This is a second statement of the rule in `src/lib/backfill/enabled.ts`,
 * and that is deliberate but not free.** This file is plain JavaScript run
 * by Node before anything is built, so it cannot import the TypeScript
 * module; and the announcement has to happen here, at the moment the
 * container starts, or it is not a startup warning. What stops the two
 * copies drifting is a mechanism rather than a comment:
 * `tests/backfill-enabled.test.ts` runs both against the same table of
 * inputs — unset, empty, whitespace, `1`, `yes`, `false`, `TRUE`, `true` —
 * and fails if they ever disagree on any of them.
 *
 * Fail closed: only the exact string `true` opens it.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function backfillWarning(env) {
  if (env.ENABLE_BACKFILL !== "true") return null;
  return (
    "WARNING: backfill is ENABLED (ENABLE_BACKFILL=true). " +
    "The bulk-import surface is reachable and bypasses the state machine. " +
    "Unset ENABLE_BACKFILL and restart as soon as the import is finished."
  );
}

/**
 * The startup line naming which build is about to migrate the database.
 *
 * **Why this line exists, and why it is printed before the migration runs
 * rather than after.** A `docker compose pull` resolves a rolling tag to
 * whichever image it names, and this entrypoint then applies every
 * migration that image carries — so a pull migrates the database, and the
 * version doing the migrating cannot be known until after the image is
 * already running. When a migration then fails, or succeeds and changes
 * behaviour, the container log is the only surviving record of which build
 * touched the schema. Printing the identity *first* means a boot that dies
 * inside `prisma migrate deploy` still leaves behind the one fact needed to
 * interpret the wreckage.
 *
 * **Deliberately the same source of truth as `service_info`** —
 * `APP_VERSION` and `APP_REVISION`, baked into the image by the release
 * workflow from the tag and sha it is building. It is NOT read from
 * `package.json`, whose `version` field is a placeholder that sat at
 * `0.1.0` through twelve releases and is not what a release publishes (see
 * `scripts/version-from-tag.mjs`). A boot line sourced from `package.json`
 * would print a confident, wrong version on every deploy — worse than
 * printing nothing, because a plausible answer ends an investigation.
 *
 * This file is plain JavaScript run by Node before anything is built, so it
 * cannot import `src/lib/build-info.ts` — the same constraint, and the same
 * remedy, as `backfillWarning` above: `tests/build-version-plumbing.test.ts`
 * pins the two readings to the same variables and the same sentinels so
 * they cannot drift apart silently.
 *
 * An unreleased build says so, in the words `build-info.ts` uses, rather
 * than guessing: an honest "unknown" prompts a check, a false version ends
 * one.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function bootIdentity(env) {
  const version = presentOrNull(env.APP_VERSION);
  const revision = presentOrNull(env.APP_REVISION);

  // Both sentinels are the literal strings `src/lib/build-info.ts` exports
  // as DEV_VERSION and UNKNOWN_REVISION. Neither can be mistaken for a
  // release: `0.0.0-dev` is not bare semver, `unknown` is not sha-shaped.
  const shownVersion = version ?? "0.0.0-dev";
  const shownRevision = revision ?? "unknown";
  const identity = `Starting agent-standup ${shownVersion} (revision ${shownRevision}).`;

  // Whether the two values above can be trusted requires BOTH facts — the
  // same rule `readBuildInfo` applies for `released`. Saying so in words
  // costs one clause and removes the need to recognise a sentinel on sight.
  if (version === null || revision === null) {
    return (
      `${identity} This build carries no release identity, so the version above is a ` +
      "placeholder, not a released version — it was built outside the release workflow."
    );
  }
  return identity;
}

/**
 * The value if it holds something after trimming, otherwise null.
 *
 * Docker's `ARG`/`ENV` pairing makes an empty string, not an unset
 * variable, the normal shape of "nothing was passed" — the runner stage
 * declares `ARG APP_VERSION=""`. A `??` check alone would therefore report
 * an empty version as a real one, which is the precise bug this row exists
 * to prevent.
 *
 * @param {string | undefined} value
 * @returns {string | null}
 */
function presentOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function main({
  env = process.env,
  argv = process.argv.slice(2),
  log = console,
  spawnServer = defaultSpawnServer,
} = {}) {
  const databaseUrl = env.DATABASE_URL;

  // First line of the boot, before the database wait and before any
  // migration runs. A pull silently migrates, so the log has to say which
  // build did it — and it has to say so even if the migration then dies.
  log.info(bootIdentity(env));

  let timeoutMs;
  let intervalMs;
  try {
    timeoutMs = parseDurationSecondsMs(
      env,
      "DB_WAIT_TIMEOUT_SECONDS",
      DEFAULT_DB_WAIT_TIMEOUT_SECONDS,
    );
    intervalMs = parseDurationSecondsMs(
      env,
      "DB_WAIT_INTERVAL_SECONDS",
      DEFAULT_DB_WAIT_INTERVAL_SECONDS,
    );
  } catch (err) {
    if (err instanceof InvalidDurationEnvError) {
      log.error(`FATAL: ${err.message} — refusing to start the application.`);
      return 1;
    }
    throw err;
  }

  try {
    await waitForDatabase({ databaseUrl, timeoutMs, intervalMs, log });
  } catch (err) {
    if (err instanceof DatabaseUnreachableError) {
      log.error(`FATAL: ${err.message} — refusing to start the application.`);
    } else {
      log.error(
        "FATAL: unexpected error while waiting for the database — refusing to start the application.",
        err,
      );
    }
    return 1;
  }

  // PRISMA_SCHEMA_PATH exists so tests can point this exact wiring at a
  // throwaway, deliberately-broken migration, to prove the migration-failure
  // path is handled correctly without touching this repo's own migration
  // history — it's a test seam, and it must not apply by default on a real
  // deployment. The image sets NODE_ENV=production (see Dockerfile), so
  // gate on that: a deployment left at its defaults always applies the
  // committed prisma/schema.prisma, whether or not this variable happens to
  // be set — e.g. left over from a copied test config. This is NOT a
  // security boundary against a deliberate actor: NODE_ENV is itself a
  // container env var, and anyone who can set one can just as easily set
  // DATABASE_URL. What it closes is the accidental case.
  const isProduction = env.NODE_ENV === "production";
  if (env.PRISMA_SCHEMA_PATH && isProduction) {
    log.warn(
      "PRISMA_SCHEMA_PATH is set but ignored (NODE_ENV=production) — the committed prisma/schema.prisma is always used here.",
    );
  }
  const schemaPath = isProduction ? undefined : env.PRISMA_SCHEMA_PATH;

  // Announced before anything else can scroll it away. Silence when the
  // window is closed is what gives this line its meaning.
  const backfill = backfillWarning(env);
  if (backfill) log.warn(backfill);

  const migration = await runMigrations({ env, log, schemaPath });
  if (!migration.ok) {
    return migration.exitCode || 1;
  }

  const [command, ...args] = parseServerCommand(argv);
  return spawnServer(command, args, { env, log });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Anything that escapes main() itself unhandled — e.g. run-migrations.mjs's
      // spawn rejecting on EACCES/ENOENT before it can log its own FATAL —
      // would otherwise surface as a raw UnhandledPromiseRejection stack
      // trace instead of the same loud, unambiguous framing every other
      // boot failure gets.
      console.error(
        "FATAL: unexpected error during boot — refusing to start the application.",
        err,
      );
      process.exit(1);
    });
}
