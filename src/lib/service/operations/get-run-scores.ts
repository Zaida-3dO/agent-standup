// `get_run_scores` — what the scores say about how work is going.
//
// The read over MILESTONES.md #66 and #67. Rolls scores up per facet, names
// the facets worth attention, and reports the runs that were never scored
// at all — because a report that silently dropped them would read as
// "everything is fine" when the truth is that nothing was ever judged.
//
// ── The aggregate is computed in TypeScript, not SQL ───────────────────
//
// `summariseRunScores` and `flagFacetsForReview` are pure, tested against
// literal arrays, and hold the definition of "worth attention". Expressing
// the same thresholds as a `HAVING` clause would put that definition in two
// places no test compares, and the SQL copy is the one that drifts — it is
// the copy nobody reads when changing the rule.
//
// This is a report a maintainer reads occasionally, not a hot path, so
// pulling the scored rows back is the right trade for one definition.

import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  flagFacetsForReview,
  summariseRunScores,
  type Facet,
  type FacetScoreSummary,
  type RunFacetScore,
} from "../../scoring/run-scores";

const inputSchema = z
  .object({
    /** Only runs started at or after this instant. ISO 8601. */
    since: z.string().trim().min(1).optional(),
    /** Restrict to one run. */
    runId: z.string().trim().min(1).optional(),
    /** Restrict to runs served by one model, for comparing tiers. */
    model: z.string().trim().min(1).optional(),
    /**
     * Which score an aggregate reads. `effective` prefers a person's
     * judgement and falls back to the agent's, which is the reading the
     * picker wants.
     */
    source: z.enum(["agent", "user", "effective"]).optional(),
    /** Minimum scores before a facet can be flagged. */
    threshold: z.number().int().positive().optional(),
  })
  .strict();

export type GetRunScoresInput = z.infer<typeof inputSchema>;

export interface GetRunScoresOutput {
  readonly facets: readonly FacetScoreSummary[];
  /** The flagged facets, worst first — the list this report exists for. */
  readonly flagged: readonly { readonly facet: string; readonly reason: string }[];
  /** Runs in the window that carry no score at all. */
  readonly unscoredRuns: number;
  readonly scoredRuns: number;
}

interface ScoreRow {
  facet: string;
  agent_score: number | null;
  user_score: number | null;
}

interface CountRow {
  scored: bigint;
  total: bigint;
}

// Stryker disable all : module-level metadata read into the registry at
// import, before any test body runs. See
// `scripts/check-operation-metadata-mutants.mjs`.
export const getRunScores = defineOperation({
  name: "get_run_scores",
  kind: "read",
  summary: "Aggregates run scores per facet, keeping the distribution and flagging the outliers.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetRunScoresInput): Promise<GetRunScoresOutput> {
    const since = input.since ?? null;
    const runId = input.runId ?? null;
    const model = input.model ?? null;

    const scoreRows = await ctx.db.$queryRawUnsafe<ScoreRow[]>(
      `SELECT s."facet"::text AS "facet",
              s."agentScore"  AS "agent_score",
              s."userScore"   AS "user_score"
         FROM "RunScore" s
         JOIN "Run" r ON r."id" = s."runId"
        WHERE ($1::timestamptz IS NULL OR r."startedAt" >= $1::timestamptz)
          AND ($2::text IS NULL OR r."id" = $2)
          AND ($3::text IS NULL OR r."model" = $3)`,
      since,
      runId,
      model,
    );

    const counts = await ctx.db.$queryRawUnsafe<CountRow[]>(
      `SELECT COUNT(DISTINCT s."runId")::bigint AS "scored",
              COUNT(DISTINCT r."id")::bigint    AS "total"
         FROM "Run" r
         LEFT JOIN "RunScore" s ON s."runId" = r."id"
        WHERE ($1::timestamptz IS NULL OR r."startedAt" >= $1::timestamptz)
          AND ($2::text IS NULL OR r."id" = $2)
          AND ($3::text IS NULL OR r."model" = $3)`,
      since,
      runId,
      model,
    );

    const rows: RunFacetScore[] = scoreRows.map((row) => ({
      facet: row.facet as Facet,
      agentScore: row.agent_score,
      userScore: row.user_score,
    }));

    const facets = summariseRunScores(rows, input.source ?? "effective");
    const flagged = flagFacetsForReview(
      facets,
      input.threshold === undefined ? {} : { threshold: input.threshold },
    );

    const count = counts[0];
    const scoredRuns = count === undefined ? 0 : Number(count.scored);
    const totalRuns = count === undefined ? 0 : Number(count.total);

    return {
      facets,
      flagged: flagged.map((entry) => ({ facet: entry.facet, reason: entry.reason })),
      scoredRuns,
      // Reported rather than inferred: "no scores yet" and "all scores are
      // good" are opposite states and a reader must be able to tell them
      // apart at a glance.
      unscoredRuns: totalRuns - scoredRuns,
    };
  },
});
