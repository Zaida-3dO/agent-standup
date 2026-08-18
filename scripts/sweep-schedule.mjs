#!/usr/bin/env node
// Invokes the liveness sweep on an interval, forever. Run as a companion
// service beside the application (see docker-compose.prod.yml's
// `sweep-scheduler`), or ignored entirely in favour of a host cron entry
// calling the same endpoint — the application does not know or care which,
// which is the whole point of the schedule living outside it. README.md's
// Deployment section carries the operator-facing version of this;
// scripts/lib/sweep-schedule.mjs carries the reasoning and the parts under
// test.
//
// **Configuration failures refuse to start; sweep failures do not.** They are
// different problems. A missing `STANDUP_URL` or a mistyped interval is wrong
// on every future tick, so exiting lets the container's restart policy make
// it visible instead of leaving a process that ticks quietly and achieves
// nothing. A failed sweep is usually the app restarting, which is exactly
// when the claims worth releasing are being stranded — so the loop logs it
// and comes back on the next tick.
import { pathToFileURL } from "node:url";
import { InvalidDurationEnvError } from "./lib/boot-env.mjs";
import {
  resolveScheduleConfig,
  runSweepOnce,
  summarizeSweep,
  sweepEndpoint,
} from "./lib/sweep-schedule.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{ env?: Record<string, string | undefined>, log?: { info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void }, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void>, maxTicks?: number }} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function main({
  env = process.env,
  log = console,
  fetchImpl = fetch,
  sleepImpl = sleep,
  // Unbounded in production — a scheduler stops when its container does.
  // Finite only so a test can drive a whole loop and have it return.
  maxTicks = Number.POSITIVE_INFINITY,
} = {}) {
  let config;
  try {
    config = resolveScheduleConfig(env);
  } catch (err) {
    if (err instanceof InvalidDurationEnvError) {
      log.error(`FATAL: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const endpoint = sweepEndpoint(config.standupUrl);
  log.info(`Sweeping ${endpoint} every ${config.intervalMs / 1000}s.`);

  for (let tick = 0; tick < maxTicks; tick += 1) {
    try {
      const result = await runSweepOnce({
        endpoint,
        timeoutMs: config.timeoutMs,
        fetchImpl,
      });
      log.info(`Sweep complete: ${summarizeSweep(result)}`);
    } catch (err) {
      log.warn(`Sweep failed, continuing: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleepImpl(config.intervalMs);
  }

  return 0;
}

// Same self-execution guard as scripts/entrypoint.mjs: importing this file
// (which the tests do) must not start a scheduler.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // The loop swallows sweep failures by design, so anything reaching
      // here is a defect in the scheduler itself rather than a bad tick —
      // and it deserves the same loud framing entrypoint.mjs gives a boot
      // failure, not a raw unhandled-rejection stack.
      console.error("FATAL: unexpected error in the sweep scheduler.", err);
      process.exit(1);
    });
}
