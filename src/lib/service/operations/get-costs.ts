// `get_costs` — MILESTONES.md #53: "Aggregation: cost per item, per session,
// **per stage**." SCHEMA.md §11 (`runs`), §10 (`tool_calls.state_at`).
//
// ── One operation, three groupings, chosen by the caller ────────────────
//
// The row names three aggregations, and three operations would have been
// the obvious reading. They are one because the *only* thing that differs
// between them is the column in the `GROUP BY`: the source table, the four
// sums, the cost recomputation, the time bound and the response shape are
// identical. Three copies of that would be three places for the cost
// arithmetic to drift, and drift is precisely what #52's "always
// recomputable" is guarding against — a per-item total that disagrees with
// a per-session total covering the same runs is worse than either being
// absent, because both look authoritative.
//
// `groupBy` is a closed enum rather than a column name, so a caller cannot
// reach a column the operation did not intend to group by, and a new
// grouping is a deliberate addition here rather than whatever string a
// caller sends.
//
// ── The cost is recomputed, not summed ─────────────────────────────────
//
// This is the point of the row, and the reason it reads `runs` rather than
// summing the `cost` column.
//
// Summing stored costs would be cheaper and would be wrong in a way nobody
// could see. A stored cost was computed under whatever price table was
// configured at the moment the run was last written, so a total over a
// month spanning a price change is a sum of figures from two different
// tables — a number that corresponds to no price list that has ever
// existed. Worse, it cannot be corrected: fixing a mistyped rate would
// leave every historical total still carrying the old one.
//
// Recomputing from the four accumulated token counts and the current table
// gives a figure that is reproducible by anyone holding the same counts and
// the same rates, and correcting a rate corrects every total computed
// afterwards. The counts are the truth (§11); the cost is a view of them.
//
// The arithmetic itself is `@/lib/telemetry/pricing`, the same function the
// ingest uses, so a total here and a stored cost cannot be computed
// differently — they are the same code over the same inputs.
//
// ── Unpriced work is reported, never silently dropped ──────────────────
//
// A run whose model has no rate contributes its token counts to the group
// and contributes nothing to the cost, and the group says how many such
// runs it holds. A total that quietly omitted them would read as complete
// while being short by an unknown amount, which is the failure mode that
// makes a cost report untrustworthy without ever looking broken.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { costForModel, type ModelPrices } from "@/lib/telemetry/pricing";
import { pricesFrom } from "../telemetry/runs";

/**
 * What a total may be grouped by.
 *
 * The three §53 names, and no fourth. `stage` is the item state the runs
 * were attributed to — `Run.stateAt`, carried up from `ToolCall.stateAt` at
 * ingest, which §10 records as "the stage this work was attributed to"
 * rather than an exact per-call reading.
 */
export const COST_GROUPINGS = ["item", "session", "stage"] as const;

export type CostGrouping = (typeof COST_GROUPINGS)[number];

/**
 * The column each grouping reads.
 *
 * A lookup rather than string interpolation of a caller's value: the
 * grouping is a closed enum, so this map is total, and the column names
 * reaching the query are literals from this file rather than anything that
 * travelled over a wire.
 */
const GROUP_COLUMN: Record<CostGrouping, string> = {
  item: '"itemId"',
  session: '"sessionId"',
  stage: '"stateAt"::text',
};

/**
 * The most groups returned in one response.
 *
 * A read has to be bounded (MILESTONES.md #109), and an aggregate is not
 * automatically small: grouping by session over a year is one row per
 * session that ever ran, which is unbounded in exactly the way an item list
 * is. Groups are ordered by cost descending and cut here, which is also the
 * order a reader wants — a cost report is read from the expensive end.
 *
 * The response says when it cut, so a truncated report is never mistaken
 * for a complete one. That matters more for a total than for a list: a
 * short list is visibly short, whereas a total that silently omitted the
 * tail looks exactly like a correct total.
 */
export const MAX_COST_GROUPS = 100;
export const DEFAULT_COST_GROUPS = 25;

