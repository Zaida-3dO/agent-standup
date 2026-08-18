// How a browser reaches an API that only speaks bearer tokens.
//
// ── The question this answers ────────────────────────────────────────────
//
// Authentication here exists so that a client on another host has a path to
// the service layer's guards at all: without one it reaches the store the
// only way left to it, a direct database connection, and every rule is
// bypassed by never being reached. That argument is about *machines* — a
// process that holds configuration, that an operator can hand a credential
// to, and whose token can be withdrawn without anyone else noticing.
//
// **A browser is none of those things.** It holds no configuration, there is
// nobody to hand it a secret, and anything it is given is readable by
// whoever opens the developer tools — which makes per-machine revocation
// meaningless, because the credential was published to every reader the
// moment it was shipped. So the browser does not get a machine's identity.
//
// What it gets instead is a server that will act for it. The front end
// calls its own origin; the server attaches the credential and forwards the
// call to the very same authenticated handlers every remote client reaches.
// The token lives in the server process and is never serialised into a
// response, so there is nothing in the page for a reader to take.
//
// ── Why this is not a same-origin exemption ──────────────────────────────
//
// The tempting shortcut is to let a request through when it looks like it
// came from the app — `Origin`, `Sec-Fetch-Site`, a referer. Every one of
// those is a value the client chooses. They are honest signals from an
// honest browser, which is exactly why they are worthless as a gate: the
// caller they are meant to stop is the one writing the header by hand, and
// it costs a single command-line flag. An exemption of that kind does not
// weaken the gate so much as replace it with a request to please identify
// yourself truthfully.
//
// So nothing here is exempt. The forwarded call presents a real token, is
// matched against the configured table by the same constant-time comparison
// as any other, and resolves to a real machine name that appears in the
// logs and on attributed writes. The browser's path is not a hole beside
// the gate; it is the gate, walked by a process that is allowed to hold a
// key.
//
// ── Why a machine of its own ─────────────────────────────────────────────
//
// The forwarding server is given its own entry rather than borrowing one,
// because the two properties per-machine tokens exist for both depend on it:
// its token can be withdrawn without disturbing any other client, and a
// write that arrived through the front end is distinguishable in the record
// from one a command-line client made. Reusing another machine's token
// would attribute every reader's action to that machine and make revoking
// the front end an outage for something else.
import { parseTokenTable } from "./tokens";

/**
 * The environment variable naming which configured machine the front end
 * presents itself as.
 *
 * A *name*, not a token. The tokens are already configured in one place,
 * and a second variable holding a second copy of one of them is a second
 * thing to rotate — and the one that gets forgotten. This names a row in
 * the table that already exists, so revoking the front end's access is done
 * where every other machine's access is done.
 */
export const BROWSER_MACHINE_ENV_VAR = "STANDUP_BROWSER_MACHINE";

/**
 * The machine name assumed when the variable above is unset.
 *
 * A default exists here — unlike the token table, which deliberately has
 * none — because it names nothing secret. It is a lookup key: with a
 * `browser:<token>` entry configured the front end works with no extra
 * variable at all, and with no such entry it resolves to nothing and the
 * front end is refused. Neither outcome depends on the default being
 * guessed correctly by anyone.
 */
export const DEFAULT_BROWSER_MACHINE = "browser";

/**
 * The token the forwarding server presents, or `null` when the deployment
 * has not configured one.
 *
 * **`null` is a refusal, never a reason to skip the credential.** The
 * caller must turn it into an error response; forwarding the request
 * without a token would turn a missing configuration into an unauthenticated
 * request that the API then correctly refuses — which is at least loud —
 * but forwarding it *past* the gate would turn it into an open API. The
 * whole point of the table's fail-closed behaviour is that a deployment
 * whose configuration is missing serves nothing, and a front-end path that
 * quietly worked anyway would be the one way around that.
 *
 * Read per call rather than captured at module load, so the value in the
 * process environment at the moment of a request is the one presented. That
 * is what makes withdrawing a token take effect: a value memoised once at
 * startup would keep being sent for the life of the process. Takes the
 * environment as a parameter for the reason this module's neighbours do:
 * the result is a pure function of its input, with no global state to
 * arrange in a test.
 */
export function browserSessionToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const wanted = (env[BROWSER_MACHINE_ENV_VAR] ?? DEFAULT_BROWSER_MACHINE).trim();
  if (wanted.length === 0) return null;

  // The table is keyed by token because the request-time lookup runs in
  // that direction; this is the one caller that needs the other direction,
  // so it walks the table rather than the table growing a second index for
  // it. It is a handful of entries, read once per forwarded request.
  //
  // A name configured twice yields nothing rather than an arbitrary winner:
  // two tokens for one machine name means an operator's intent is genuinely
  // unreadable here, and picking whichever the parser happened to keep
  // would make which token the front end uses depend on the order entries
  // were typed in — so it refuses, which is visible, instead of choosing,
  // which is not.
  let found: string | null = null;
  for (const [token, machine] of parseTokenTable(env)) {
    if (machine !== wanted) continue;
    if (found !== null) return null;
    found = token;
  }

  return found;
}
