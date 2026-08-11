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
export async function main({
  env = process.env,
  argv = process.argv.slice(2),
  log = console,
  spawnServer = defaultSpawnServer,
} = {}) {
  const databaseUrl = env.DATABASE_URL;

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
  // history — it's a test seam, and it must not be a live production
  // control surface. The image sets NODE_ENV=production (see Dockerfile),
  // so gate on that rather than trusting "nobody sets it in production":
  // honouring it there would let anything able to set a container env var
  // redirect which migrations get applied to the real database at boot.
  const isProduction = env.NODE_ENV === "production";
  if (env.PRISMA_SCHEMA_PATH && isProduction) {
    log.warn(
      "PRISMA_SCHEMA_PATH is set but ignored (NODE_ENV=production) — the committed prisma/schema.prisma is always used here.",
    );
  }
  const schemaPath = isProduction ? undefined : env.PRISMA_SCHEMA_PATH;
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