const inputSchema = z
  .object({
    groupBy: z.enum(COST_GROUPINGS),
    /**
     * Only runs that started at or after this instant. Absent means no
     * lower bound.
     *
     * Bounded on `startedAt` rather than on `endedAt`, because a run still
     * open has no end and would drop out of every window — and the open run
     * is the one describing work happening now, which is the row a cost
     * report is most often opened to see.
     */
    since: z.coerce.date().optional(),
    /** Only runs that started before this instant. Absent means no upper bound. */
    until: z.coerce.date().optional(),
    /**
     * Narrows to one item. Meaningful with any grouping: `groupBy: "stage"`
     * with an item is "what did each stage of this item cost", which is the
     * question §53's per-stage aggregation is most useful for.
     */
    itemId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_COST_GROUPS).optional(),
  })
  .strict();

export type GetCostsInput = z.infer<typeof inputSchema>;

export interface CostGroup {
  /**
   * The group's key — an item id, a session id, or a state name.
   *
   * Null is a real and distinct group rather than an omission: a run whose
   * session was never recorded, or whose item had no state at ingest,
   * belongs to "no key", and dropping those rows would make the totals
   * disagree with the corpus for no reason a reader could discover.
   */
  readonly key: string | null;
  readonly runs: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  /**
   * The group's cost, recomputed from its runs' counts at the current
   * rates. Null when *no* run in the group could be priced — distinct from
   * `0`, which means priced and free.
   */
  readonly cost: number | null;
  /**
   * How many runs in this group had no rate for their model. A non-zero
   * value beside a cost means the figure covers only part of the group.
   */
  readonly unpricedRuns: number;
}

export interface GetCostsOutput {
  readonly groupBy: CostGrouping;
  readonly groups: readonly CostGroup[];
  /**
   * True when there were more groups than the limit returned.
   *
   * Named for what it tells the reader — the total is partial — rather than
   * as a page cursor. §53 is a report, not a feed: a caller reading costs
   * wants to know the number is incomplete far more than it wants the next
   * page, and a boolean says that in a way a missing cursor does not.
   */
  readonly truncated: boolean;
  /**
   * How many models appearing in this result have no rate configured, and
   * which they are, capped.
   *
   * The list is the actionable half: an operator reading a short total
   * needs the model IDs to add to `pricing.model_prices`, and deriving them
   * from a per-group `unpricedRuns` count is not possible — the count says
   * that something was unpriced, never what.
   */
  readonly unpricedModels: readonly string[];
}

/**
 * How many distinct unpriced model IDs are named.
 *
 * A bound for the same reason the groups have one, and a small one: this is
 * a prompt to configure a rate, and a caller with more than a handful of
 * unconfigured models learns nothing further from the twelfth.
 */
const MAX_UNPRICED_MODELS = 20;

/** One run as the aggregation reads it. Grouping and costing happen over these. */
interface RunCostRow {
  readonly key: string | null;
  readonly model: string;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly cacheReadTokens: bigint;
  readonly toolCallCount: number;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getCosts = defineOperation({
  name: "get_costs",
  kind: "read",
  summary:
    "Totals token counts and recomputed cost across runs, grouped by item, session or stage.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetCostsInput): Promise<GetCostsOutput> {
    const prices = pricesFrom(ctx.settings);
    const limit = input.limit ?? DEFAULT_COST_GROUPS;

    // Sums are computed per (group, model) in SQL and costed per model in
    // TypeScript, then folded into groups. The split is forced by the
    // pricing rule: a group can hold runs served by several models, and
    // costing needs each model's counts against its own rate — so the
    // database cannot produce the cost and the application cannot afford to
    // read every run. Grouping by model as well collapses the corpus to one
    // row per (group, model) pair, which is bounded by the number of models
    // an installation uses.
    const conditions: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (input.since) conditions.push(`"startedAt" >= ${bind(input.since)}`);
    if (input.until) conditions.push(`"startedAt" < ${bind(input.until)}`);
    if (input.itemId) conditions.push(`"itemId" = ${bind(input.itemId)}`);
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;

    const rows = await ctx.db.$queryRawUnsafe<RunCostRow[]>(
      `SELECT ${GROUP_COLUMN[input.groupBy]} AS "key",
              "model",
              SUM("inputTokens")::bigint      AS "inputTokens",
              SUM("outputTokens")::bigint     AS "outputTokens",
              SUM("cacheWriteTokens")::bigint AS "cacheWriteTokens",
              SUM("cacheReadTokens")::bigint  AS "cacheReadTokens",
              SUM("toolCallCount")::int       AS "toolCallCount",
              COUNT(*)::int                   AS "runs"
       FROM "Run"
       ${where}
       GROUP BY 1, "model"`,
      ...params,
    );

    return fold(rows as (RunCostRow & { runs: number })[], input.groupBy, prices, limit);
  },
});

