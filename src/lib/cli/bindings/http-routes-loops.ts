// The `http` binding's routes for every loop operation — `loop_add` and
// `loop_close` from row #100, and the read/lifecycle set (`loop_list`,
// `loop_get`, `loop_edit`, `loop_delete`) over the endpoints under
// `src/app/api/items/[id]/loops/**`.
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

/**
 * Builds a query string from whatever is left after the path fields are
 * taken out. A local copy of `http.ts`'s helper, for the reason this module
 * exists at all: it is appended to concurrently and does not reach into its
 * sibling's internals.
 */
function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

/** `/api/items/{itemId}/loops/{loopId}`, both segments encoded. */
function loopPath(itemId: unknown, loopId: unknown): string {
  return (
    `/api/items/${encodeURIComponent(String(itemId ?? ""))}` +
    `/loops/${encodeURIComponent(String(loopId ?? ""))}`
  );
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
      return { path: `${loopPath(itemId, loopId)}/close`, body: rest };
    },
    unwrap: (body) => property(body, "event"),
  },
  // The list read. Everything but the item id travels in the query string,
  // as it does for every other list-shaped read here, and the result object
  // comes back unwrapped so `http` and `direct` return the same shape.
  loop_list: {
    method: "GET",
    request: (input) => {
      const { itemId, ...rest } = input;
      return {
        path: `/api/items/${encodeURIComponent(String(itemId ?? ""))}/loops${queryString(rest)}`,
      };
    },
    unwrap: (body) => body,
  },
  loop_get: {
    method: "GET",
    request: (input) => ({ path: loopPath(input.itemId, input.loopId) }),
    unwrap: (body) => body,
  },
  // The whole body, not just the event: `previousText` cannot be recovered
  // from any later read, because the loop now reports its new wording.
  loop_edit: {
    method: "PATCH",
    request: (input) => {
      const { itemId, loopId, ...rest } = input;
      return { path: loopPath(itemId, loopId), body: rest };
    },
    unwrap: (body) => body,
  },
  loop_delete: {
    method: "DELETE",
    request: (input) => {
      const { itemId, loopId, ...rest } = input;
      // The reason travels in the body of a DELETE — see the route's own
      // note: it is a sentence of prose the operation refuses without, and a
      // query parameter is the wrong place for one.
      return { path: loopPath(itemId, loopId), body: rest };
    },
    unwrap: (body) => body,
  },
});
