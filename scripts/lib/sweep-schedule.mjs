#!/usr/bin/env node
// The pieces of the sweep scheduler that are worth testing on their own:
// reading its two knobs out of the environment, and one iteration of the
// loop. The loop that drives them lives in scripts/sweep-schedule.mjs.
//
// **Why a separate process at all, rather than a timer inside the app.**
// `src/lib/service/operations/sweep.ts` argues the point at length and this
// module exists to honour it, not to work around it: a timer inside the
// bundle runs once per replica, so the sweep fires at a multiple of the
// intended rate on a scaled deployment and at zero times if the replica
// holding the timer is the one that restarts. Neither failure is visible —
// there is no missing output either way, only claims released too eagerly or
// never at all. The schedule is therefore a deployment's decision, and a
// deployment expresses decisions by running something. This is that
// something: one process, invoking the ordinary `POST /api/sweep` endpoint
// on an interval, which any operator can replace with a cron entry or a
// scheduled task calling the same endpoint (or `standup sweep`) without the
// application knowing or caring which.
//
// It is deliberately a **caller and nothing more.** It holds no thresholds,
// no reclamation policy and no idea what a claim is — all of that is
// `sweepLiveness`, reached through the operation, so this file cannot drift
// away from the behaviour it triggers.
import { InvalidDurationEnvError, parseDurationSecondsMs } from "./boot-env.mjs";

// Five minutes. The interval is a tradeoff between how long a crashed
// session's claim blocks its item and how much pointless work the sweep does
// on a quiet installation, and the first side of that dominates: the sweep is
// a bounded scan that finds nothing on most runs, whereas a stranded claim
// blocks ownership of its item for the whole gap. Five minutes keeps the
// worst-case block well under the liveness thresholds an operator is likely
// to set (`liveness.dead_after_seconds` and friends, SCHEMA.md §17) while
// still being coarse enough that a run costs nothing in aggregate.
export const DEFAULT_SWEEP_INTERVAL_SECONDS = 300;

// Long enough that a sweep on a large corpus is not cut off mid-transaction,
// short enough that a wedged request cannot silently stall the schedule
// forever — an aborted attempt is retried on the next tick, an un-aborted one
// would stop the loop dead.
export const DEFAULT_SWEEP_TIMEOUT_SECONDS = 60;

export class SweepRequestError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SweepRequestError";
  }
}

/**
 * Reads the scheduler's configuration out of `env`.
 *
 * `STANDUP_URL` is required and has no default: there is no sensible guess
 * for where the application is, and a scheduler pointed at the wrong place
 * fails by doing nothing at all, which is exactly the silent failure this
 * whole row exists to remove.
 *
 * The two durations follow `scripts/lib/boot-env.mjs`'s rule verbatim, for
 * the same reason it gives: an absent variable is unconfigured and resolves
 * to the default, while a variable set to something that is not a positive
 * duration (`""`, `"5m"`, `"0"`) is a configuration error and refuses to
 * start. `""` is the one that matters here — it is what an unset `${VAR:-}`
 * in a Compose `environment:` block produces, and reading it as zero would
 * turn the schedule into a hot loop.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ standupUrl: string, intervalMs: number, timeoutMs: number }}
 */
export function resolveScheduleConfig(env) {
  const standupUrl = env.STANDUP_URL?.trim();
  if (!standupUrl) {
    throw new InvalidDurationEnvError("STANDUP_URL", env.STANDUP_URL ?? "");
  }

  return {
    standupUrl,
    intervalMs: parseDurationSecondsMs(
      env,
      "SWEEP_INTERVAL_SECONDS",
      DEFAULT_SWEEP_INTERVAL_SECONDS,
    ),
    timeoutMs: parseDurationSecondsMs(env, "SWEEP_TIMEOUT_SECONDS", DEFAULT_SWEEP_TIMEOUT_SECONDS),
  };
}

/**
 * Joins the base URL to the sweep path without depending on whether the
 * operator wrote a trailing slash — both forms are what someone types, and
 * naive concatenation turns one of them into a 404 that reads like the
 * endpoint is missing.
 *
 * @param {string} standupUrl
 * @returns {string}
 */
export function sweepEndpoint(standupUrl) {
  return `${standupUrl.replace(/\/+$/, "")}/api/sweep`;
}

/**
 * Runs one sweep and returns its parsed result.
 *
 * Sends `{}` rather than an empty body: the operation takes no input, the
 * route accepts either, and sending the explicit object keeps this request
 * indistinguishable from any other operation call in a proxy log.
 *
 * Every failure — a refused connection, a non-2xx status, a body that is not
 * JSON — throws `SweepRequestError`. The caller's job is to log it and keep
 * the schedule running; a scheduler that exits on the first failed tick stops
 * sweeping the moment the app restarts, which is precisely when the claims it
 * would release are being created.
 *
 * @param {{ endpoint: string, timeoutMs: number, fetchImpl?: typeof fetch }} options
 */
export async function runSweepOnce({ endpoint, timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
  } catch (err) {
    throw new SweepRequestError(`Sweep request to ${endpoint} failed: ${describe(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(abort);
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // The body is included because the service's error envelope carries the
    // code and the guard that refused — the whole diagnosis, on the line an
    // operator is already reading.
    throw new SweepRequestError(
      `Sweep request to ${endpoint} returned ${response.status}: ${text.trim() || "(empty body)"}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    // A 200 whose body is not JSON almost always means something else
    // answered — a proxy's error page, a login redirect — so say what came
    // back rather than only that parsing failed.
    throw new SweepRequestError(
      `Sweep request to ${endpoint} returned a non-JSON body: ${text.slice(0, 200)}`,
      { cause: err },
    );
  }
}

/**
 * One line summarising what a sweep did, for the scheduler's log. Counts
 * rather than identifiers: the run is attributable through the events the
 * sweep itself writes, and a log line that grows with the corpus is one
 * nobody reads.
 *
 * @param {unknown} result
 * @returns {string}
 */
export function summarizeSweep(result) {
  const counts = ["moves", "released", "escalated", "capabilityChecks"].map((key) => {
    const value = /** @type {Record<string, unknown>} */ (result ?? {})[key];
    return `${key}=${Array.isArray(value) ? value.length : 0}`;
  });
  return counts.join(" ");
}

function describe(err) {
  if (err instanceof Error && err.name === "AbortError") return "timed out";
  return String(err instanceof Error ? err.message : err);
}
