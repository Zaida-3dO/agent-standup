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
// ── Derived and volunteered scores are reported apart ──────────────────
//
// Two things rate a firing: somebody who was there (`score_intervention`,
// by a person or an agent) and the server itself, which infers a score from
// what the session did next (`../telemetry/score-blocked-firings.ts`). Both
// land in one table, so selecting the score alone makes a machine's guess
// about a machine indistinguishable from a rater's verdict.
//
// That is not a cosmetic distinction. Firings accumulate on every session
// while ratings have to be volunteered, so the derived population can
// outnumber the volunteered one by any margin — and where it does, every
// aggregate here is ~entirely derived, in the very report whose purpose is
// deciding which guards to retire. An entry removed on the strength of the
// server agreeing with itself is exactly the failure the scoring work
// exists to prevent.
//
// So `mean` and `count` span everything, for the callers that read them,
// and `testimony`/`derived` carry each population's own figures beside
// them. `flaggedEvidence` then says which of the two a flag actually rests
// on, because the single question a maintainer brings to this report is
// "can I act on this", and a flag resting only on inference is a reason to
// go and look rather than a verdict.
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
  type PopulationSummary,
  type RaterPopulation,
  type ScoreDistribution,
  type ScoredFiring,
} from "../../interventions/scoring";
import { DERIVED_RATER_ID } from "../../interventions/derived-score";

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
  /**
   * The ratings a person or an agent actually made, on their own. Null when
   * nobody testified, which an entry can be for its whole life.
   */
  readonly testimony: PopulationSummary | null;
  /** The ratings the server derived from behaviour, on their own. */
  readonly derived: PopulationSummary | null;
  /**
   * What the flag rests on, when there is one.
   *
   * `testimony` — at least one person or agent rated it, so somebody stands
   * behind the flag. `derived` — every rating is the server's own inference,
   * which is a prompt to go and look rather than grounds to retire an entry.
   *
   * Stated per entry rather than left for a caller to work out from the two
   * summaries above, because working it out is exactly the step a reader
   * skips.
   */
  readonly flaggedEvidence?: "testimony" | "derived";
  /**
   * How many derived scores carried each confidence, keyed by the
   * derivation's own vocabulary (`none`, `low`, `high`). `unrecorded` counts
   * derived rows written before the confidence column existed.
   *
   * Empty when nothing was derived. A derived population that is entirely
   * `low` is a different thing from one that is entirely `high`: `low` is
   * "the session complied", which is evidence the guard was not an obstacle
   * and is not evidence it helped.
   */
  readonly derivedConfidence: Readonly<Record<string, number>>;
}

export interface GetInterventionScoresOutput {
  readonly entries: readonly InterventionEntryReport[];
  /** The flagged entries, worst first — the list this report exists for. */
  readonly flagged: readonly string[];
  readonly totalFirings: number;
  readonly totalRated: number;
  /**
   * How many of `totalRated` came from each population.
   *
   * Where derived scores outnumber volunteered ones, `totalRated` alone
   * reads as a corpus of judgements when it is a corpus of inferences —
   * and this report's purpose is deciding which guards to retire.
   */
  readonly totalTestimony: number;
  readonly totalDerived: number;
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
  rater_type: string;
  rater_id: string | null;
  confidence: string | null;
}

/**
 * Which population a stored row belongs to.
 *
 * A derived score is an `agent` row under the reserved `DERIVED_RATER_ID`
 * (`../../interventions/derived-score.ts`), which is exactly why that id was
 * reserved: it keeps a derivation's row from ever occupying the slot a real
 * agent's own answer would take, and it is the only thing in the table that
 * distinguishes the two after the fact.
 */
function populationOf(row: ScoreRow): RaterPopulation {
  if (row.rater_type === "agent" && row.rater_id === DERIVED_RATER_ID) return "derived";
  return row.rater_type === "person" ? "person" : "agent";
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

    // `rater_type` and `rater_id` are selected because who rated a firing is
    // the difference between a judgement and an inference, and this report
    // is read to decide which guards to retire. Selecting only the score
    // made a machine's guess about a machine indistinguishable from a
    // rater's verdict — in the one report where that distinction decides
    // whether an entry survives.
    const scoreRows = await ctx.db.$queryRawUnsafe<ScoreRow[]>(
      `SELECT e."entry_id",
              s."score",
              s."note",
              s."rater_type"::text AS "rater_type",
              s."rater_id",
              s."confidence"
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
      population: populationOf(row),
      ...(row.note === null ? {} : { note: row.note }),
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
    }));

    // Derived confidence, tallied per entry. Counted from the rows rather
    // than from the summaries because `summariseScores` is deliberately
    // arithmetic over the scale alone — confidence is a property of how a
    // score was arrived at, not a point on the owner's scale, and pushing it
    // into the pure aggregate would make that module answer a question about
    // provenance it has no business holding.
    const confidenceByEntry = new Map<string, Record<string, number>>();
    for (const row of scoreRows) {
      if (populationOf(row) !== "derived") continue;
      const tally = confidenceByEntry.get(row.entry_id) ?? {};
      // A derived row predating the confidence column is counted as
      // `unrecorded` rather than dropped or folded into `none`. `none` is a
      // thing the derivation said; this is the absence of anything said.
      const key = row.confidence ?? "unrecorded";
      tally[key] = (tally[key] ?? 0) + 1;
      confidenceByEntry.set(row.entry_id, tally);
    }

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
      const testimony = summary?.testimony ?? null;
      return {
        entryId: row.entry_id,
        firings: Number(row.firings),
        rated: Number(row.rated),
        mean: summary === undefined ? null : summary.mean,
        distribution: summary?.distribution ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        removalSignals: summary?.removalSignals ?? 0,
        unhelpful: summary?.unhelpful ?? 0,
        notes: summary?.notes ?? [],
        testimony,
        derived: summary?.derived ?? null,
        derivedConfidence: confidenceByEntry.get(row.entry_id) ?? {},
        ...(reason === undefined ? {} : { flaggedReason: reason }),
        // Only stated where there is a flag to qualify. A reader scanning
        // for this field is asking "should I act on this one", and answering
        // it on entries that were never flagged would put the word
        // "derived" beside entries nothing is claiming anything about.
        ...(reason === undefined
          ? {}
          : {
              flaggedEvidence: testimony === null ? ("derived" as const) : ("testimony" as const),
            }),
      };
    });

    return {
      entries,
      flagged: flagged.map((entry) => entry.entryId),
      totalFirings: entries.reduce((sum, entry) => sum + entry.firings, 0),
      totalRated: entries.reduce((sum, entry) => sum + entry.rated, 0),
      // Summed from the per-entry summaries rather than from `scoreRows`, so
      // these agree with what the entries report: `summariseScores` drops
      // scores outside the scale, and a total counted from raw rows would
      // exceed the sum of the entries by exactly the invalid ones.
      totalTestimony: entries.reduce((sum, entry) => sum + (entry.testimony?.count ?? 0), 0),
      totalDerived: entries.reduce((sum, entry) => sum + (entry.derived?.count ?? 0), 0),
    };
  },
});
