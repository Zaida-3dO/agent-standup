// `accept_run_score` — agreeing with what the agent said about its own run.
//
// The other half of MILESTONES.md #66. Accepting COPIES the agent score
// into the user score rather than leaving it empty, which is what makes a
// null `user_score` mean exactly one thing.
//
// ── Why a copy and not an absence ──────────────────────────────────────
//
// SCHEMA.md §12: with a copy, `user_score = null` means "nobody looked",
// `user_score = agent_score` means "looked and agreed", and a different
// value means "looked and corrected". Leaving accept as a no-op would
// collapse the first two, and those are opposite data points — the learning
// signal would then be built only from the runs somebody objected to, which
// biases it toward failure by construction.
//
// Delta analysis is unchanged by this: agreement is a delta of zero.
//
// ── What it refuses ────────────────────────────────────────────────────
//
// Accepting a facet the agent never scored. There is nothing to copy, and
// writing a null user score would record an act of judgement that did not
// happen. That is a `not found` rather than a silent skip, because a UI
// offering "accept" for a facet with no agent score is itself the bug.

import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { FACETS } from "../../scoring/run-scores";

const inputSchema = z
  .object({
    runId: z.string().trim().min(1),
    /**
     * Which facets are being accepted. Omitted means every facet on the run
     * that carries an agent score and no user score — the "accept all"
     * the since-your-last-visit card needs, expressed without making the
     * caller enumerate what it just read.
     */
    facets: z.array(z.enum(FACETS)).min(1).max(FACETS.length).optional(),
    /** The person accepting. Recorded in `user_scored_by`. */
    raterId: z.string().trim().min(1),
  })
  .strict();

export type AcceptRunScoreInput = z.infer<typeof inputSchema>;

export interface AcceptRunScoreOutput {
  readonly runId: string;
  readonly accepted: readonly { readonly facet: string; readonly score: number }[];
}

interface AcceptedRow {
  facet: string;
  user_score: number;
}

// Stryker disable all : module-level metadata read into the registry at
// import, before any test body runs. See
// `scripts/check-operation-metadata-mutants.mjs`.
export const acceptRunScore = defineOperation({
  name: "accept_run_score",
  kind: "write",
  summary: "Copies the agent score to the user score, recording agreement rather than silence.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: AcceptRunScoreInput): Promise<AcceptRunScoreOutput> {
    const runs = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Run" WHERE "id" = $1`,
      input.runId,
    );
    if (runs[0] === undefined) {
      throw new NotFoundError("No run with id " + input.runId + ".", { fields: ["runId"] });
    }

    if (input.facets !== undefined) {
      const seen = new Set<string>();
      for (const facet of input.facets) {
        if (seen.has(facet)) {
          throw new InvalidInputError("Facet " + facet + " is listed twice.", {
            fields: ["facets"],
          });
        }
        seen.add(facet);
      }
    }

    // `agentScore IS NOT NULL` is the whole condition: there is nothing to
    // copy otherwise. An already-accepted facet is copied again, which is
    // harmless and idempotent — the value is the same — but refreshes
    // `userScoredAt`, and §12 says the timestamp carries weight.
    const rows =
      input.facets === undefined
        ? await ctx.db.$queryRawUnsafe<AcceptedRow[]>(
            `UPDATE "RunScore"
                SET "userScore" = "agentScore",
                    "userScoredBy" = $2,
                    "userScoredAt" = now()
              WHERE "runId" = $1
                AND "agentScore" IS NOT NULL
                AND "userScore" IS NULL
              RETURNING "facet"::text AS "facet", "userScore" AS "user_score"`,
            input.runId,
            input.raterId,
          )
        : await ctx.db.$queryRawUnsafe<AcceptedRow[]>(
            `UPDATE "RunScore"
                SET "userScore" = "agentScore",
                    "userScoredBy" = $2,
                    "userScoredAt" = now()
              WHERE "runId" = $1
                AND "agentScore" IS NOT NULL
                AND "facet" = ANY($3::"Facet"[])
              RETURNING "facet"::text AS "facet", "userScore" AS "user_score"`,
            input.runId,
            input.raterId,
            input.facets,
          );

    // An explicit facet list that matched nothing is a caller error: it
    // asked to accept a judgement that does not exist. An unfiltered accept
    // matching nothing is just a run with nothing outstanding.
    if (rows.length === 0 && input.facets !== undefined) {
      throw new NotFoundError(
        "No agent score to accept on run " +
          input.runId +
          " for the requested facets — there is nothing to copy.",
        { fields: ["facets"] },
      );
    }

    return {
      runId: input.runId,
      accepted: rows.map((row) => ({ facet: row.facet, score: row.user_score })),
    };
  },
});
