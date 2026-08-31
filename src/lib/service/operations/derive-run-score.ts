// `derive_run_score` — the capture seam: scoring a run from what happened.
//
// MILESTONES.md #67, and the answer to the failure this milestone was
// written to avoid. `score_run` can record a judgement, but something has
// to MAKE one, and a scoring system whose only writer is a test accumulates
// zero rows forever. `score_intervention` is the worked example: it has no
// caller outside its own definition, so the tables it feeds stay empty
// however sound its schema is.
//
// So this operation is the writer. It reads the review artifacts an item
// already has, derives a signal with `deriveRunSignal`, and records it as
// the agent score on every facet the item declared. Nothing is invented:
// each input is a row `record_artifact` wrote at review time.
//
// ── It ships switched off ──────────────────────────────────────────────
//
// `scoring.auto_derive` defaults to false, and with it off the operation
// still runs, still reports what it WOULD write, and writes nothing. That
// is the milestone's "ships switched off" taken literally, and it is more
// useful than refusing outright: the mechanism can be exercised against
// real items before any row is committed, which is the only way to find out
// whether the derivation is sane before it starts filling a table.
//
// ── Why the agent column and not the user column ───────────────────────
//
// A derived score is the system's own assessment, which is exactly what
// `agent_score` means — and it is frozen for the same reason a crew's
// self-assessment is: a person who disagrees writes their score beside it,
// and the delta is the measurement. Writing a derived figure into
// `user_score` would fabricate a human judgement nobody made.
//
// ── Facets come from the item, never from a default ────────────────────
//
// Only facets the item declared in `difficulty` are scored. An item that
// declared none yields nothing, reported as such: inventing a facet would
// put a score against a dimension nobody claimed the work exercised, and
// the aggregate is per facet, so one invented row skews that facet for
// every future comparison.

import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { deriveRunSignal, type ReviewRoundInput } from "../../scoring/derived-signal";
import { isFacet, isValidRunScore, type Facet } from "../../scoring/run-scores";

const inputSchema = z
  .object({
    /** The run being scored. */
    runId: z.string().trim().min(1),
    /**
     * Write even when `scoring.auto_derive` is off. For an operator
     * deliberately backfilling a run by hand; the setting governs the
     * automatic path, not a considered manual one.
     */
    force: z.boolean().optional(),
  })
  .strict();

export type DeriveRunScoreInput = z.infer<typeof inputSchema>;

export interface DeriveRunScoreOutput {
  readonly runId: string;
  readonly itemId: string;
  /** Null when the run has no reviews to derive from. */
  readonly score: number | null;
  readonly confidence: string;
  readonly rounds: number;
  readonly reasons: readonly string[];
  /** The facets a score was written to, empty when nothing was written. */
  readonly written: readonly string[];
  /**
   * Facets that already carried a frozen agent score and were left alone.
   * Reported rather than silent: a run scored twice is a caller repeating
   * itself, and it should be able to see that it did.
   */
  readonly alreadyScored: readonly string[];
  /** False when the setting is off and nothing was committed. */
  readonly applied: boolean;
}

interface RunRow {
  itemId: string;
}

interface ArtifactRow {
  reviewRound: number;
  verdict: string | null;
}

interface ExistingRow {
  facet: string;
}

/**
 * The facets an item declared, read from `difficulty`.
 *
 * Unrecognised keys are dropped rather than trusted: `difficulty` is a JSON
 * column, so nothing at the database level stops a caller writing a facet
 * name the enum does not have, and passing one through would fail the
 * insert with a cast error that reads as a server fault.
 */
export function declaredFacets(difficulty: unknown): Facet[] {
  if (difficulty === null || typeof difficulty !== "object" || Array.isArray(difficulty)) {
    return [];
  }
  const facets: Facet[] = [];
  for (const [key, value] of Object.entries(difficulty as Record<string, unknown>)) {
    // The VALUE is the declared difficulty, not a score, but it shares the
    // 1-5 scale and an out-of-range one means the map is not what this
    // reader thinks it is — so the key is not trusted either.
    if (isFacet(key) && isValidRunScore(value)) facets.push(key);
  }
  return facets;
}

