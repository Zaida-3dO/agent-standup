// Row #43's own HTTP route for the `http` binding — the registration
// handshake over `POST /sessions/{id}/register` (SCHEMA.md §19, §21).
//
// A separate module from `bindings/http.ts` for the reason
// `http-routes-ownership.ts` states: several rows add routes to the same
// `HTTP_ROUTES` table concurrently on their own branches, so `http.ts` gets
// one appended import and one appended spread, never a rewrite of its
// existing entries.
import type { RouteSpec } from "./http";

function property(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

export const SESSION_HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  register_session: {
    method: "POST",
    /**
     * The session id goes in the path and everything else in the body,
     * matching the endpoint's shape. It is *not* also sent in the body: the
     * route puts the path's id last when it composes the operation input, so
     * a body copy would be overwritten by the identical value — dead weight
     * that a reader would have to check was in fact identical.
     */
    request: (input) => {
      const { sessionId, ...rest } = input;
      return {
        path: `/api/sessions/${encodeURIComponent(String(sessionId ?? ""))}/register`,
        body: rest,
      };
    },
    unwrap: (body) => property(body, "registration"),
  },
});
