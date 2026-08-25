// The shape the `/cost` screen renders — over the `GET /api/costs` response
// (`get_costs`, MILESTONES.md #53, widened by T19).
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// the reason `@/lib/since/types.ts` and `@/lib/costs/types.ts` give: the
// front end reaches the service layer only through the adapter's JSON, never
// its modules. Importing `GetCostsOutput` here would put a module that
// transitively imports the database client's types onto the client bundle's
// import graph, which `npm run check:db-imports` exists to prevent.
//
// `@/lib/costs/types.ts` already mirrors this response for the overnight
// report, and is left alone: it models only the fields that report renders.
// This screen needs the grouping vocabulary and the request shape as well,
// so the two coexist rather than one growing to serve both readers.

/** What a total may be grouped by — the six `get_costs` accepts. */
export type CostGrouping = "item" | "project" | "session" | "stage" | "day" | "model";

/**
 * The groupings the screen offers, in the order it offers them.
 *
 * Ordered by how a reader arrives at the question rather than
 * alphabetically: spend over time first because that is the shape of the
 * "what are we spending" question, then the two organisational cuts, then
 * the two mechanical ones.
 */
export const COST_GROUPINGS: readonly CostGrouping[] = [
  "day",
  "project",
  "item",
  "session",
  "model",
  "stage",
];

/** How each grouping is labelled, and what its key means. */
export const COST_GROUPING_LABELS: Readonly<Record<CostGrouping, string>> = {
  day: "Day",
  project: "Project",
  item: "Item",
  session: "Session",
  model: "Model",
  stage: "Stage",
};

/** One group's totals. */
export interface CostGroup {
  /**
   * The group's key — an item id, a project id, a session id, a state name,
   * a model name, or a `YYYY-MM-DD` day.
   *
   * Null is a real group rather than an omission: a run whose session was
   * never recorded, or whose item had no state at ingest, belongs to "no
   * key". The screen labels it as such rather than hiding it, because
   * dropping it would make the visible totals disagree with the corpus.
   */
  readonly key: string | null;
  readonly runs: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  /**
   * Recomputed at current rates. **Null means "could not be priced", never
   * "free"** — the distinction the screen must preserve, since presenting an
   * unpriced group as £0.00 is exactly the false completeness this screen is
   * warned against.
   */
  readonly cost: number | null;
  /** How many runs in this group had no rate for their model. */
  readonly unpricedRuns: number;
}

/** The whole `GET /api/costs` response. */
export interface CostsPayload {
  readonly groupBy: CostGrouping;
  readonly groups: readonly CostGroup[];
  /** True when there were more groups than the limit returned — the totals are then a floor, not the whole figure. */
  readonly truncated: boolean;
  /** Models appearing in this result with no configured rate, so a short total is explicable. */
  readonly unpricedModels: readonly string[];
}

/** An empty payload, for the shape a failed or unsent request falls back to. */
export function emptyCosts(groupBy: CostGrouping): CostsPayload {
  return { groupBy, groups: [], truncated: false, unpricedModels: [] };
}
