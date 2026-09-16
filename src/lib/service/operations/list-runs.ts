// `list_runs` — the route from an item id to a `runId`.
//
// ── The gap this closes ────────────────────────────────────────────────
//
// Run scoring was complete except for its front door. `score_run`,
// `accept_run_score` and `derive_run_score` all REQUIRE a `runId`, and
// nothing an orchestrator could call ever returned one. `record_tool_calls`
// returns `runs[]`, but it is the telemetry ingest path — called by the
// hook, never by an agent reasoning about its own work. `get_run_scores`
// accepts `runId` as a *filter* and reports how many runs are unscored
// without ever naming one. The observable result was a table with runs in
// it and no scores on any of them: the correct outcome of a contract nobody
// could satisfy, not a lack of interest.
//
// ── Why a read AFTER the work, and not an id handed out before it ──────
//
// The obvious cheaper fix — have `claim` return a `runId` — is wrong, and
// it is worth writing down why so nobody re-proposes it. A run is cut by
// `decideRun` (`telemetry/run-boundary.ts`) on a reported (model, effort)
// change, and independently by `attribute` on a stage change
// (`current.stateAt !== owner.stateAt`). `Run.assignmentId` is a plain FK
// with no uniqueness, so ONE assignment provably spans SEVERAL runs. An id
// handed out at claim time goes stale the first time the model changes or
// the item transitions — and the failure is silent: the caller scores some
// earlier run while believing it scored the one the work happened in.
//
// Asking afterwards has none of that ambiguity, because by then the runs
// are cut and closed. It is also purely additive: no existing caller
// changes behaviour, nothing under `prisma/` moves, and every lookup here
// hits an index the schema already declares (`@@index([itemId, startedAt])`
// and `@@index([sessionId, startedAt])`).
//
// ── Scope ──────────────────────────────────────────────────────────────
//
// This is item 1 of a four-item chain and deliberately ships alone. In
// particular `Run.model` is still populated only from telemetry and nothing
// copies `Assignment.model` into it, so `get_run_scores({model})` still
// returns empty for any real model id. Run scoring is therefore usable BY
// HAND after this, but not yet usable FOR SIZING. That is the honest limit
// and the reason `model` is returned verbatim below rather than smoothed
// over.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { InvalidInputError } from "../errors";
import { resolveItemId } from "../items/resolve-id";

/**
 * The page bound.
 *
 * A run is coarse — one agent's turn on one item, not one tool call — so an
 * item's runs number in the handful and a session's in the tens. 50 covers
 * the real question ("which runs happened on this item") without a caller
 * thinking about paging at all; 200 is the most that may be asked for,
 * matching the ceiling `get_board` uses for the same reason.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    /**
     * The item whose runs to list. Accepts a short id prefix, resolved the
     * same way every other item-taking operation resolves one.
     */
    itemId: z.string().trim().min(1).optional(),
    /** The session whose runs to list. Combines with `itemId` as AND. */
    sessionId: z.string().trim().min(1).optional(),
    /** Only runs started at or after this instant. ISO 8601. */
    since: z.string().trim().min(1).optional(),
    /**
     * Narrow to runs that do, or do not, already carry a score.
     *
     * `"no"` is the useful one and the reason this filter exists: it is
     * "what have I not judged yet", which is the question an orchestrator
     * sitting down to score its own work actually has.
     */
    scored: z.enum(["yes", "no"]).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export type ListRunsInput = z.infer<typeof inputSchema>;

