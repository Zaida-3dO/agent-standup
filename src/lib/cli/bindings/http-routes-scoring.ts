// The `http` binding's routes for the eleven operations that had no command
// line, and therefore no route either.
//
// In its own module, spread into `http.ts`'s table as a single line, per that
// module's header: rows add entries rather than rewriting existing lines, so
// concurrent CLI rows do not conflict over the same lines.
//
// **Why these routes exist at all.** All eleven were reachable on MCP and
// nowhere else. Binding them to the command line without also routing them
// would have left them working under `--direct` and failing under `--url`,
// which is the binding divergence `tests/cli-http-binding.test.ts` exists to
// prevent — it asserts that every operation the command table calls has a
// route, waiving only `service_info` by name.
//
// **The id goes in the path, the rest in the body or the query.** Each entry
// pulls exactly the field the route reads from the path out of the input and
// forwards what is left, so nothing is sent twice and nothing is dropped.
import type { RouteSpec } from "./http";

/**
 * Splits one field out of an input, returning it and everything else.
 *
 * The path segment must not also appear in the body: the route merges the
 * path id back in itself, so sending it twice would mean two spellings of
 * the same value arriving at an operation whose schema is `.strict()`.
 */
function splitPathField(
  input: Record<string, unknown>,
  field: string,
): { readonly value: string; readonly rest: Record<string, unknown> } {
  const { [field]: raw, ...rest } = input;
  return { value: String(raw ?? ""), rest };
}

/**
 * Builds a query string from what is left after the path field is removed.
 *
 * A local copy of `http.ts`'s own `queryString` rather than an import,
 * because that one is not exported. Same rule: `undefined` is dropped,
 * everything else is stringified, so the schema on the far side sees exactly
 * the fields the caller set.
 */
function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    params.set(key, value === null ? "" : String(value));
  }
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

export const SCORING_HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  // ── Runs and their scores ───────────────────────────────────────────
  list_runs: {
    method: "GET",
    request: (input) => ({ path: `/api/runs${queryString(input)}` }),
    unwrap: (body) => body,
  },
  get_run_scores: {
    method: "GET",
    request: (input) => ({ path: `/api/runs/scores${queryString(input)}` }),
    unwrap: (body) => body,
  },
  score_run: {
    method: "POST",
    request: (input) => {
      const { value, rest } = splitPathField(input, "runId");
      return { path: `/api/runs/${encodeURIComponent(value)}/score`, body: rest };
    },
    unwrap: (body) => body,
  },
  derive_run_score: {
    method: "POST",
    request: (input) => {
      const { value, rest } = splitPathField(input, "runId");
      return { path: `/api/runs/${encodeURIComponent(value)}/derive`, body: rest };
    },
    unwrap: (body) => body,
  },
  accept_run_score: {
    method: "POST",
    request: (input) => {
      const { value, rest } = splitPathField(input, "runId");
      return { path: `/api/runs/${encodeURIComponent(value)}/accept`, body: rest };
    },
    unwrap: (body) => body,
  },

  // ── Intervention scoring ────────────────────────────────────────────
  score_intervention: {
    method: "POST",
    request: (input) => {
      const { value, rest } = splitPathField(input, "eventId");
      return { path: `/api/interventions/${encodeURIComponent(value)}/score`, body: rest };
    },
    unwrap: (body) => body,
  },
  get_intervention_scores: {
    method: "GET",
    request: (input) => ({ path: `/api/interventions/scores${queryString(input)}` }),
    unwrap: (body) => body,
  },

  // ── The four that hang off an existing noun ─────────────────────────
  //
  // `get_item_artifacts` names the item `id`, not `itemId` — it is a read of
  // one item, spelled the way every other single-item read spells it.
  get_item_artifacts: {
    method: "GET",
    request: (input) => {
      const { value, rest } = splitPathField(input, "id");
      return { path: `/api/items/${encodeURIComponent(value)}/artifacts${queryString(rest)}` };
    },
    unwrap: (body) => body,
  },
  report_blocked_on_tool: {
    method: "POST",
    request: (input) => {
      const { value, rest } = splitPathField(input, "itemId");
      return { path: `/api/items/${encodeURIComponent(value)}/blocked-on-tool`, body: rest };
    },
    unwrap: (body) => body,
  },
  repair_stuck_projects: {
    method: "POST",
    request: (input) => {
      const { value, rest } = splitPathField(input, "projectId");
      return { path: `/api/projects/${encodeURIComponent(value)}/repair`, body: rest };
    },
    unwrap: (body) => body,
  },
  get_session_shape: {
    method: "GET",
    request: (input) => {
      const { value, rest } = splitPathField(input, "sessionId");
      return { path: `/api/sessions/${encodeURIComponent(value)}/shape${queryString(rest)}` };
    },
    unwrap: (body) => body,
  },
});
