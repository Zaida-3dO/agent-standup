// Row #98's own HTTP routes for the `http` binding — `record_artifact` and
// `request_review` over the endpoints this row builds
// (`src/app/api/items/[id]/artifacts` and
// `src/app/api/items/[id]/review-requests`).
//
// A separate module from `bindings/http.ts` for the same reason
// `http-routes-ownership.ts` is: several rows add routes to the same
// `HTTP_ROUTES` table concurrently on their own branches, so `http.ts` gets
// one appended import and one appended spread, never a rewrite of its
// existing entries.
import type { RouteSpec } from "./http";

function property(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

export const ARTIFACT_HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  record_artifact: {
    method: "POST",
    request: (input) => {
      // `itemId` is lifted out of the body and into the path — the endpoint
      // is item-scoped, and sending it in both places would let the two
      // disagree. The route reads the path, so the body copy would be the
      // one silently ignored.
      const { itemId, ...rest } = input;
      return {
        path: `/api/items/${encodeURIComponent(String(itemId ?? ""))}/artifacts`,
        body: rest,
      };
    },
    unwrap: (body) => property(body, "artifact"),
  },
  request_review: {
    method: "POST",
    request: (input) => {
      const { itemId, ...rest } = input;
      return {
        path: `/api/items/${encodeURIComponent(String(itemId ?? ""))}/review-requests`,
        body: rest,
      };
    },
    unwrap: (body) => property(body, "event"),
  },
});
