#!/usr/bin/env node
// The liveness sweep scheduler's logic, separated from its entrypoint
// (../sweep-schedule.mjs) so the whole of it is testable without spawning a
// process or waiting on a real timer.
//
// ## Why this exists at all, given the repository deliberately shipped nothing
//
// `src/lib/service/operations/sweep.ts` argues — correctly, and this module
// does not contradict it — that the sweep must be invoked from OUTSIDE the
// application process: the app may run as several replicas, so an internal
// timer fires once per replica (a multiple of the intended rate) or not at
// all (if the replica holding it is the one that restarted), and neither
// mistake produces any output to notice. That reasoning is about where the
// schedule lives, not an argument that there should be none. An installation
// with no schedule leaks claims that are reclaimable and never reclaimed.
//
// This is that outside caller, shipped so an operator has one that works
// rather than a README snippet each deployment retypes. It is a separate
// process from the app: run one of it, however many app replicas there are.
//
// ## Why it refuses to start rather than logging and continuing
//
// The dangerous failure for a component like this is not crashing — it is
// running. A scheduler that carries no usable credential, treats each 401 as
// transient, and logs it as "continuing" stays `Up` in `docker ps` forever: a
// deployment that does not read its logs looks correctly configured while
// sweeping exactly zero times, accumulating precisely the stranded claims the
// scheduler was added to prevent. That is the silent-success shape this
// codebase treats as worse than an outage, and the sweep route's own header
// says so about itself.
//
// Two rules follow, and they are the whole point of this module:
//
//   1. **A missing token is a startup error, not a runtime one.** There is
//      no code path here that sends an unauthenticated request. The token is
//      required before the first tick is ever scheduled.
//   2. **An auth failure is fatal, at any time.** 401 and 403 are not
//      transient. A token that is absent from `STANDUP_TOKENS`, revoked, or
//      mistyped will never start working on its own, so retrying it every
//      five minutes forever just spends the process's whole life failing
//      quietly in a way nothing reads.
//      The process exits non-zero and the container's restart policy makes
//      that visible. Every OTHER failure — a connection refused while the
//      app restarts, a 500, a timeout — IS transient and is logged and
//      retried, because those do fix themselves.
//
// The startup preflight is what turns "it authenticates" from a claim into
// an observation: before scheduling anything, it performs one real
// `{"dryRun": true}` sweep — an authenticated, writes-nothing call — and
// refuses to proceed unless the server accepts it. A misconfigured token is
// therefore caught at boot, in the open, rather than discovered days later
// from a claim nobody could take.

/** The env var carrying the bearer token. Matches the README's client contract. */
export const TOKEN_ENV_VAR = "STANDUP_TOKEN";
/** The env var carrying the base URL of the server to sweep. */
export const URL_ENV_VAR = "STANDUP_URL";
export const INTERVAL_ENV_VAR = "SWEEP_INTERVAL_SECONDS";
export const TIMEOUT_ENV_VAR = "SWEEP_TIMEOUT_SECONDS";

export const DEFAULT_SWEEP_INTERVAL_SECONDS = 300;
export const DEFAULT_SWEEP_TIMEOUT_SECONDS = 30;

/**
 * A configuration problem the scheduler cannot start with. Distinct from a
 * request failure so the entrypoint can exit on one and retry the other.
 */
export class SweepConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SweepConfigError";
  }
}

/**
 * The server rejected our credential. Fatal by design — see rule 2 above.
 */
export class SweepAuthError extends Error {
  constructor(status, body) {
    super(
      `The sweep endpoint rejected this scheduler's credential with HTTP ${status}. ` +
        `This will not fix itself: the token in ${TOKEN_ENV_VAR} is missing from the server's ` +
        `STANDUP_TOKENS table, revoked, or mistyped. Response: ${body}`,
    );
    this.name = "SweepAuthError";
    this.status = status;
  }
}

/** Any other failed sweep request. Transient; logged and retried. */
export class SweepRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "SweepRequestError";
  }
}

/**
 * Reads a duration in seconds from `env` and returns milliseconds. An absent
 * variable resolves to the default; anything else that is not a finite
 * positive number — `""`, `"5m"`, `"0"`, `"-1"` — is a config error rather
 * than a silent fallback, matching `scripts/lib/boot-env.mjs`'s reasoning:
 * an empty string is what an unset `${VAR:-}` in a Compose `environment:`
 * block produces, and letting it mean 0 would delete the interval entirely.
 */
export function parseIntervalMs(env, varName, defaultSeconds) {
  const raw = env[varName];
  if (raw === undefined) return defaultSeconds * 1000;
  const seconds = Number(raw);
  const ms = seconds * 1000;
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(ms)) {
    throw new SweepConfigError(
      `${varName} is set to ${JSON.stringify(raw)}, which is not a positive number of seconds. ` +
        "Unset it to use the default, or set it to a whole or decimal number > 0.",
    );
  }
  return ms;
}

/**
 * Resolves the whole configuration, or throws `SweepConfigError`.
 *
 * **The token is required here**, and that placement is structural rather
 * than stylistic: there is no `config` this function can return that would
 * let a caller send an unauthenticated request, so "forgot the token" cannot
 * reach a tick. Validating it later — at the first request, say — would leave
 * a code path where an unauthenticated sweep is expressible.
 */
