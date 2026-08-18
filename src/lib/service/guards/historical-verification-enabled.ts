// Whether the merge gate will accept a `historical_verification` artifact in
// place of an approving `code_review` (SCHEMA.md §6b, §16).
//
// The problem this exists for: an item whose work demonstrably shipped
// cannot enter `merged`, because that transition requires an approving
// `code_review` at the current review round and tip commit, and for work
// that finished before this installation existed there is no reviewer who
// could honestly have written one. The observed consequence is worse than a
// stuck board. An agent facing that refusal can record a `code_review` with
// an approving verdict and close the item in one call — and **nothing in the
// product can tell that apart from a real review**, because a forged review
// is byte-identical to an honest one. The gate's whole value then rests on
// an agent declining to do the thing that makes its inconvenience go away,
// and it applies that pressure hardest in precisely the situation where the
// approval would be least meaningful.
//
// ── Why this is an environment variable, and not a stored setting ───────
//
// The same split `src/lib/backfill/enabled.ts` draws, for the same reason: a switch
// deciding whether a surface exists at all is bootstrap, and it has one
// property no database-backed setting could have — **the toggle lives in the
// deployment layer, so nothing reachable over HTTP, MCP or the command line
// can open it for itself.** A stored setting would be writable through the
// very surface it is meant to gate. `items.default_merge_authority` is
// already marked `sensitive` for a weaker version of this concern (§13e);
// this is the stronger case and takes the stronger mechanism.
//
// ── Why a window rather than a permanent capability ─────────────────────
//
// Closing a backlog of already-shipped work is an event, not an ongoing mode
// of operation. Making the capability permanent — for instance by keying it
// to a property of the row, such as having arrived through an import — would
// leave every one of those items carrying a second, weaker merge path
// forever, including long after the item has been reopened and worked on
// live. A window is bounded in time by construction, is announced at
// startup, and expires by being closed rather than by anyone remembering
// which rows were special.
//
// ── Fail closed ─────────────────────────────────────────────────────────
//
// Enabled requires an explicit, exact affirmative. Unset, empty, whitespace,
// `1`, `yes`, `on`, `false`, a typo, a stray space — all DISABLED. A gate
// written as a truthiness test is open for every value its author did not
// think of, and in JavaScript every non-empty string is truthy, including
// the string `"false"`. Case is not folded, for the reason
// `src/lib/backfill/enabled.ts` gives: one exact spelling is a rule with no edge to
// get wrong, and it greps cleanly in a deployment manifest.
//
// Both windows are listed in `.env.example`, which is where an operator
// looks to check whether one is still set.

/** The one value that opens the window. Anything else, including any other casing, does not. */
export const HISTORICAL_VERIFICATION_ENABLED_VALUE = "true";

/** The environment variable that opens the window. */
export const HISTORICAL_VERIFICATION_ENV_VAR = "ENABLE_HISTORICAL_VERIFICATION";

/**
 * Whether the merge gate will accept a `historical_verification` artifact.
 *
 * Takes the environment as a parameter, defaulted to `process.env`, so the
 * decision is a pure function of its input and every failure mode is
 * testable without mutating global state.
 */
export function isHistoricalVerificationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[HISTORICAL_VERIFICATION_ENV_VAR] === HISTORICAL_VERIFICATION_ENABLED_VALUE;
}

/**
 * The line to log at startup when the window is open — and nothing at all
 * when it is closed.
 *
 * Silence when disabled is what gives the line its meaning: a message that
 * printed on every boot would be scrolled past, and the failure this exists
 * to catch is nobody noticing. The realistic failure is not an attacker — it
 * is opening the window for one cleanup, being interrupted, and leaving it
 * open.
 *
 * Returns the message rather than printing it, so the caller decides where
 * it goes and a test can assert on it directly.
 */
export function historicalVerificationStartupWarning(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isHistoricalVerificationEnabled(env)) return null;
  return (
    `WARNING: historical verification is ENABLED ` +
    `(${HISTORICAL_VERIFICATION_ENV_VAR}=${HISTORICAL_VERIFICATION_ENABLED_VALUE}). ` +
    "Items whose work predates this installation can merge on a recorded inspection " +
    "instead of a code review. " +
    `Unset ${HISTORICAL_VERIFICATION_ENV_VAR} and restart once the cleanup is finished.`
  );
}
