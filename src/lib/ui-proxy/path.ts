// The one function every front-end request path goes through.
//
// The front end does not call `/api/...` directly, because a call from a
// browser carries no credential and the API refuses it — see
// `@/lib/auth/browser-session.ts` for why the browser is deliberately not
// given one. It calls `/api/ui/...`, which is served by a route that
// attaches the server's own token and forwards to the same handler.
//
// **Why a function rather than each caller writing the prefix.** A prefix
// spelled by hand at twenty call sites is a prefix the twenty-first forgets,
// and the symptom of forgetting is a 401 on one screen — the kind of bug
// that reaches a person rather than a test. Routing every path through one
// place makes the front end's base address a single fact, which is also
// what lets `tests/ui-proxy-paths.test.ts` assert that no module under the
// front end's own directories writes a bare `/api/` literal.
//
// This runs in the browser, so it must stay free of anything server-only:
// it is a string transformation with no environment access and no imports.

/** The prefix the forwarding route is mounted at. */
export const UI_API_PREFIX = "/api/ui";

/**
 * The front end's address for an API path.
 *
 * Accepts the path as it appears in this repository's own documentation and
 * route tree (`/api/board`, `/api/items/x/detail`) and returns the address
 * the browser should call. Query strings and already-encoded segments pass
 * through untouched — this rewrites the prefix and nothing else, so a
 * caller that has carefully encoded an id does not have it encoded twice.
 *
 * A path already under the prefix is returned unchanged, so composing two
 * helpers (a base path from one module, a suffix from another) cannot
 * produce `/api/ui/api/ui/...`.
 *
 * A path that is not under `/api/` at all is returned unchanged as well:
 * this is not the place to discover that a caller has built a URL to
 * somewhere else entirely, and silently prefixing one would produce a
 * confusing request to a route that does not exist rather than the honest
 * 404 the original path earns.
 */
export function uiApiPath(path: string): string {
  if (path.startsWith(`${UI_API_PREFIX}/`) || path === UI_API_PREFIX) return path;
  if (!path.startsWith("/api/")) return path;
  return `${UI_API_PREFIX}${path.slice("/api".length)}`;
}
