// Row #100's own HTTP routes for the `http` binding — `loop_add` and
// `loop_close` over the endpoints this row builds
// (`src/app/api/items/[id]/loops/**`).
//
// A separate module from `bindings/http.ts` for the reason
// `http-routes-ownership.ts` gives: several rows add routes to the same table
// concurrently, so `http.ts` gets one appended import and one appended spread
// rather than a rewrite of its existing entries.
import type { RouteSpec } from "./http";

function property(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

export const LOOP_HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  loop_add: {
    method: "POST",
    request: (input) => {
      const { itemId, ...rest } = input;
      return { path: `/api/items/${encodeURIComponent(String(itemId ?? ""))}/loops`, body: rest };
    },
    // The whole body, not one property: `loop_add` returns `{loopId, event}`
    // and the `loopId` is the half the caller cannot do without — it is
    // generated server-side, and a loop whose id the caller never learns can
    // never be closed. Unwrapping to `event` would throw it away.
    unwrap: (body) => body,
  },
  loop_close: {
    method: "POST",
    request: (input) => {
      const { itemId, loopId, ...rest } = input;
      return {
        path:
          `/api/items/${encodeURIComponent(String(itemId ?? ""))}` +
          `/loops/${encodeURIComponent(String(loopId ?? ""))}/close`,
        body: rest,
      };
    },
    unwrap: (body) => property(body, "event"),
  },
});