/** One run, as a caller sees it. */
export interface RunSummary {
  /** The id every scoring operation asks for and nothing else would give you. */
  readonly runId: string;
  readonly itemId: string;
  readonly sessionId: string | null;
  readonly assignmentId: string;
  readonly startedAt: string;
  /** Null while the run is still open — see the note on hiding open runs below. */
  readonly endedAt: string | null;
  /** The item state these calls were attributed to. */
  readonly stateAt: string | null;
  /**
   * The model telemetry reported, VERBATIM — including the `"(unreported)"`
   * sentinel when nothing reported one.
   */
  readonly model: string;
  readonly effort: string;
  readonly toolCallCount: number;
  /** Null when the run carries the sentinel model, which has no price. */
  readonly cost: number | null;
  /**
   * The facets already carrying an agent score, so a caller can SKIP a run
   * rather than discover the write-once freeze by catching a ConflictError.
   *
   * Deliberately narrower than `scored`: a facet holding only a *person's*
   * score is still open to an agent score, so it is not frozen and is not
   * named here.
   */
  readonly scoredFacets: readonly string[];
  /**
   * True when the run carries any `RunScore` row at all, by either rater.
   *
   * This — not `scoredFacets.length > 0` — is what the `scored` filter
   * matches, and the two genuinely differ for a run a person scored but no
   * agent did. Deriving this field from `scoredFacets` would make the flag
   * disagree with the filter that selected the row, which is the kind of
   * quiet inconsistency a caller only finds by being confused by it.
   */
  readonly scored: boolean;
}

export interface ListRunsOutput {
  /** Newest first by `startedAt`. */
  readonly runs: readonly RunSummary[];
  /** True when `limit` cut the result short — there are older runs. */
  readonly truncated: boolean;
}

interface RunRow {
  id: string;
  itemId: string;
  sessionId: string | null;
  assignmentId: string;
  startedAt: Date;
  endedAt: Date | null;
  stateAt: string | null;
  model: string;
  effort: string;
  toolCallCount: number;
  cost: unknown;
  scoredFacets: string[] | null;
  scored: boolean;
}

/**
 * `Run.cost` is a Prisma `Decimal`, which serialises as an object rather
 * than a number and would reach an MCP caller as `{"s":1,"e":0,...}`.
 * Narrowed to a plain number here, with null preserved: null is meaningful
 * (a run carrying the sentinel model has no rate and therefore no cost),
 * so it must not collapse to 0.
 */
