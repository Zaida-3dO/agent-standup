// Scoring an item's runs when the item completes — MILESTONES.md #67.
//
// The capture seam. `derive_run_score` can turn a review history into a
// score, but something has to CALL it on real work, and this is that
// something: `complete_item` invokes it once per completed item.
//
// ── Why completion, and not the end of each run ────────────────────────
//
// A run closes whenever the model, effort or stage changes, which happens
// several times inside one piece of work and long before any review exists.
// Scoring there would derive from an empty review history every time and
// record a null. At completion the review history is final — the item is
// not going to be reviewed again — so the signal will not change afterwards
// and the score is worth freezing.
//
// ── Best-effort, and that is a design decision rather than laziness ────
//
// Every failure here is swallowed. Completing an item is the caller's real
// work; deriving a measurement from it is bookkeeping, and bookkeeping must
// never be able to refuse a merge. This is the same fail-open posture the
// hook path takes with its own recording: a session that cannot record its
// evidence still gets its decision.
//
// The swallow is narrow, though. It catches around the scoring work only,
// so a failure in the completion itself still propagates, and it records
// nothing on the failure path rather than writing a placeholder — a run
// with no score is honestly unscored, which the reports already report.

import type { ServiceContext } from "../context";
import { deriveRunSignal, type ReviewRoundInput } from "@/lib/scoring/derived-signal";
import { declaredFacets } from "../operations/derive-run-score";

interface RunRow {
  id: string;
}

interface ArtifactRow {
  reviewRound: number;
  verdict: string | null;
}

/**
 * Derives and records an agent score for every run behind a completed item.
 *
 * Returns the ids it scored, which is what the tests assert on — a function
 * whose only observable effect is a row somewhere else is one whose failure
 * looks exactly like its success.
 */
export async function scoreCompletedRuns(
  ctx: ServiceContext,
  itemId: string,
): Promise<readonly string[]> {
  try {
    // Off by default. The mechanism ships before the judgement does, so the
    // seam is wired and dormant rather than absent — turning it on is a
    // settings change, not a deploy.
    if (ctx.settings.values["scoring.auto_derive"] !== true) return [];

    const items = await ctx.db.$queryRawUnsafe<{ difficulty: unknown }[]>(
      `SELECT "difficulty" FROM "Item" WHERE "id" = $1`,
      itemId,
    );
    const facets = declaredFacets(items[0]?.difficulty);
    if (facets.length === 0) return [];

    const artifacts = await ctx.db.$queryRawUnsafe<ArtifactRow[]>(
      `SELECT "reviewRound", "verdict"::text AS "verdict"
         FROM "Artifact"
        WHERE "itemId" = $1
          AND "kind" IN ('plan_review', 'code_review', 'visual_review')`,
      itemId,
    );
    const reviews: ReviewRoundInput[] = artifacts.map((row) => ({
      reviewRound: row.reviewRound,
      verdict: row.verdict,
    }));

    const signal = deriveRunSignal({ reviews });
    // No reviews means no evidence. Recording a score anyway would be
    // arithmetic on nothing, and a 5 derived from silence is
    // indistinguishable from a 5 derived from a clean review.
    if (signal.score === null) return [];
    const score = Math.round(signal.score);

    const runs = await ctx.db.$queryRawUnsafe<RunRow[]>(
      `SELECT "id" FROM "Run" WHERE "itemId" = $1`,
      itemId,
    );
    if (runs.length === 0) return [];

    const scored: string[] = [];
    for (const run of runs) {
      // `WHERE "agentScore" IS NULL` keeps the freeze: a run already scored
      // — by an agent, or by an earlier completion of the same item — keeps
      // the score it has.
      await ctx.db.$executeRawUnsafe(
        `INSERT INTO "RunScore" ("id", "runId", "facet", "agentScore")
         SELECT gen_random_uuid()::text, $1, f::"Facet", $3
           FROM unnest($2::text[]) AS f
         ON CONFLICT ("runId", "facet")
         DO UPDATE SET "agentScore" = EXCLUDED."agentScore"
         WHERE "RunScore"."agentScore" IS NULL`,
        run.id,
        facets,
        score,
      );
      scored.push(run.id);
    }
    return scored;
  } catch {
    // Bookkeeping never refuses the work it is measuring.
    return [];
  }
}
