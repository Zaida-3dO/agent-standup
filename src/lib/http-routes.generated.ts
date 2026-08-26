// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Written by `scripts/generate-http-routes.mjs` from the route tree under
// `src/app/api`. Run `npm run generate:http-routes` after adding, moving or
// removing a route; `npm run check:http-routes` fails in CI when this file
// and the route tree disagree, which is what keeps it honest.
//
// Served by `GET /api` so a caller can discover the HTTP surface instead of
// inferring it from which paths happen to 404. See the generator for why
// this is a committed artefact rather than a runtime directory scan.

/** One route this build serves, and the methods it accepts. */
export interface HttpRoute {
  readonly path: string;
  readonly methods: readonly string[];
}

/** Every route under `/api`, sorted by path. */
export const HTTP_ROUTES: readonly HttpRoute[] = [
  { path: "/api", methods: ["GET"] },
  { path: "/api/accounts", methods: ["GET"] },
  { path: "/api/accounts/{id}", methods: ["GET", "PATCH"] },
  { path: "/api/activity", methods: ["GET"] },
  { path: "/api/areas", methods: ["GET", "POST"] },
  { path: "/api/areas/{id}", methods: ["GET", "PATCH", "DELETE"] },
  { path: "/api/areas/merge", methods: ["POST"] },
  { path: "/api/backfill", methods: ["POST"] },
  { path: "/api/board", methods: ["GET"] },
  { path: "/api/checkpoints", methods: ["POST"] },
  { path: "/api/claims", methods: ["POST"] },
  { path: "/api/claims/heartbeat", methods: ["POST"] },
  { path: "/api/claims/release", methods: ["POST"] },
  { path: "/api/claims/takeover", methods: ["POST"] },
  { path: "/api/costs", methods: ["GET"] },
  { path: "/api/crew/name", methods: ["POST"] },
  { path: "/api/events", methods: ["GET"] },
  { path: "/api/events/{id}/seen", methods: ["POST"] },
  { path: "/api/fleet", methods: ["GET"] },
  { path: "/api/health", methods: ["GET"] },
  { path: "/api/hook", methods: ["POST"] },
  { path: "/api/hook/script", methods: ["GET"] },
  { path: "/api/items", methods: ["GET", "POST"] },
  { path: "/api/items/{id}", methods: ["GET", "PATCH", "DELETE"] },
  { path: "/api/items/{id}/artifacts", methods: ["POST"] },
  { path: "/api/items/{id}/complete", methods: ["POST"] },
  { path: "/api/items/{id}/detail", methods: ["GET"] },
  { path: "/api/items/{id}/history", methods: ["GET"] },
  { path: "/api/items/{id}/loops", methods: ["GET", "POST"] },
  { path: "/api/items/{id}/loops/{loopId}", methods: ["GET", "PATCH", "DELETE"] },
  { path: "/api/items/{id}/loops/{loopId}/close", methods: ["POST"] },
  { path: "/api/items/{id}/notes", methods: ["POST"] },
  { path: "/api/items/{id}/orientation", methods: ["GET"] },
  { path: "/api/items/{id}/reparent", methods: ["POST"] },
  { path: "/api/items/{id}/restore", methods: ["POST"] },
  { path: "/api/items/{id}/retype", methods: ["POST"] },
  { path: "/api/items/{id}/review-requests", methods: ["POST"] },
  { path: "/api/items/{id}/transition", methods: ["POST"] },
  { path: "/api/kill-guard", methods: ["POST"] },
  { path: "/api/machines", methods: ["GET"] },
  { path: "/api/machines/{name}", methods: ["GET", "PATCH"] },
  { path: "/api/mcp", methods: ["GET", "POST", "DELETE"] },
  { path: "/api/my-work", methods: ["GET"] },
  { path: "/api/needs-you", methods: ["GET"] },
  { path: "/api/people", methods: ["GET"] },
  { path: "/api/people/{id}", methods: ["PATCH", "DELETE"] },
  { path: "/api/progress-report", methods: ["GET"] },
  { path: "/api/projects", methods: ["GET", "POST"] },
  { path: "/api/projects/{id}", methods: ["GET"] },
  { path: "/api/ready", methods: ["GET"] },
  { path: "/api/repos", methods: ["GET", "POST"] },
  { path: "/api/repos/{id}", methods: ["GET", "PATCH", "DELETE"] },
  { path: "/api/search", methods: ["GET"] },
  { path: "/api/sessions/{id}", methods: ["GET"] },
  { path: "/api/sessions/{id}/register", methods: ["POST"] },
  { path: "/api/settings", methods: ["GET", "PATCH"] },
  { path: "/api/settings/{key}", methods: ["GET", "PUT", "DELETE"] },
  { path: "/api/settings/unrecognised/{key}", methods: ["DELETE"] },
  { path: "/api/subtasks", methods: ["POST"] },
  { path: "/api/sweep", methods: ["POST"] },
  { path: "/api/tasks", methods: ["POST"] },
  { path: "/api/tool-calls", methods: ["POST"] },
  { path: "/api/ui/{path...}", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
] as const;
