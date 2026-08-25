// The `/cost` screen's load lifecycle — the pure half of `Cost.tsx`, split
// out for the reason `src/lib/since/state.ts` gives: this repo's harness runs
// `environment: "node"` with no DOM, so the query-string building and the
// loading/error/loaded branching are only directly testable as plain
// functions. The client component is thin wiring over these.
import { emptyCosts, type CostGrouping, type CostsPayload } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";

export type CostLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; costs: CostsPayload };

export interface FetchCostsOptions {
  readonly groupBy: CostGrouping;
  /** ISO instant. Only runs that started at or after it. */
  readonly since?: string;
  /** ISO instant. Only runs that started before it. */
  readonly until?: string;
  /** Narrow to one item — meaningful with any grouping. */
  readonly itemId?: string;
  readonly limit?: number;
}

/**
 * Builds the `GET /api/costs` query string.
 *
 * Its own exported function because the omission rules are the interesting
 * part and are worth testing without a fetch in the way. Every optional
 * parameter is omitted when absent rather than sent empty: the operation's
 * schema requires `itemId` to be a non-empty string when present, so
 * `?itemId=` would be an `invalid_input` rejection where "no item filter" is
 * a perfectly legal read.
 *
 * `groupBy` is always sent, because unlike the rest it has no server-side
 * default — it is the one required field on the operation.
 */
export function buildCostsQuery(options: FetchCostsOptions): string {
  const params = new URLSearchParams();
  params.set("groupBy", options.groupBy);
  if (options.since !== undefined) params.set("since", options.since);
  if (options.until !== undefined) params.set("until", options.until);
  if (options.itemId) params.set("itemId", options.itemId);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return uiApiPath(`/api/costs?${params.toString()}`);
}

/**
 * The totals from `GET /api/costs`. Throws a message fit to show directly —
 * never a raw `Response` or a JSON-parse error, matching `fetchFeed` and
 * `fetchBoard`.
 *
 * **A partial response is filled in, not trusted.** The server always sends
 * every field, but a component mapping `costs.groups` on a response missing
 * it would crash on `undefined.map`. Merging over `emptyCosts()` degrades a
 * malformed response into an empty result rather than a blank page.
 */
export async function fetchCosts(
  options: FetchCostsOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<CostsPayload> {
  const response = await fetchImpl(buildCostsQuery(options));
  if (!response.ok) {
    throw new Error(`Could not load costs (GET /api/costs returned ${response.status}).`);
  }
  const body = (await response.json()) as Partial<CostsPayload> | null;
  return { ...emptyCosts(options.groupBy), ...(body ?? {}) };
}

/** A message fit to show a reader, from whatever a failed load threw. */
export function costErrorMessageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load costs.";
}

/**
 * The window a reader picked, as the ISO instant the query needs.
 *
 * Days rather than dates because the question is always "the last N days",
 * and computing the boundary here rather than in the component keeps the
 * arithmetic testable. `null` means no lower bound — all of history.
 *
 * The boundary is midnight UTC `days` ago rather than "this instant minus N
 * × 24h", so the window aligns with the `day` grouping's own UTC buckets. A
 * rolling instant boundary would cut the oldest day in half and show a
 * partial bar that looks like a genuine drop in spend.
 */
export function sinceForDays(days: number | null, now: Date): string | null {
  if (days === null) return null;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - (days - 1) * 86_400_000).toISOString();
}
