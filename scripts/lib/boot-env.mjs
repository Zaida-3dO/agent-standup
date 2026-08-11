#!/usr/bin/env node
// Reads the two boot-wait duration knobs (DB_WAIT_TIMEOUT_SECONDS,
// DB_WAIT_INTERVAL_SECONDS) out of the environment, validated.
//
// A plain `Number(env.X ?? default)` looks safe and isn't: a duration typo
// like "60s" or "2m" parses to NaN, and `NaN <= 0` is false — so a bounded
// retry loop built on that value never actually bounds anything. An empty
// string (what an unset `${VAR:-}` in a Compose `environment:` block
// produces) parses to 0, silently deleting the wait instead of using the
// documented default. Both are "the variable is set, to something that
// isn't a valid duration" — the only sound response is the same one
// scripts/lib/run-migrations.mjs gives a failed migration: refuse to boot,
// loudly, immediately, rather than limp forward on a value nobody chose.
//
// Only a genuinely ABSENT variable (`undefined` — the operator never
// mentioned it) is "unconfigured", and that's the one case this module
// resolves quietly, to the documented default.
export const DEFAULT_DB_WAIT_TIMEOUT_SECONDS = 180;
export const DEFAULT_DB_WAIT_INTERVAL_SECONDS = 2;

export class InvalidDurationEnvError extends Error {
  constructor(varName, rawValue) {
    super(
      `${varName} is set to ${JSON.stringify(rawValue)}, which is not a positive number of ` +
        "seconds. Unset it to use the default, or set it to a whole or decimal number > 0.",
    );
    this.name = "InvalidDurationEnvError";
    this.varName = varName;
    this.rawValue = rawValue;
  }
}

/**
 * Reads `varName` from `env` as a duration in seconds and returns it in
 * milliseconds. `undefined` (the variable genuinely absent) resolves to
 * `defaultSeconds * 1000`. Any other value that isn't a finite, positive
 * number — including `""`, `"60s"`, `"2m"`, `"0"`, `"-1"` — throws
 * `InvalidDurationEnvError` rather than silently substituting the default.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} varName
 * @param {number} defaultSeconds
 * @returns {number} milliseconds
 */
export function parseDurationSecondsMs(env, varName, defaultSeconds) {
  const raw = env[varName];
  if (raw === undefined) {
    return defaultSeconds * 1000;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new InvalidDurationEnvError(varName, raw);
  }
  return seconds * 1000;
}
