// The shape the overnight report's spend figure renders — over `GET
// /api/costs`, which is `get_costs` (MILESTONES.md #53).
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// the same reason `@/lib/board/types.ts` and `@/lib/since/types.ts` mirror
// their routes by hand: the front end reaches the service layer only
// through the adapter's JSON, never its modules — see those files' headers
// for the full reasoning and what `check:db-imports` enforces.
//
// Only the fields the overnight report actually renders are modelled.

/** One group's totals — an item, project, session, stage, day or model, chosen by `groupBy`. */
export interface CostGroup {
  readonly key: string | null;
  readonly runs: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  /** Recomputed at current rates. Null when nothing in the group could be priced — never defaulted to 0. */
  readonly cost: number | null;
  readonly unpricedRuns: number;
}

/** The whole `GET /api/costs` response. */
export interface CostsPayload {
  readonly groupBy: "item" | "session" | "stage" | "project" | "day" | "model";
  readonly groups: readonly CostGroup[];
  /** True when there were more groups than the limit returned — the total below is then a floor, not the whole figure. */
  readonly truncated: boolean;
  readonly unpricedModels: readonly string[];
}
