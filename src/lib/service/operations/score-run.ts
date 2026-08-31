// `score_run` — recording how a run went, per facet.
//
// The write half of MILESTONES.md #66. One call carries every facet scored
// for one run, because the facets of a single run are decided together and
// a round trip per facet would be four writes to say one thing.
//
// ── The freeze is enforced twice, and the second one is the real one ───
//
// `checkAgentScoreWritable` refuses an overwrite in the parser, which is
// what gives a caller a usable error. But two concurrent calls both reading
// "no score yet" would both pass that check, so the INSERT carries
// `WHERE "agentScore" IS NULL` and the operation treats "no row updated" as
// the refusal. The parser check is the good error message; the conditional
// write is the guarantee.
//
// That is the same doubling `score_intervention` applies to its 1-5 range,
// and for a stronger reason: an agent score is the only copy of what the
// agent thought, and a lost overwrite race would destroy it silently.
//
// ── Two ways to write a user score, and they are not the same act ──────
//
// `accept` copies the agent's score to the person's. `set` writes a number
// the person chose. SCHEMA.md §12 records both as `user_score`, so the
// stored row cannot tell them apart — an accepted loss, stated there — but
// they are different calls here so a caller cannot accidentally accept by
// omitting a score, and so the operation can refuse to accept a facet the
// agent never scored.

import { z } from "zod";
import { ConflictError, InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  FACETS,
  MAX_RUN_SCORE,
  MIN_RUN_SCORE,
  checkAgentScoreWritable,
} from "../../scoring/run-scores";

const facetScoreSchema = z
  .object({
    facet: z.enum(FACETS),
    score: z.number().int().min(MIN_RUN_SCORE).max(MAX_RUN_SCORE),
  })
  .strict();

const inputSchema = z
  .object({
    /** The `runs` row being scored. */
    runId: z.string().trim().min(1),
    /**
     * Who is scoring, and therefore which column is written.
     *
     * `agent` writes the frozen self-assessment. `person` writes the human
     * judgement beside it, which may disagree and must not overwrite.
     */
    raterType: z.enum(["agent", "person"]),
    /**
     * Required when `raterType` is `person`: a person id for
     * `user_scored_by`. Two people may judge the same work differently and
     * collapsing them loses that (SCHEMA.md §12).
     */
    raterId: z.string().trim().min(1).optional(),
    /**
     * One entry per facet scored. Only facets the item declared should be
     * sent; nothing here invents a score for a facet nobody judged.
     */
    scores: z.array(facetScoreSchema).min(1).max(FACETS.length),
  })
  .strict();

export type ScoreRunInput = z.infer<typeof inputSchema>;

export interface ScoreRunOutput {
  readonly runId: string;
  readonly scored: readonly {
    readonly facet: string;
    readonly agentScore: number | null;
    readonly userScore: number | null;
  }[];
}

interface ScoreRow {
  facet: string;
  agent_score: number | null;
  user_score: number | null;
}

// Stryker disable all : module-level metadata read into the registry at
// import, before any test body runs — a mutation here is unkillable by
// construction rather than untested. See
// `scripts/check-operation-metadata-mutants.mjs`.
export const scoreRun = defineOperation({
  name: "score_run",
  kind: "write",
  summary: "Records how a run went per facet. The agent score is frozen once written.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ScoreRunInput): Promise<ScoreRunOutput> {
    if (input.raterType === "person" && input.raterId === undefined) {
      throw new InvalidInputError(
        "raterId is required when raterType is person — a user score records WHO made it, " +
          "because two people may judge the same work differently.",
        { fields: ["raterId"] },
      );
    }

    // Duplicate facets in one call would make the result depend on
    // statement order, and one of the two scores would be silently lost.
    const seen = new Set<string>();
    for (const entry of input.scores) {
      if (seen.has(entry.facet)) {
        throw new InvalidInputError("Facet " + entry.facet + " is scored twice in the same call.", {
          fields: ["scores"],
        });
      }
      seen.add(entry.facet);
    }

    const runs = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Run" WHERE "id" = $1`,
      input.runId,
    );
    if (runs[0] === undefined) {
      throw new NotFoundError("No run with id " + input.runId + ".", { fields: ["runId"] });
    }

    const scored: ScoreRow[] = [];

    for (const entry of input.scores) {
      if (input.raterType === "agent") {
        const existing = await ctx.db.$queryRawUnsafe<{ agentScore: number | null }[]>(
          `SELECT "agentScore" FROM "RunScore" WHERE "runId" = $1 AND "facet" = $2::"Facet"`,
          input.runId,
          entry.facet,
        );
        // The parser check, for the error message a caller can act on.
        const refusal = checkAgentScoreWritable(existing[0] ?? null, entry.score);
        if (refusal !== null) {
          if (refusal.kind === "frozen") {
            throw new ConflictError(refusal.message, { fields: ["scores"] });
          }
          throw new InvalidInputError(refusal.message, { fields: ["scores"] });
        }

        // The guarantee. `WHERE "agentScore" IS NULL` on the conflict
        // update means two concurrent first-writes cannot both land: the
        // loser updates no row, and is reported as the refusal it is
        // rather than silently overwriting the winner.
        const rows = await ctx.db.$queryRawUnsafe<ScoreRow[]>(
          `INSERT INTO "RunScore" ("id", "runId", "facet", "agentScore")
           VALUES (gen_random_uuid()::text, $1, $2::"Facet", $3)
           ON CONFLICT ("runId", "facet")
           DO UPDATE SET "agentScore" = EXCLUDED."agentScore"
           WHERE "RunScore"."agentScore" IS NULL
           RETURNING "facet"::text AS "facet", "agentScore" AS "agent_score", "userScore" AS "user_score"`,
          input.runId,
          entry.facet,
          entry.score,
        );
        const row = rows[0];
        if (row === undefined) {
          throw new ConflictError(
            "An agent score for facet " +
              entry.facet +
              " was written concurrently and is immutable. Record a user score instead.",
            { fields: ["scores"] },
          );
        }
        scored.push(row);
        continue;
      }

      // A person's score. Freely rewritable: a person correcting their own
      // judgement is not the thing being preserved, and SCHEMA.md §12 puts
      // weight on WHEN it was written, so the timestamp moves with it.
      const rows = await ctx.db.$queryRawUnsafe<ScoreRow[]>(
        `INSERT INTO "RunScore" ("id", "runId", "facet", "userScore", "userScoredBy", "userScoredAt")
         VALUES (gen_random_uuid()::text, $1, $2::"Facet", $3, $4, now())
         ON CONFLICT ("runId", "facet")
         DO UPDATE SET "userScore" = EXCLUDED."userScore",
                       "userScoredBy" = EXCLUDED."userScoredBy",
                       "userScoredAt" = now()
         RETURNING "facet"::text AS "facet", "agentScore" AS "agent_score", "userScore" AS "user_score"`,
        input.runId,
        entry.facet,
        entry.score,
        input.raterId ?? null,
      );
      scored.push(rows[0]!);
    }

    return {
      runId: input.runId,
      scored: scored.map((row) => ({
        facet: row.facet,
        agentScore: row.agent_score,
        userScore: row.user_score,
      })),
    };
  },
});
