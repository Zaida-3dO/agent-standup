// The pure half of the front end's forwarding route — what it sends onward
// and what it sends back — split out for the reason every `state.ts` in this
// repository is: the harness runs `environment: "node"` with no DOM and no
// server, so the header handling and the refusals are only directly testable
// as plain functions. The route itself is thin wiring over these.
import { AUTHORIZATION_HEADER } from "@/lib/auth";

/**
 * The path prefix the front end calls, and which this module strips before
 * forwarding.
 *
 * A prefix of its own rather than reusing `/api` directly, because the two
 * are different surfaces and collapsing them would make every remote client's
 * URL also a forwarding URL.
 */
export const UI_PROXY_PREFIX = "/api/ui";

/**
 * Headers that must never be copied from the browser onto the forwarded
 * request.
 *
 * **`authorization` is the load-bearing entry.** Without it a reader could
 * put any bearer token in a `fetch` from the console and have this server
 * present it — the forwarding server would become an oracle for testing
 * guessed credentials, with its own valid token replaced by the guess. The
 * credential on a forwarded call is decided *here*, by the server, from its
 * own configuration, and nothing the browser says participates in that
 * decision.
 *
 * `cookie` follows for the same reason at one remove: this product issues no
 * cookies and reads none, so anything arriving in that header is either
 * irrelevant or an attempt to have this server relay something it should not.
 *
 * `host` and the `content-length` family are dropped because they describe
 * the hop that just ended, not the one about to start — forwarding a stale
 * length against a re-encoded body is how a proxy corrupts a request.
 */
export const STRIPPED_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
];

/**
 * The headers to send onward: everything the browser sent that is not
 * stripped, plus the server's own credential.
 *
 * Written as a fresh `Headers` rather than a mutation of the inbound one, so
 * the stripping cannot be defeated by a header name whose casing differs
 * from the list — `Headers` lower-cases on the way in, so the comparison is
 * against a normalised name every time.
 */
export function forwardedRequestHeaders(inbound: Headers, token: string): Headers {
  const headers = new Headers();
  inbound.forEach((value, name) => {
    if (STRIPPED_REQUEST_HEADERS.includes(name.toLowerCase())) return;
    headers.set(name, value);
  });
  headers.set(AUTHORIZATION_HEADER, `Bearer ${token}`);
  return headers;
}

/**
 * Headers that must never be copied from the API's response back to the
 * browser.
 *
 * `www-authenticate` is dropped so a refusal cannot turn into a browser
 * credential prompt: the reader has no token to type, and the one the server
 * failed to present is not theirs to supply. The hop-by-hop entries are
 * dropped for the same reason they are on the way out — they describe a
 * connection that has ended.
 */
export const STRIPPED_RESPONSE_HEADERS: readonly string[] = [
  "www-authenticate",
  "content-encoding",
  "content-length",
  "connection",
  "transfer-encoding",
];

/** The response headers to send back to the browser. */
export function forwardedResponseHeaders(inbound: Headers): Headers {
  const headers = new Headers();
  inbound.forEach((value, name) => {
    if (STRIPPED_RESPONSE_HEADERS.includes(name.toLowerCase())) return;
    headers.set(name, value);
  });
  return headers;
}

/**
 * Turns the incoming front-end URL into the API URL to call.
 *
 * Returns `null` for anything that is not under the prefix, which the caller
 * must treat as a refusal rather than forwarding it somewhere else. The path
 * is rebuilt from the already-parsed segments and re-encoded, so a caller
 * cannot smuggle a different destination through an encoded separator: the
 * segments arrive decoded from the router, and each is encoded exactly once
 * on the way out.
 *
 * **The destination's origin is taken from the inbound URL, never from a
 * header.** A `Host` or `X-Forwarded-Host` a client controls would let it
 * choose where this server sends a request carrying a valid credential —
 * the classic way a forwarding route becomes a way to post someone's token
 * to an arbitrary destination.
 */
export function forwardTargetUrl(requestUrl: string, segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  // A segment that is empty, or that navigates, cannot contribute to a
  // path under `/api` — refuse rather than normalise, so there is no
  // arithmetic here for a caller to reason about backwards.
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }

  const source = new URL(requestUrl);
  const target = new URL(source.origin);
  target.pathname = `/api/${segments.map(encodeURIComponent).join("/")}`;
  target.search = source.search;
  return target.toString();
}

/**
 * The refusal returned when the deployment has configured no token for the
 * front end.
 *
 * **This is the fail-closed path, and it must stay a refusal.** The
 * alternative — forwarding the call without a credential — is not merely a
 * different flavour of failure: it is the one shape that could later be
 * "fixed" by exempting the forwarded call from the gate, which would leave
 * the API open to anyone who can reach the port. Refusing here means a
 * deployment with no browser token configured serves an empty front end and
 * says why, which is loud, rather than serving a working one to everybody.
 *
 * The status is 503 rather than 401: nothing is wrong with the reader's
 * request, and telling a browser it was unauthorised would send whoever
 * debugs it looking for a credential the reader was never meant to have. The
 * server is configured in a way that cannot serve this surface yet, which is
 * what 503 says.
 */
export function unconfiguredResponseBody(): { readonly error: { readonly message: string } } {
  return {
    error: {
      message:
        "The front end has no credential to call the API with. Configure a token for its " +
        "machine name in STANDUP_TOKENS (default machine name: browser, override with " +
        "STANDUP_BROWSER_MACHINE).",
    },
  };
}
