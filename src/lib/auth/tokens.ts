// Per-machine bearer tokens — how the HTTP transport knows who is calling.
//
// ── Why this exists at all: it is the multi-host enabler ─────────────────
//
// Every rule this product enforces — a merge needing an approving review at
// tip, a completion needing a structured summary, a transition needing an
// approved plan — is application code in the service layer. Postgres does
// not know those rules exist and cannot be taught them: "allowed only with
// an approving review at tip" is conditional on state a grant cannot
// evaluate. A database role can refuse a write to a table; it cannot refuse
// *this* write to *this* row on the grounds that a review artifact is
// missing at the item's current round.
//
// That gap is the whole argument. Without an authenticated remote path, a
// client on another host reaches the store the only way left to it — a
// direct connection — and every guard is bypassed, not by defeating a check
// but by never arriving at the code that checks. An item can land in
// `merged` with no commit, no review and no summary, and nothing in the
// system is wrong about anything: the rules were simply never consulted.
//
// So a token here is not a lock added to a door. It is the door: the thing
// that makes "call the API from another machine" a path that exists, so
// that the direct connection stops being the only way to do the job. The
// import-graph check and the lint rule that keep the database client behind
// the service layer are the same invariant enforced one process inward, and
// they are load-bearing precisely because this module gives that invariant
// somewhere to hold across hosts.
//
// ── Why per-machine, and not one shared secret ───────────────────────────
//
// A machine is already a first-class entity with a name of its own, which
// means a token per machine costs no new concept and buys two things a
// single shared secret cannot:
//
//   - **Revocation that is not an outage.** Retiring one machine's token
//     leaves every other machine working. A shared secret can only be
//     rotated everywhere at once, which is why in practice it never is.
//   - **Attribution that is worth reading.** The actor header travels on
//     every request and is otherwise a self-report: a caller says who it is
//     and nothing checks. Resolving a token to a machine name gives the
//     server one fact about the caller it did not take on trust, which is
//     what lets an attributed write mean something.
//
// ── Why the environment, and not the settings table ──────────────────────
//
// The settings table is explicitly never a secret store: every value in it
// is served to the front end and printed by the command line, with no
// redaction path, and its own registry fails the build on a
// credential-shaped key. A token is exactly such a key. It also has to be
// readable before the process can reach the database — a request arriving
// during startup must be answerable — which is the same test that puts the
// backfill switch in the environment.
//
// It has a second property that matters more here: the tokens live in the
// deployment layer, so nothing reachable over HTTP, MCP or the command line
// can mint one. A token store writable through the API would be writable by
// the surface it exists to gate.

/** The environment variable carrying the per-machine tokens. */
export const AUTH_TOKENS_ENV_VAR = "STANDUP_TOKENS";

/**
 * A caller that presented a valid token, and the machine it authenticated
 * as.
 *
 * The machine name is the whole payload. Nothing else about a token is
 * worth carrying: it grants no scopes and confers no capability beyond
 * "this request may be served", because authorisation in this product is a
 * question about item state that the service layer answers, not a question
 * about the caller that a token could pre-answer.
 */
export interface AuthenticatedMachine {
  readonly machine: string;
}

/**
 * The parsed token table: token → machine name.
 *
 * Keyed by token rather than by machine because the lookup this serves runs
 * in the token direction — a request presents a token and the server must
 * find the machine — and keying it the other way would mean scanning every
 * entry on every request.
 */
export type TokenTable = ReadonlyMap<string, string>;

/**
 * Parses the token table out of its environment variable.
 *
 * The format is `machine:token`, comma-separated:
 *
 * ```
 * STANDUP_TOKENS=laptop:s3cr3t-one,desktop:s3cr3t-two
 * ```
 *
 * **Malformed entries are dropped, never guessed at.** An entry with no
 * separator, an empty machine or an empty token is discarded rather than
 * being read charitably, because every charitable reading of a malformed
 * credential entry ends with a token that is not the one the operator
 * thought they configured. Dropping it means the affected machine is
 * refused and says so on its next call, which is a loud failure; inventing
 * a name for it would be a quiet one.
 *
 * **A duplicate token is dropped entirely — both entries.** Two machines
 * sharing one token cannot be told apart, which defeats the attribution
 * that per-machine tokens exist to provide, and picking a winner would
 * attribute one machine's writes to the other. Neither is served, so the
 * misconfiguration surfaces on the next call from either.
 *
 * Takes the environment as a parameter, defaulted to `process.env`, so the
 * result is a pure function of its input and every failure mode is testable
 * without mutating global state.
 */
export function parseTokenTable(env: Record<string, string | undefined> = process.env): TokenTable {
  const raw = env[AUTH_TOKENS_ENV_VAR];
  if (typeof raw !== "string") return new Map();

  const table = new Map<string, string>();
  const duplicated = new Set<string>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    // `indexOf`, not `split`, so a token containing a colon survives intact
    // — only the FIRST separator divides the pair. A token is opaque and
    // may legitimately contain any character an operator's generator emits;
    // splitting on every colon would silently truncate one and refuse a
    // machine whose configuration is perfectly correct.
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const machine = trimmed.slice(0, separator).trim();
    const token = trimmed.slice(separator + 1).trim();
    if (machine.length === 0 || token.length === 0) continue;

    if (table.has(token)) {
      duplicated.add(token);
      continue;
    }
    table.set(token, machine);
  }

  for (const token of duplicated) table.delete(token);

  return table;
}

/**
 * Whether any token is configured at all.
 *
 * Separate from "does this token match" because the two are different
 * answers to a caller: no tokens configured is an installation that has not
 * been set up, and a wrong token is a caller that has. Both refuse — see
 * `authenticate` — but only one of them is worth telling an operator about
 * at startup.
 */
export function hasConfiguredTokens(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseTokenTable(env).size > 0;
}
