// The overnight report's spend read — the fetch shaping over `GET
// /api/costs`, as a plain function. Split out for the same reason
// `@/lib/board/state.ts` and `@/lib/since/state.ts` are: this repo's
// harness runs `environment: "node"` with no DOM, so the fetch shaping is
// only directly testable outside a component.
import type { CostsPayload } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";

export interface FetchCostsOptions {
  readonly groupBy?: "item" | "session" | "stage";
  /** Only runs started at or after this instant — the overnight report's cutoff. */
  readonly since?: string;
}

/** An empty payload — what a malformed response degrades to, matching `emptyBoard`/`emptyFeed`. */
export function emptyCosts(groupBy: "item" | "session" | "stage" = "stage"): CostsPayload {
  return { groupBy, groups: [], truncated: false, unpricedModels: [] };
}

/**
 * Fetches cost totals. Throws a message fit to show directly — never a raw
 * `Response` or a JSON-parse error, matching `fetchBoardColumn`/`fetchFeed`.
 */
export async function fetchCosts(
  options: FetchCostsOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CostsPayload> {
  const groupBy = options.groupBy ?? "stage";
  const params = new URLSearchParams({ groupBy });
  if (options.since !== undefined) params.set("since", options.since);
  const response = await fetchImpl(uiApiPath(`/api/costs?${params.toString()}`));
  if (!response.ok) {
    throw new Error(`Could not load costs (GET /api/costs returned ${response.status}).`);
  }
  const body = (await response.json()) as Partial<CostsPayload> | null;
  return { ...emptyCosts(groupBy), ...(body ?? {}) };
}

/**
 * The total cost across every returned group, or null when nothing could be
 * priced at all.
 *
 * Mirrors `get-costs.ts`'s own `fold` rule: a null in any group means
 * unknown, not zero, so a sum that treated null as 0 would understate a
 * report and look complete while being wrong. Only when every group is null
 * does the total report null; a mix reports the priced share, same as one
 * group would.
 */
export function totalCost(payload: CostsPayload): number | null {
  let total: number | null = null;
  for (const group of payload.groups) {
    if (group.cost === null) continue;
    total = (total ?? 0) + group.cost;
  }
  return total;
}

/** Turns a caught value into the message the error state shows. */
export function costsErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load costs.";
}
