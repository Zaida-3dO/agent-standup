// Whether the backfill surface exists at all (SCHEMA.md §17.1 — what must
// be known before the process can reach the database).
//
// Backfill is a bulk write that bypasses the state machine, so it is not
// something a running installation should keep reachable. The intended
// operating model is a **window**: turn it on, run one import, turn it off.
// During normal operation the surface is *absent*, not merely guarded.
//
// **Why an environment variable and not a setting in the database.** The
// split is "what must be known before the process can reach the database":
// a switch deciding whether an endpoint exists at all is bootstrap by that
// test, and it has a second property a stored setting could not have — the
// toggle lives in the deployment layer, so nothing reachable through HTTP,
// MCP or the command line can flip it. A database-backed setting would be
// writable by the very surface it is supposed to gate.
//
// ── Fail closed. This is the whole point of the module ──────────────────
//
// Enabled requires an explicit, exact affirmative. Everything else —
// unset, empty, whitespace, `1`, `yes`, `on`, `false`, a typo, a value with
// a stray space — is DISABLED.
//
// The failure mode being avoided is specific. A gate written as
// `value !== "false"`, or as a truthiness test on a raw string, is *open*
// for every value its author did not think of — and in JavaScript every
// non-empty string is truthy, including the string `"false"`. A gate that
// allows whatever it cannot positively evaluate stops gating anything at
// all the moment its inputs move, and it does so silently, because a gate
// failing open produces no signal. The rule here is the opposite, on
// purpose: nothing is enabled unless it was positively and exactly asked
// for.
//
// Case is NOT folded, deliberately. `TRUE` and `True` are refused along
// with everything else. Accepting case variants means deciding which ones,
// and every accepted variant is one more spelling that has to stay correct;
// one exact spelling is a rule with no edge to get wrong. It is also
// trivially greppable in a deployment manifest.

/** The one value that enables backfill. Anything else, including any other casing, does not. */
export const BACKFILL_ENABLED_VALUE = "true";

/** The environment variable that opens the backfill window. */
export const BACKFILL_ENV_VAR = "ENABLE_BACKFILL";

/**
 * Whether the backfill window is open.
 *
 * Takes the environment as a parameter, defaulted to `process.env`, so the
 * decision is a pure function of its input and every failure mode can be
 * tested without mutating global state.
 */
export function isBackfillEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[BACKFILL_ENV_VAR] === BACKFILL_ENABLED_VALUE;
}

/**
 * The line to log at startup when the window is open — and nothing at all
 * when it is closed.
 *
 * Silence when disabled is what gives the line its meaning: a message that
 * printed on every boot regardless would be scrolled past, and the failure
 * this exists to catch is nobody noticing. The realistic failure here is
 * not an attacker — it is opening the window, being interrupted, and
 * leaving it open for weeks.
 *
 * Returns the message rather than printing it, so the caller decides where
 * it goes and a test can assert on it directly.
 */
export function backfillStartupWarning(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isBackfillEnabled(env)) return null;
  return (
    `WARNING: backfill is ENABLED (${BACKFILL_ENV_VAR}=${BACKFILL_ENABLED_VALUE}). ` +
    "The bulk-import surface is reachable and bypasses the state machine. " +
    `Unset ${BACKFILL_ENV_VAR} and restart as soon as the import is finished.`
  );
}

/** The reminder returned with every successful backfill, for the same reason the startup line exists. */
export const BACKFILL_DISABLE_REMINDER = `Backfill is still enabled. Unset ${BACKFILL_ENV_VAR} and restart to close the window.`;