// Stryker disable all : module-level metadata read into the registry at
// import, before any test body runs. See
// `scripts/check-operation-metadata-mutants.mjs`.
export const deriveRunScore = defineOperation({
  name: "derive_run_score",
  kind: "write",
  summary: "Derives a run score from its review history and records it as the agent score.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: DeriveRunScoreInput): Promise<DeriveRunScoreOutput> {
    const runs = await ctx.db.$queryRawUnsafe<RunRow[]>(
      `SELECT "itemId" FROM "Run" WHERE "id" = $1`,
      input.runId,
    );
    const run = runs[0];
    if (run === undefined) {
      throw new NotFoundError("No run with id " + input.runId + ".", { fields: ["runId"] });
    }

    // Only the kinds that carry a verdict. A `commit` or a `screenshot` is
    // not a round of review, and counting one would report work as more
    // heavily reviewed than it was.
    const artifacts = await ctx.db.$queryRawUnsafe<ArtifactRow[]>(
      `SELECT "reviewRound", "verdict"::text AS "verdict"
         FROM "Artifact"
        WHERE "itemId" = $1
          AND "kind" IN ('plan_review', 'code_review', 'visual_review')`,
      run.itemId,
    );

    const reviews: ReviewRoundInput[] = artifacts.map((row) => ({
      reviewRound: row.reviewRound,
      verdict: row.verdict,
    }));
    const signal = deriveRunSignal({ reviews });

    const items = await ctx.db.$queryRawUnsafe<{ difficulty: unknown }[]>(
      `SELECT "difficulty" FROM "Item" WHERE "id" = $1`,
      run.itemId,
    );
    const facets = declaredFacets(items[0]?.difficulty);

    const enabled = ctx.settings.values["scoring.auto_derive"] === true;
    const applied = enabled || input.force === true;

    // Nothing to record: no score derivable, or no facet declared to record
    // it against. Both are reported rather than treated as failures — a run
    // with no reviews is a normal run, not a broken one.
    if (signal.score === null || facets.length === 0 || !applied) {
      return {
        runId: input.runId,
        itemId: run.itemId,
        score: signal.score,
        confidence: signal.confidence,
        rounds: signal.rounds,
        reasons: signal.reasons,
        written: [],
        alreadyScored: [],
        applied: false,
      };
    }

    // The derived value is rounded to the scale it is stored on. The column
    // is an integer and the derivation is fractional by design — half a
    // point per extra round — so rounding happens once, here, rather than
    // being left to whatever the driver does with a non-integer.
    const score = Math.round(signal.score);

    // `WHERE "agentScore" IS NULL` for the same reason `score_run` carries
    // it: a derived score must not overwrite one already frozen, whether
    // that one came from an agent or from an earlier derivation.
    const written = await ctx.db.$queryRawUnsafe<ExistingRow[]>(
      `INSERT INTO "RunScore" ("id", "runId", "facet", "agentScore")
       SELECT gen_random_uuid()::text, $1, f::"Facet", $3
         FROM unnest($2::text[]) AS f
       ON CONFLICT ("runId", "facet")
       DO UPDATE SET "agentScore" = EXCLUDED."agentScore"
       WHERE "RunScore"."agentScore" IS NULL
       RETURNING "facet"::text AS "facet"`,
      input.runId,
      facets,
      score,
    );

    const writtenFacets = new Set(written.map((row) => row.facet));
    return {
      runId: input.runId,
      itemId: run.itemId,
      score,
      confidence: signal.confidence,
      rounds: signal.rounds,
      reasons: signal.reasons,
      written: [...writtenFacets],
      alreadyScored: facets.filter((facet) => !writtenFacets.has(facet)),
      applied: true,
    };
  },
});
