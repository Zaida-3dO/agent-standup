#!/usr/bin/env node
// The liveness sweep scheduler's entrypoint. All of the logic — and all of
// the reasoning about why this runs outside the app process and why an auth
// failure is fatal — is in ./lib/sweep-schedule.mjs.
//
// Boot sequence, in order, and the order is the point:
//   1. Resolve config. A missing STANDUP_TOKEN stops us HERE, before any
//      request exists to send unauthenticated.
//   2. Prove we can authenticate, with one `dryRun: true` sweep that writes
//      nothing. A 401/403 stops us here.
//   3. Only then start the timer.
//
// Run it:
//   STANDUP_URL=http://agent-standup:3000 STANDUP_TOKEN=... node scripts/sweep-schedule.mjs
import { pathToFileURL } from "node:url";
import {
  resolveConfig,
  runSweepOnce,
  verifyAuth,
  describeResult,
  SweepAuthError,
  SweepConfigError,
} from "./lib/sweep-schedule.mjs";

/**
 * Typed as the loose shapes this actually uses — a string map and three log
 * methods — rather than `process.env` and `Console`. Those defaults would
 * otherwise narrow the parameters to types a caller has to fully satisfy,
 * which is wrong: nothing here reads `NODE_ENV` or `console.table`.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   log?: { info: (msg: string) => void, warn: (msg: string) => void, error: (msg: string) => void },
 *   sleepForever?: boolean,
 * }} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function main({ env = process.env, log = console, sleepForever = true } = {}) {
  let config;
  try {
    config = resolveConfig(env);
  } catch (error) {
    if (error instanceof SweepConfigError) {
      log.error(`FATAL: ${error.message}`);
      return 78; // EX_CONFIG
    }
    throw error;
  }

  log.info(
    `Sweep scheduler starting. Target ${config.endpoint}, every ${config.intervalMs / 1000}s, ` +
      `request timeout ${config.timeoutMs / 1000}s.`,
  );

  // Step 2 — prove the credential works before committing to a schedule.
  try {
    await verifyAuth(config, { log });
  } catch (error) {
    if (error instanceof SweepAuthError || error instanceof SweepConfigError) {
      log.error(`FATAL: ${error.message}`);
      return 77; // EX_NOPERM
    }
    throw error;
  }

  if (!sleepForever) return 0;

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  for (;;) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, config.intervalMs);
      // Do not hold the event loop open past a shutdown signal.
      timer.unref?.();
      const poll = setInterval(() => {
        if (stopping) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 250);
      poll.unref?.();
    });
    if (stopping) break;

    try {
      const result = await runSweepOnce(config);
      log.info(describeResult(result));
    } catch (error) {
      if (error instanceof SweepAuthError) {
        // Fatal even mid-run: a credential that stopped working will not
        // start working again, and continuing would be the silent failure
        // this whole module exists to prevent.
        log.error(`FATAL: ${error.message}`);
        return 77;
      }
      // Everything else is transient — the app restarting, a timeout, a 500.
      log.warn(`Sweep failed, will retry at the next tick: ${error.message}`);
    }
  }

  log.info("Sweep scheduler stopping.");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("FATAL: the sweep scheduler crashed.", error);
      process.exitCode = 1;
    },
  );
}