function toCost(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` carries the full reasoning.
export const listRuns = defineOperation({
  name: "list_runs",
  kind: "read",
  summary:
    "Lists the runs recorded for an item or session, newest first, with whether each is already scored. The route from an item id to the runId that `score` with action run requires.",
  contract: {
    rules: [
      {
        fields: ["itemId", "sessionId"],
        rule: "AT LEAST ONE OF `itemId` OR `sessionId` IS REQUIRED. A call giving neither is refused rather than returning every run in the database — an unfiltered read of this table is never the question anyone has, and serving it would page telemetry for the whole installation into an agent's context. Give both to intersect them.",
      },
      {
        fields: ["scored"],
        rule: "Filtering on `scored` matches ANY score row, by either rater. Each returned run also carries `scoredFacets`, which is NARROWER: it names only the facets already carrying an AGENT score, because that is the set the write-once freeze applies to. `score` with action run refuses to overwrite an agent score even with an identical value, so read `scoredFacets` to skip a spent facet rather than catching the resulting conflict. A facet holding only a person's score is still open to an agent score, and is deliberately not listed there.",
      },
      {
        fields: ["itemId", "sessionId", "since"],
        rule: 'Runs still in progress are returned like any other, carrying a null end time to say so — they are never filtered out, because hiding them would make a just-finished item look as though it had no runs at all. The model on each run is likewise reported VERBATIM and may be the sentinel "(unreported)", meaning telemetry never reported a model for that run rather than that the value is unused.',
      },
    ],
    example: {
      itemId: "b1f0c3d2-0000-4000-8000-000000000000",
      scored: "no",
      limit: 20,
    },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ListRunsInput): Promise<ListRunsOutput> {
    // Refused rather than served. An unfiltered listing is not a narrower
    // version of a useful question, it is a different and much larger one,
    // and the caller who wanted one run's id would pay for the whole table.
    if (input.itemId === undefined && input.sessionId === undefined) {
      throw new InvalidInputError(
        "list_runs needs at least one of `itemId` or `sessionId` — it will not list every run in the database.",
        { fields: ["itemId", "sessionId"] },
      );
    }

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (input.itemId !== undefined) {
      // Resolved, not trusted: the short-id prefix an agent reads off a
      // board has to work here exactly as it does on `get_item_detail`.
      //
      // Note the asymmetry this inherits, which is deliberate and is pinned
      // by tests: `resolveItemId` looks up only SHORT ids, so a mistyped
      // prefix refuses with NotFoundError, while a well-formed but unknown
      // full UUID passes straight through and simply lists nothing. That
      // matches how the other filtering reads behave — `get_run_scores`
      // returns empty aggregates for an unknown `runId` rather than
      // refusing — and keeps this operation a filter, not a lookup.
      values.push(await resolveItemId(ctx.db, input.itemId, "itemId"));
      conditions.push(`r."itemId" = $${values.length}`);
    }
    if (input.sessionId !== undefined) {
      values.push(input.sessionId);
      conditions.push(`r."sessionId" = $${values.length}`);
    }
    if (input.since !== undefined) {
      values.push(input.since);
      conditions.push(`r."startedAt" >= $${values.length}::timestamptz`);
    }
    if (input.scored === "yes") {
      conditions.push(`EXISTS (SELECT 1 FROM "RunScore" s WHERE s."runId" = r."id")`);
    } else if (input.scored === "no") {
      conditions.push(`NOT EXISTS (SELECT 1 FROM "RunScore" s WHERE s."runId" = r."id")`);
    }

    // One more than asked for, so "there are older runs" is knowable
    // without a second COUNT over the same predicate.
    values.push(input.limit + 1);
    const rows = await ctx.db.$queryRawUnsafe<RunRow[]>(
      `SELECT r."id",
              r."itemId",
              r."sessionId",
              r."assignmentId",
              r."startedAt",
              r."endedAt",
              r."stateAt"::text AS "stateAt",
              r."model",
              r."effort",
              r."toolCallCount",
              r."cost",
              -- Only facets with an agentScore: that is the column the
              -- freeze applies to, so it is the set a caller must avoid
              -- re-writing. A facet carrying only a userScore is still
              -- open to an agent score and must not be reported as frozen.
              (SELECT ARRAY_AGG(s."facet"::text ORDER BY s."facet"::text)
                 FROM "RunScore" s
                WHERE s."runId" = r."id" AND s."agentScore" IS NOT NULL) AS "scoredFacets",
              -- Any score row by any rater. Computed separately from
              -- scoredFacets above so this flag matches the scored
              -- filter exactly, including for a run only a person scored.
              EXISTS (SELECT 1 FROM "RunScore" s WHERE s."runId" = r."id") AS "scored"
         FROM "Run" r
        ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
        ORDER BY r."startedAt" DESC, r."id" DESC
        LIMIT $${values.length}`,
      ...values,
    );

    const truncated = rows.length > input.limit;
    const page = truncated ? rows.slice(0, input.limit) : rows;

    return {
      runs: page.map((row) => ({
        runId: row.id,
        itemId: row.itemId,
        sessionId: row.sessionId,
        assignmentId: row.assignmentId,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
        stateAt: row.stateAt,
        // Verbatim. `openRun` in `telemetry/runs.ts` maps this sentinel
        // BACK to null, and that is correct THERE and wrong here: it feeds
        // the boundary rule, which must treat "nothing reported" as
        // adoptable by the first genuine report. A caller of this read is
        // asking what is recorded, and "(unreported)" is the recorded fact.
        model: row.model,
        effort: row.effort,
        toolCallCount: row.toolCallCount,
        cost: toCost(row.cost),
        scoredFacets: row.scoredFacets ?? [],
        scored: row.scored,
      })),
      truncated,
    };
  },
});
