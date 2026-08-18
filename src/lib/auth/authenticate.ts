// Turning an inbound request into an authenticated machine, or a refusal.
//
// Split from `tokens.ts` because the two answer different questions:
// that module reads the deployment's configuration, this one reads one
// request against it. Keeping the request-shaped half separate is what
// lets the configuration be tested with no request and the header parsing
// be tested with no environment.
import { timingSafeEqual } from "node:crypto";
import type { AuthenticatedMachine, TokenTable } from "./tokens";
import { parseTokenTable } from "./tokens";

/** The header a caller presents its token on. */
export const AUTHORIZATION_HEADER = "Authorization";

/** The scheme, lowercased for comparison — RFC 7235 makes it case-insensitive. */
const BEARER_SCHEME = "bearer";

/**
 * Why a request was refused.
 *
 * Two reasons rather than one because they are genuinely different
 * situations for whoever has to fix them: `missing` is a client that never
 * sent a credential (usually one that does not know it needs to), and
 * `invalid` is one that sent a credential this server does not recognise.
 * A single "unauthorised" would leave an operator unable to tell a client
 * that has not been configured yet from one whose token has been revoked.
 *
 * **Neither distinction is drawn any finer than that.** In particular there
 * is no "unknown machine" reason: a token that matches nothing is `invalid`
 * whether it was never valid or was withdrawn yesterday, because telling
 * those apart tells a caller which guesses were closer.
 */
export type AuthFailureReason = "missing" | "invalid";

export type AuthResult =
  | { readonly ok: true; readonly machine: AuthenticatedMachine }
  | { readonly ok: false; readonly reason: AuthFailureReason };

/**
 * Reads the token out of an `Authorization` header value.
 *
 * Returns `null` for anything that is not a well-formed bearer credential —
 * a missing header, a different scheme, or a scheme with nothing after it.
 * A `Basic` credential is refused rather than reinterpreted: it is a real
 * credential of the wrong kind, and treating its payload as a bearer token
 * would compare a base64 blob against the table and produce a confusing
 * near-miss instead of a clear "wrong scheme".
 */
export function bearerToken(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== "string") return null;

  const trimmed = headerValue.trim();
  const separator = trimmed.indexOf(" ");
  if (separator <= 0) return null;

  const scheme = trimmed.slice(0, separator);
  if (scheme.toLowerCase() !== BEARER_SCHEME) return null;

  const token = trimmed.slice(separator + 1).trim();
  return token.length === 0 ? null : token;
}

/**
 * Finds the machine a token belongs to, comparing in constant time.
 *
 * **Why not `table.get(token)`.** A map lookup on a string key compares
 * byte by byte and stops at the first difference, so the time it takes
 * depends on how much of a guess was correct. That is the signal a timing
 * attack reads, and it is exactly as available over a LAN as anywhere else
 * — "the network is trusted" is an assumption about who is on it, which is
 * the assumption this module exists to stop relying on.
 *
 * So every configured token is compared, the whole table is walked even
 * after a match is found, and each comparison is `timingSafeEqual`. The
 * cost is a handful of fixed-length comparisons per request against a table
 * with one entry per machine — nothing that matters at any realistic size.
 *
 * `timingSafeEqual` throws on unequal lengths, which would leak length
 * through an exception, so lengths are checked first and a mismatch is
 * recorded as a non-match rather than skipping the comparison. A token's
 * length is not the secret; whether a given guess is right is.
 */
export function machineForToken(token: string, table: TokenTable): string | null {
  const candidate = Buffer.from(token, "utf8");
  let found: string | null = null;

  for (const [configured, machine] of table) {
    const expected = Buffer.from(configured, "utf8");
    if (expected.length !== candidate.length) continue;
    if (timingSafeEqual(expected, candidate)) found = machine;
  }

  return found;
}

/**
 * Authenticates one request.
 *
 * **Fails closed, and closed includes "nothing configured".** An
 * installation with no tokens set refuses every authenticated call rather
 * than serving them all, which is the opposite of the usual convenience
 * default and is the point: a gate that switches itself off when its
 * configuration is missing protects nothing precisely when something has
 * gone wrong with the deployment. The failure is loud — every call refuses
 * with the same reason — and a loud failure at rollout is cheaper than a
 * server that has quietly been open since the day someone mistyped a
 * variable name.
 *
 * Takes the environment as a parameter for the same reason its dependencies
 * do: so the decision is a pure function of a request and a configuration,
 * with no global state to arrange in a test.
 */
export function authenticate(
  request: { readonly headers: { get(name: string): string | null } },
  env: Record<string, string | undefined> = process.env,
): AuthResult {
  const token = bearerToken(request.headers.get(AUTHORIZATION_HEADER));
  if (token === null) return { ok: false, reason: "missing" };

  const machine = machineForToken(token, parseTokenTable(env));
  if (machine === null) return { ok: false, reason: "invalid" };

  return { ok: true, machine: { machine } };
}