/** A group under construction, before it is costed and ordered. */
interface Accumulator {
  key: string | null;
  runs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cost: number | null;
  unpricedRuns: number;
}

/**
 * Folds per-(group, model) sums into per-group totals, costing each model's
 * share at its own rate.
 *
 * Extracted from the handler and exported so the folding and the costing
 * can be exercised without a database. That is not a convenience: the cases
 * worth testing here are a group spanning two models, a group where one of
 * them is unpriced, and a group where none is — and each is one line
 * against this function against a fixture-heavy seed through the operation.
 *
 * **A group's cost is null only when nothing in it could be priced.** A
 * group with one priced and one unpriced model reports the priced share as
 * its cost and reports `unpricedRuns` alongside, because a partial figure
 * with its incompleteness stated is more useful than no figure — and far
 * more useful than a complete-looking figure that quietly omitted a model.
 */
export function fold(
  rows: readonly (RunCostRow & { runs: number })[],
  groupBy: CostGrouping,
  prices: ModelPrices,
  limit: number,
): GetCostsOutput {
  const groups = new Map<string, Accumulator>();
  const unpriced = new Set<string>();

  for (const row of rows) {
    // The map key and the reported key differ: `null` is a legitimate group
    // and has to be distinguishable from the *string* "null", which a
    // session could genuinely be called. A sentinel object key that no
    // string can collide with keeps the two apart.
    const mapKey = row.key === null ? " null" : `s${row.key}`;
    const group = groups.get(mapKey) ?? {
      key: row.key,
      runs: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      cost: null,
      unpricedRuns: 0,
    };

    const counts = {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheWriteTokens: Number(row.cacheWriteTokens),
      cacheReadTokens: Number(row.cacheReadTokens),
    };

    group.runs += row.runs;
    group.toolCalls += row.toolCallCount;
    group.inputTokens += counts.inputTokens;
    group.outputTokens += counts.outputTokens;
    group.cacheWriteTokens += counts.cacheWriteTokens;
    group.cacheReadTokens += counts.cacheReadTokens;

    const { cost } = costForModel(row.model, counts, prices);
    if (cost === null) {
      group.unpricedRuns += row.runs;
      unpriced.add(row.model);
    } else {
      // `?? 0` rather than `+= cost` on a null: a group whose first model
      // is unpriced still costs whatever its second model costs, and
      // leaving the total null because of the order rows arrived in would
      // make the figure depend on the database's row ordering.
      group.cost = (group.cost ?? 0) + cost;
    }

    groups.set(mapKey, group);
  }

  const ordered = [...groups.values()].sort(byCostThenKey);

  return {
    groupBy,
    groups: ordered.slice(0, limit),
    truncated: ordered.length > limit,
    unpricedModels: [...unpriced].sort().slice(0, MAX_UNPRICED_MODELS),
  };
}

/**
 * Most expensive first, with a deterministic tiebreak.
 *
 * The tiebreak is what makes the *truncation* meaningful rather than
 * arbitrary: with cost alone, every group that could not be priced sorts
 * equal, so which of them survived the limit would depend on the database's
 * row order and could differ between two identical calls. A total that
 * changes between reads is a total nobody can act on.
 *
 * Null costs sort last rather than as zero. They are not cheap — they are
 * unknown — and putting an unpriced group above a genuinely small one would
 * present "we do not know" as "this was the most expensive".
 */
function byCostThenKey(a: Accumulator, b: Accumulator): number {
  if (a.cost === null && b.cost === null) return compareKeys(a.key, b.key);
  if (a.cost === null) return 1;
  if (b.cost === null) return -1;
  if (a.cost !== b.cost) return b.cost - a.cost;
  return compareKeys(a.key, b.key);
}

function compareKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
