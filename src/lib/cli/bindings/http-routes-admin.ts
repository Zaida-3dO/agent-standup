// The `http` binding's route table for the `repo` · `area` · `machine` ·
// `account` · `person` operations (SCHEMA.md §19, §20). MILESTONES.md #92.
//
// **Its own module, spread into `HTTP_ROUTES` (`./http.ts`) with one line —
// never entries written inline there**, for the same reason
// `../commands-admin.ts` is its own module: several rows land entries in
// that same route map concurrently (MILESTONES.md #80-83, #89 each add
// their own operations' routes as they land), so this keeps the admin
// entries in a file nothing else touches.
import type { RouteSpec } from "./http";

function property(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    params.set(key, value === null ? "" : String(value));
  }
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

/** `{ ...input }` minus one key, for a route that puts that key in the path. */
function without(input: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([k]) => k !== key));
}

export const ADMIN_HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  list_repos: {
    method: "GET",
    request: (input) => ({ path: `/api/repos${queryString(input)}` }),
    unwrap: (body) => body,
  },
  get_repo: {
    method: "GET",
    request: (input) => ({ path: `/api/repos/${encodeURIComponent(String(input.id ?? ""))}` }),
    unwrap: (body) => property(body, "repo"),
  },
  create_repo: {
    method: "POST",
    request: (input) => ({ path: "/api/repos", body: input }),
    unwrap: (body) => property(body, "repo"),
  },
  update_repo: {
    method: "PATCH",
    request: (input) => ({
      path: `/api/repos/${encodeURIComponent(String(input.id ?? ""))}`,
      body: without(input, "id"),
    }),
    unwrap: (body) => property(body, "repo"),
  },
  list_areas: {
    method: "GET",
    request: (input) => ({ path: `/api/areas${queryString(input)}` }),
    unwrap: (body) => body,
  },
  get_area: {
    method: "GET",
    request: (input) => ({ path: `/api/areas/${encodeURIComponent(String(input.id ?? ""))}` }),
    unwrap: (body) => property(body, "area"),
  },
  create_area: {
    method: "POST",
    request: (input) => ({ path: "/api/areas", body: input }),
    unwrap: (body) => property(body, "area"),
  },
  update_area: {
    method: "PATCH",
    request: (input) => ({
      path: `/api/areas/${encodeURIComponent(String(input.id ?? ""))}`,
      body: without(input, "id"),
    }),
    unwrap: (body) => property(body, "area"),
  },
  merge_areas: {
    method: "POST",
    request: (input) => ({ path: "/api/areas/merge", body: input }),
    // `POST /api/areas/merge` returns `MergeAreasOutput` unwrapped — `to`,
    // `from`, `itemsMerged`, `duplicatesResolved` — same as `list_areas`,
    // not nested under a named key the way the single-row `get`/`create`
    // routes are.
    unwrap: (body) => body,
  },
  list_machines: {
    method: "GET",
    request: () => ({ path: "/api/machines" }),
    unwrap: (body) => body,
  },
  get_machine: {
    method: "GET",
    request: (input) => ({ path: `/api/machines/${encodeURIComponent(String(input.name ?? ""))}` }),
    unwrap: (body) => property(body, "machine"),
  },
  update_machine: {
    method: "PATCH",
    request: (input) => ({
      path: `/api/machines/${encodeURIComponent(String(input.name ?? ""))}`,
      body: without(input, "name"),
    }),
    unwrap: (body) => property(body, "machine"),
  },
  list_accounts: {
    method: "GET",
    request: () => ({ path: "/api/accounts" }),
    unwrap: (body) => body,
  },
  get_account: {
    method: "GET",
    request: (input) => ({ path: `/api/accounts/${encodeURIComponent(String(input.id ?? ""))}` }),
    unwrap: (body) => property(body, "account"),
  },
  update_account: {
    method: "PATCH",
    request: (input) => ({
      path: `/api/accounts/${encodeURIComponent(String(input.id ?? ""))}`,
      body: without(input, "id"),
    }),
    unwrap: (body) => property(body, "account"),
  },
  // `people`. Two entries rather than the four the other nouns get: there
  // is no `get_person` operation and no `person get` verb to route, and the
  // deliberate-creation `POST` the `repos` routes have does not exist
  // either — `/api/people` carries no `POST`, because `PATCH /people/{id}`
  // *is* the create, the same way it is for `machines` and `accounts`.
  list_people: {
    method: "GET",
    // `list_people` is paged, unlike `list_repos` and `list_areas`, so the
    // query string carries `limit` and `cursor` as well as
    // `includeArchived`. `queryString` already sends every defined key, so
    // this needs no special casing here — but the *route* did: it read
    // `includeArchived` alone and dropped the other two, which would have
    // made `standup person list --limit 5` page on `direct` and silently
    // return everything on `http`. Fixed in `app/api/people/route.ts`
    // alongside this entry, since a route map is only as honest as the
    // route it names.
    request: (input) => ({ path: `/api/people${queryString(input)}` }),
    unwrap: (body) => body,
  },
  update_person: {
    method: "PATCH",
    request: (input) => ({
      path: `/api/people/${encodeURIComponent(String(input.id ?? ""))}`,
      body: without(input, "id"),
    }),
    unwrap: (body) => property(body, "person"),
  },
} as const satisfies Record<string, RouteSpec>);
