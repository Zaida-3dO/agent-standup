// Building authenticated requests for tests that drive route handlers.
//
// Every route the HTTP adapter exposes authenticates, so a test that calls a
// handler directly has to present a token the same way a real client does.
// Doing that inline in each file would mean a literal token string and an
// environment stub repeated across every suite that touches a route, and a
// change to either shape would have to find all of them.
//
// The token here is a fixed test value with no meaning outside the suite —
// it is matched against the environment this module also configures, so the
// two cannot drift apart.
import { vi } from "vitest";

/**
 * The token the test environment accepts.
 *
 * A single shared constant rather than one per file: the value is arbitrary,
 * and having exactly one means a suite cannot configure one token and send
 * another — a mismatch that would surface as a uniform 401 and read like the
 * gate being broken rather than the fixture being wrong.
 */
export const TEST_TOKEN = "test-suite-bearer-token";

/** The machine the token above resolves to. */
export const TEST_MACHINE = "test-machine";

/**
 * Configures the environment so the routes accept `TEST_TOKEN`.
 *
 * Call it in a `beforeAll` or `beforeEach`. It uses `vi.stubEnv`, so Vitest
 * restores the previous value between files and one suite cannot leak its
 * configuration into another.
 */
export function stubAuthEnvironment(): void {
  vi.stubEnv("STANDUP_TOKENS", `${TEST_MACHINE}:${TEST_TOKEN}`);
}

/** The Authorization header a request has to carry, as a plain object to spread. */
export const AUTH_HEADER: Readonly<Record<string, string>> = Object.freeze({
  authorization: `Bearer ${TEST_TOKEN}`,
});

/**
 * Adds the Authorization header to a set of headers a test already has.
 *
 * Takes and returns a plain record rather than a `Headers`, because that is
 * the shape route tests build inline (`{ "content-type": "application/json" }`),
 * and converting would make the call sites longer than the thing they are
 * spreading.
 */
export function withAuth(
  headers: Record<string, string> = {},
): Record<string, string> {
  return { ...headers, ...AUTH_HEADER };
}

/**
 * Builds a `Request` that carries the token.
 *
 * A thin wrapper over the constructor so a test reads as "an authenticated
 * POST to this path" rather than as header assembly. `init.headers` is
 * merged rather than replaced, so a case that needs its own content type or
 * a request id keeps it.
 */
export function authenticatedRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_TOKEN}`);
  return new Request(url, { ...init, headers });
}
