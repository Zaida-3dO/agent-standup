// The `backfill` route for the command line's HTTP binding
// (docs/plans/BACKFILL.md).
//
// Its own module, spread into `HTTP_ROUTES` (`./http.ts`) with one line —
// the same arrangement the admin and ownership routes use, so concurrent
// work adding routes elsewhere never conflicts with this one.
import type { RouteSpec } from "./http";

export const BACKFILL_HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  backfill: {
    method: "POST",
    // The whole input is the body. `POST /api/backfill` takes the same
    // `{ payload }` wrapper the operation's own schema does, so there is
    // nothing to move into a path or a query string — and a payload of this
    // size could not go in one anyway.
    request: (input) => ({ path: "/api/backfill", body: input }),
    // The route returns the operation's result unwrapped (no envelope key),
    // so there is nothing to unwrap here.
    unwrap: (body) => body,
  },
});
