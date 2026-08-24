// `score_intervention` — recording what an intervention was actually worth.
//
// The write half of the evidence loop described in
// `src/lib/interventions/scoring.ts`. A session that hit a guard answers the
// session-end survey; each answer lands here as one row.
//
// ── Upsert, not insert, and why that is the safe direction ─────────────
//
// One score per rater per firing, enforced by a unique index. A rater
// answering again updates its own row rather than adding a second, which
// is what stops one rater moving an aggregate by voting twice — and the
// aggregate is the entire product of this table.
//
// The alternative, refusing a second answer, was rejected: a survey reply
// that is retried after a transport failure would then either fail loudly
// on work that had already succeeded, or leave the caller unable to tell a
// duplicate from a rejection. An upsert makes the call idempotent, which is
// the property a hook path needs most.
//
// ── The scale is validated here as well as in the database ─────────────
//
// `isValidInterventionScore` and a `CHECK` constraint both enforce 1–5.
// That is deliberate duplication of the kind the codebase already accepts
// for the `post`-cannot-block invariant: a score outside the scale skews
// every aggregate silently, and this is the one table where a bad row does
// not announce itself. Validating in the parser gives the caller a usable
// error; the constraint means no route into the table can bypass it.

import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { MAX_INTERVENTION_SCORE, MIN_INTERVENTION_SCORE } from "../../interventions/scoring";

const inputSchema = z
  .object({
    /** The `intervention_events` row being rated. */
    eventId: z.string().trim().min(1),
    /**
     * The score, 1–5. The meanings are the owner's and live in
     * `INTERVENTION_SCORE_MEANINGS` — a caller rendering its own scale
     * would drift from the stored definition invisibly.
     */
    score: z.number().int().min(MIN_INTERVENTION_SCORE).max(MAX_INTERVENTION_SCORE),
    /**
     * Who is rating. An agent rating its own session's firings, or a person
     * reviewing them later. Kept apart because they answer differently and
     * a mean over both would hide the disagreement worth seeing.
     */
    raterType: z.enum(["agent", "person"]),
    /** A session id for an agent, a person id for a person. */
    raterId: z.string().trim().min(1).optional(),
    /**
     * One line, optional. Worth having on a low score: a 1 or a 2 can mean
     * the detection was wrong, or that it was right and the message did not
     * say what to do next — and only the second is fixed by rewording.
     */
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ScoreInterventionInput = z.infer<typeof inputSchema>;

export interface ScoreInterventionOutput {
  readonly id: string;
  readonly eventId: string;
  readonly entryId: string;
  readonly score: number;
  readonly raterType: string;
  readonly ratedAt: string;
}

interface ScoreRow {
  id: string;
  event_id: bigint;
  entry_id: string;
  score: number;
  rater_type: string;
  rated_at: Date;
}

// Stryker disable all : module-level metadata read into the registry at
// import, before any test body runs — a mutation here is unkillable by
// construction rather than untested. See
// `scripts/check-operation-metadata-mutants.mjs`.
export const scoreIntervention = defineOperation({
  name: "score_intervention",
  kind: "write",
  summary: "Records a 1-5 score for one intervention firing, so unhelpful guards can be found.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: ScoreInterventionInput,
  ): Promise<ScoreInterventionOutput> {
    // `eventId` arrives as a string because the wire has no bigint, but the
    // column is a BIGSERIAL. Parsed rather than passed through: a
    // non-numeric id would otherwise reach Postgres as a cast error, which
    // reports as an internal failure rather than as the caller's mistake.
    if (!/^\d+$/.test(input.eventId)) {
      throw new InvalidInputError(
        `eventId must be a numeric id, got ${JSON.stringify(input.eventId)}.`,
        {
          fields: ["eventId"],
        },
      );
    }

    const firing = await ctx.db.$queryRawUnsafe<{ entry_id: string }[]>(
      `SELECT "entry_id" FROM "intervention_events" WHERE "id" = $1::bigint`,
      input.eventId,
    );
    const entry = firing[0];
    if (entry === undefined) {
      throw new NotFoundError(`No intervention firing with id ${input.eventId}.`, {
        fields: ["eventId"],
      });
    }

    // `rater_id` is nullable and the unique index spans it. In Postgres two
    // NULLs do not collide, so an anonymous rater could insert repeatedly —
    // which is why the conflict target uses a sentinel rather than the raw
    // column. An anonymous rating is one rating, not an unbounded supply.
    const raterId = input.raterId ?? "";

    const rows = await ctx.db.$queryRawUnsafe<ScoreRow[]>(
      `INSERT INTO "intervention_scores"
         ("id", "event_id", "rater_type", "rater_id", "score", "note")
       VALUES (gen_random_uuid()::text, $1::bigint, $2::"InterventionRaterType", $3, $4, $5)
       ON CONFLICT ("event_id", "rater_type", "rater_id")
       DO UPDATE SET "score" = EXCLUDED."score",
                     "note" = EXCLUDED."note",
                     "rated_at" = now()
       RETURNING "id",
                 "event_id",
                 (SELECT "entry_id" FROM "intervention_events" WHERE "id" = "intervention_scores"."event_id") AS "entry_id",
                 "score",
                 "rater_type"::text AS "rater_type",
                 "rated_at"`,
      input.eventId,
      input.raterType,
      raterId,
      input.score,
      input.note ?? null,
    );

    const row = rows[0]!;
    return {
      id: row.id,
      eventId: String(row.event_id),
      entryId: row.entry_id,
      score: row.score,
      raterType: row.rater_type,
      ratedAt: row.rated_at.toISOString(),
    };
  },
});
