// `get_intervention_scores` — what the catalogue is actually worth.
//
// The read half of the evidence loop. Rolls every score up per catalogue
// entry and names the ones a maintainer should look at, which is the whole
// point: *"that way we can evaluate them over time and see what's really
// helpful."*
//
// ── Entries with no scores are reported, not omitted ───────────────────
//
// An entry that has fired and never been rated is a distinct and
// interesting state, and a report that silently dropped it would read as
// "every entry is fine". It is the difference between an entry nobody
// minded and an entry nobody was ever asked about — and the second is a gap
// in the loop rather than a verdict on the entry.
//
// ── The aggregate is computed in TypeScript, not SQL ───────────────────
//
// `summariseScores` and `flagEntriesForReview` already exist, are pure, and
// are tested against literal arrays. Re-expressing the same thresholds as a
// `HAVING` clause would put the definition of "unhelpful" in two places
// that no test compares, and the SQL copy is the one that would drift —
// it is the copy nobody reads when changing the rule.
//
// This is a report read occasionally by a maintainer, not a hot path, so
// the cost of pulling scored rows back is the right trade for keeping one
// definition of the verdict.

import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  flagEntriesForReview,
  summariseScores,
  type EntryScoreSummary,
  type ScoreDistribution,
  type ScoredFiring,
} from "../../interventions/scoring";

const inputSchema = z
  .object({
    /** Only score firings at or after this instant. ISO 8601. */
    since: z.string().trim().min(1).optional(),
    /** Restrict to one catalogue entry, e.g. `I10`. */
    entryId: z.string().trim().min(1).optional(),
    /**
     * Minimum ratings before an entry can be flagged. Defaults to
     * `DEFAULT_REVIEW_THRESHOLD`; exposed because an installation with more
     * traffic can afford to demand more evidence before acting.
     */
    threshold: z.number().int().positive().optional(),
  })
  .strict();

export type GetInterventionScoresInput = z.infer<typeof inputSchema>;

/** One entry's standing, including entries nothing has rated. */
export interface InterventionEntryReport {
  readonly entryId: string;
  /** How many times it fired in the window. */
  readonly firings: number;
  /** How many of those have been rated. */
  readonly rated: number;
  /** Null when nothing has rated it — distinct from a mean of zero. */
  readonly mean: number | null;
  readonly distribution: ScoreDistribution;
  readonly removalSignals: number;
  readonly unhelpful: number;
  readonly notes: readonly string[];
  /** Set when the scores say a maintainer should look at this entry. */
  readonly flaggedReason?: string;
}

export interface GetInterventionScoresOutput {
  readonly entries: readonly InterventionEntryReport[];
  /** The flagged entries, worst first — the list this report exists for. */
  readonly flagged: readonly string[];
  readonly totalFirings: number;
  readonly totalRated: number;
}

interface FiringRow {
  entry_id: string;
  firings: bigint;
  rated: bigint;
}

interface ScoreRow {
  entry_id: string;
  score: number;
  note: string | null;
}

// Stryker disable all : module-level metadata read into the registry at
// import, before any test body runs. See
// `scripts/check-operation-metadata-mutants.mjs`.
export const getInterventionScores = defineOperation({
  name: "get_intervention_scores",
  kind: "read",
  summary: "Aggregates intervention scores per catalogue entry and flags persistent 1s and 2s.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: GetInterventionScoresInput,
  ): Promise<GetInterventionScoresOutput> {
    // An invalid `since` is refused by Postgres rather than silently
    // becoming "all time" — a window that quietly widened would report a
    // retired entry's historical scores as current.
    const since = input.since ?? null;
    const entryId = input.entryId ?? null;

    const firingRows = await ctx.db.$queryRawUnsafe<FiringRow[]>(
      `SELECT e."entry_id",
              COUNT(*) AS "firings",
              COUNT(s."id") AS "rated"
         FROM "intervention_events" e
         LEFT JOIN "intervention_scores" s ON s."event_id" = e."id"
        WHERE ($1::timestamptz IS NULL OR e."ts" >= $1::timestamptz)
          AND ($2::text IS NULL OR e."entry_id" = $2::text)
        GROUP BY e."entry_id"
        ORDER BY e."entry_id"`,
      since,
      entryId,
    );

    const scoreRows = await ctx.db.$queryRawUnsafe<ScoreRow[]>(
      `SELECT e."entry_id", s."score", s."note"
         FROM "intervention_scores" s
         JOIN "intervention_events" e ON e."id" = s."event_id"
        WHERE ($1::timestamptz IS NULL OR e."ts" >= $1::timestamptz)
          AND ($2::text IS NULL OR e."entry_id" = $2::text)
        ORDER BY s."rated_at"`,
      since,
      entryId,
    );

    const scored: ScoredFiring[] = scoreRows.map((row) => ({
      entryId: row.entry_id,
      score: row.score,
      ...(row.note === null ? {} : { note: row.note }),
    }));

    const summaries = summariseScores(scored);
    const byEntry = new Map<string, EntryScoreSummary>(
      summaries.map((summary) => [summary.entryId, summary]),
    );

    const options = input.threshold === undefined ? {} : { threshold: input.threshold };
    const flagged = flagEntriesForReview(summaries, options);
    const reasonByEntry = new Map(flagged.map((entry) => [entry.entryId, entry.reason]));

    const entries: InterventionEntryReport[] = firingRows.map((row) => {
      const summary = byEntry.get(row.entry_id);
      const reason = reasonByEntry.get(row.entry_id);
      return {
        entryId: row.entry_id,
        firings: Number(row.firings),
        rated: Number(row.rated),
        mean: summary === undefined ? null : summary.mean,
        distribution: summary?.distribution ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        removalSignals: summary?.removalSignals ?? 0,
        unhelpful: summary?.unhelpful ?? 0,
        notes: summary?.notes ?? [],
        ...(reason === undefined ? {} : { flaggedReason: reason }),
      };
    });

    return {
      entries,
      flagged: flagged.map((entry) => entry.entryId),
      totalFirings: entries.reduce((sum, entry) => sum + entry.firings, 0),
      totalRated: entries.reduce((sum, entry) => sum + entry.rated, 0),
    };
  },
});
