// Row #82's own HTTP routes for the `http` binding — claim, release,
// heartbeat, checkpoint, note, orientation, my-work and crew-name over the
// real endpoints #29/#28 built (`src/app/api/claims/**`,
// `src/app/api/checkpoints/**`, `src/app/api/items/[id]/notes`,
// `src/app/api/items/[id]/orientation`, `src/app/api/my-work`) plus this
// row's own `src/app/api/crew/name`.
//
// A separate module from `bindings/http.ts` for the same reason
// `commands-ownership.ts` is separate from `commands.ts`: several rows add
// routes to the same `HTTP_ROUTES` table concurrently on their own
// branches, so `http.ts` gets one appended import and one appended spread,
// never a rewrite of its existing entries.
import type { RouteSpec } from "./http";

function property(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

/** Same shape as `http.ts`'s own `queryString` — duplicated rather than imported (that one is module-private). */
function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    params.set(key, value === null ? "" : String(value));
  }
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

export const OWNERSHIP_HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  claim: {
    method: "POST",
    request: (input) => ({ path: "/api/claims", body: input }),
    unwrap: (body) => property(body, "assignment"),
  },
  release: {
    method: "POST",
    request: (input) => ({ path: "/api/claims/release", body: input }),
    unwrap: (body) => property(body, "assignment"),
  },
  heartbeat: {
    method: "POST",
    request: (input) => ({ path: "/api/claims/heartbeat", body: input }),
    unwrap: (body) => property(body, "assignment"),
  },
  // Reclamation (MILESTONES.md #99). Both return their operation's result
  // object whole rather than under a key — `takeover`'s result is not just an
  // assignment (it carries how alive the holder was judged, whether the
  // warning had to be forced, and what has NOT been enforced), and `sweep`'s
  // is a report with four lists in it. Unwrapping either to one field would
  // discard the part the caller most needs to read.
  takeover: {
    method: "POST",
    request: (input) => ({ path: "/api/claims/takeover", body: input }),
    unwrap: (body) => body,
  },
  sweep: {
    method: "POST",
    request: (input) => ({ path: "/api/sweep", body: input }),
    unwrap: (body) => body,
  },
  checkpoint: {
    method: "POST",
    request: (input) => ({ path: "/api/checkpoints", body: input }),
    unwrap: (body) => property(body, "event"),
  },
  note: {
    method: "POST",
    request: (input) => {
      const { itemId, ...rest } = input;
      return { path: `/api/items/${encodeURIComponent(String(itemId ?? ""))}/notes`, body: rest };
    },
    unwrap: (body) => property(body, "event"),
  },
  orientation: {
    method: "GET",
    request: (input) => {
      const { itemId, ...rest } = input;
      return {
        path: `/api/items/${encodeURIComponent(String(itemId ?? ""))}/orientation${queryString(rest)}`,
      };
    },
    unwrap: (body) => body,
  },
  my_work: {
    method: "GET",
    request: (input) => ({ path: `/api/my-work${queryString(input)}` }),
    unwrap: (body) => body,
  },
  progress_report: {
    method: "GET",
    request: (input) => ({ path: `/api/progress-report${queryString(input)}` }),
    unwrap: (body) => body,
  },
  get_crew_name: {
    method: "POST",
    request: (input) => ({ path: "/api/crew/name", body: input }),
    unwrap: (body) => property(body, "name"),
  },
});