export function resolveConfig(env) {
  const rawUrl = env[URL_ENV_VAR];
  if (rawUrl === undefined || rawUrl.trim() === "") {
    throw new SweepConfigError(
      `${URL_ENV_VAR} is required, e.g. ${URL_ENV_VAR}=http://agent-standup:3000 — the base URL of ` +
        "the server to sweep, without a path.",
    );
  }

  const token = env[TOKEN_ENV_VAR];
  if (token === undefined || token.trim() === "") {
    throw new SweepConfigError(
      `${TOKEN_ENV_VAR} is required. POST /api/sweep authenticates like every other route, so a ` +
        `scheduler needs a bearer token that appears in the server's STANDUP_TOKENS table. ` +
        "Refusing to start rather than sweeping zero times while reporting healthy.",
    );
  }

  let endpoint;
  try {
    endpoint = new URL("/api/sweep", rawUrl).toString();
  } catch {
    throw new SweepConfigError(
      `${URL_ENV_VAR} is set to ${JSON.stringify(rawUrl)}, which is not a valid URL.`,
    );
  }

  return {
    endpoint,
    token: token.trim(),
    intervalMs: parseIntervalMs(env, INTERVAL_ENV_VAR, DEFAULT_SWEEP_INTERVAL_SECONDS),
    timeoutMs: parseIntervalMs(env, TIMEOUT_ENV_VAR, DEFAULT_SWEEP_TIMEOUT_SECONDS),
  };
}

/**
 * Performs one sweep request.
 *
 * Always sends the bearer token — the signature takes `config` whole rather
 * than a URL, so there is no way to call this without one.
 *
 * `fetchImpl` is typed as the narrow shape this actually calls (a URL string
 * and an init object, answering something response-like) rather than as
 * `typeof fetch`. The real `fetch` satisfies it; so does a test stub, which
 * the full DOM signature would reject over `URL | RequestInfo` overloads this
 * code never uses.
 *
 * @typedef {(url: string, init: {
 *   method: string,
 *   headers: Record<string, string>,
 *   body: string,
 *   signal?: AbortSignal,
 * }) => Promise<{ ok: boolean, status: number, json: () => Promise<any>, text: () => Promise<string> }>} SweepFetch
 *
 * @param {{endpoint: string, token: string, timeoutMs: number}} config
 * @param {{dryRun?: boolean, fetchImpl?: SweepFetch}} [options]
 */
export async function runSweepOnce(config, options = {}) {
  const { dryRun = false, fetchImpl = fetch } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Unconditional: `config.token` cannot be absent, by construction.
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(dryRun ? { dryRun: true } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    throw new SweepRequestError(
      `Sweep request to ${config.endpoint} could not be completed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    // Read the body for the operator's benefit, but never let a failure to
    // read it downgrade an auth error into a transient one.
    let body = "<unreadable>";
    try {
      body = (await response.text()).slice(0, 500);
    } catch {
      /* keep the placeholder */
    }
    throw new SweepAuthError(response.status, body);
  }

  if (!response.ok) {
    let body = "<unreadable>";
    try {
      body = (await response.text()).slice(0, 500);
    } catch {
      /* keep the placeholder */
    }
    throw new SweepRequestError(
      `Sweep request to ${config.endpoint} returned ${response.status}: ${body}`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new SweepRequestError(
      `Sweep request to ${config.endpoint} returned ${response.status} with a body that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * One line summarising what a sweep result did, so a reader of the logs can
 * tell a sweep that worked from one that merely answered 200.
 */
export function describeResult(result, { dryRun = false } = {}) {
  const counts = [
    `${result?.moves?.length ?? 0} moved`,
    `${result?.released?.length ?? 0} released`,
    `${result?.escalated?.length ?? 0} escalated`,
    `${result?.exempted?.length ?? 0} exempted`,
  ].join(", ");
  const evicted = result?.evictedWhileRunning?.length ?? 0;
  const evictedNote = evicted > 0 ? `, ${evicted} evicted while still marked running` : "";
  return `${dryRun ? "Dry run" : "Sweep"}: ${counts}${evictedNote}.`;
}

/**
 * Proves, before any tick is scheduled, that this scheduler can authenticate
 * against the server it is pointed at — by making one real authenticated
 * call that writes nothing (`dryRun: true`).
 *
 * A `SweepAuthError` here means the deployment is misconfigured and must stop.
 * A transient error means the app is probably still booting, so this retries
 * until `deadlineMs` elapses — a scheduler that died because it started three
 * seconds before the app finished migrating would be its own kind of nuisance.
 */
/**
 * @param {{endpoint: string, token: string, timeoutMs: number}} config
 * @param {{
 *   fetchImpl?: SweepFetch,
 *   log?: { info: (msg: string) => void, warn: (msg: string) => void, error: (msg: string) => void },
 *   retryForMs?: number,
 *   retryDelayMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 */
export async function verifyAuth(config, options = {}) {
  const {
    fetchImpl = fetch,
    log = console,
    retryForMs = 120_000,
    retryDelayMs = 5_000,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const deadline = now() + retryForMs;
  for (;;) {
    try {
      const result = await runSweepOnce(config, { dryRun: true, fetchImpl });
      log.info(
        `Authenticated against ${config.endpoint}. ${describeResult(result, { dryRun: true })}`,
      );
      return result;
    } catch (error) {
      if (error instanceof SweepAuthError) throw error;
      if (now() >= deadline) {
        throw new SweepConfigError(
          `Could not reach ${config.endpoint} to verify this scheduler can authenticate, after ` +
            `${Math.round(retryForMs / 1000)}s of retrying. Last error: ${error.message}`,
        );
      }
      log.warn(`Waiting for ${config.endpoint} to become reachable: ${error.message}`);
      await sleep(retryDelayMs);
    }
  }
}
