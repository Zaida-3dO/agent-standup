// Scoring a session's earlier firings when a later one is recorded — the
// capture seam for the intervention scale.
//
// `deriveInterventionScore` can turn a firing plus what followed it into a
// score, but something has to CALL it on real firings, and this is that
// something. It runs from `record_intervention`, which is where the hook
// already reports every firing, so no new round trip and no new
// configuration on any installed machine is involved.
//
// ── Why a LATER firing is the trigger, and not this one ────────────────
//
// The score depends on what the session did **after** a firing, so a
// firing cannot be scored at the moment it is written — nothing has
// happened yet. Waiting for the session to end would be the obvious
// alternative and is the one that has already failed here: a session that
// dies, is killed, or simply stops without a clean `Stop` never reaches
// its own end, and those are common. So the trigger is the next thing the
// session does that reaches this server, and a firing is one of those.
//
// The consequence is worth being plain about: **a session's final firing
// is never scored by this path.** That is an accepted floor rather than an
// oversight. Scoring every firing but the last is a large improvement over
// scoring none, and the alternative — a sweep that revisits old firings on
// a timer — is a second mechanism with its own failure modes for the sake
// of the tail. `score_intervention` and the session-end survey both remain
// open for anything this misses, and a firing left unscored here is
// honestly unscored rather than given a placeholder.
//
// ── Best-effort, and that is a decision rather than laziness ───────────
//
// Every failure is swallowed. Recording a firing is the caller's real
// work; deriving a measurement from it is bookkeeping, and bookkeeping
// must never be able to fail the write that carries it. This is the same
// fail-open posture the hook path takes throughout: a session that cannot
// record its evidence still gets its decision.
//
// The swallow is narrow. It wraps the scoring work only, so a failure in
// the recording itself still propagates, and it writes nothing on the
// failure path rather than a placeholder — an unscored firing is a fact
// the aggregate already reports.

import type { ServiceContext } from "../context";
import {
  DERIVED_RATER_ID,
  RESPONSE_WINDOW_MS,
  deriveInterventionScore,
  isDerivableScore,
  type FollowUpCall,
} from "@/lib/interventions/derived-score";

interface FiringRow {
  id: bigint;
  ts: Date;
  outcome: string;
  tool: string | null;
  command: string | null;
}

interface ToolCallRow {
  ts: Date;
  tool: string;
  command: string | null;
}

/**
 * How far back a trigger looks for firings it can now score.
 *
 * One hour. Every firing this path can score already has its follow-ups
 * inside `RESPONSE_WINDOW_MS`, so a longer reach buys nothing but rows to
 * re-examine; a shorter one would skip a firing whose session paused. It
 * bounds the query rather than the judgement — the window that decides
 * what counts as a response is `RESPONSE_WINDOW_MS`, and this only decides
 * how many candidates are fetched.
 */
export const SCOREABLE_LOOKBACK_MS = 60 * 60 * 1000;

/**
 * The most firings one trigger will score.
 *
 * Bounded because this runs on the hook's write path, which is the highest
 * volume path in the system, and an unbounded loop there would let a
 * pathological session make every one of its calls slower. A session that
 * trips more than this inside an hour has its older firings left for the
 * next trigger.
 */
export const MAX_SCORED_PER_TRIGGER = 20;

/**
 * Derives and records scores for this session's earlier blocked firings.
 *
 * Returns the event ids it scored, which is what the tests assert on — a
 * function whose only observable effect is a row somewhere else is one
 * whose failure looks exactly like its success.
 */
export async function scoreBlockedFirings(
  ctx: ServiceContext,
  sessionId: string,
  now: number = Date.now(),
): Promise<readonly string[]> {
  try {
    if (ctx.settings.values["interventions.derive_scores"] !== true) return [];

    const since = new Date(now - SCOREABLE_LOOKBACK_MS);

    // Only firings that have no derived score yet, and only this session's.
    // The `NOT EXISTS` is what makes the trigger idempotent: a session that
    // fires ten times in an hour runs this ten times, and each run sees
    // only what the previous ones left. Without it every trigger would
    // re-derive the same rows and the upsert would rewrite them, which is
    // harmless but pays for the same answer repeatedly on a hot path.
    //
    // A firing whose outcome could never yield a score is excluded here
    // rather than fetched and discarded, because the overwhelming majority
    // of firings are advisory and fetching them all would make the common
    // case the expensive one.
    const firings = await ctx.db.$queryRawUnsafe<FiringRow[]>(
      `SELECT e."id", e."ts", e."outcome"::text AS "outcome", e."tool", e."command"
         FROM "intervention_events" e
        WHERE e."session_id" = $1
          AND e."ts" >= $2
          AND e."outcome"::text IN ('blocked', 'overridden')
          AND NOT EXISTS (
            SELECT 1 FROM "intervention_scores" s
             WHERE s."event_id" = e."id"
               AND s."rater_type" = 'agent'
               AND s."rater_id" = $3
          )
        ORDER BY e."ts" DESC
        LIMIT $4`,
      sessionId,
      since,
      DERIVED_RATER_ID,
      MAX_SCORED_PER_TRIGGER,
    );
    if (firings.length === 0) return [];

    // One read of the session's tail, shared by every firing being scored.
    // Per-firing queries would be the obvious shape and would put N round
    // trips on the hot path to answer a question one range covers.
    const oldest = firings.reduce(
      (earliest, firing) => Math.min(earliest, firing.ts.getTime()),
      Number.POSITIVE_INFINITY,
    );
    const calls = await ctx.db.$queryRawUnsafe<ToolCallRow[]>(
      `SELECT "ts", "tool", "command"
         FROM "ToolCall"
        WHERE "sessionId" = $1
          AND "ts" > $2
        ORDER BY "ts" ASC`,
      sessionId,
      new Date(oldest),
    );
    const followUps: FollowUpCall[] = calls.map((call) => ({
      at: call.ts.getTime(),
      tool: call.tool,
      ...(call.command === null ? {} : { command: call.command }),
    }));

    const scored: string[] = [];
    for (const firing of firings) {
      // A firing too recent to have been responded to yet is left alone
      // rather than scored on an incomplete window. Without this a firing
      // recorded moments ago would be read as "blocked, then nothing" and
      // frozen as unscored — and because the query above skips anything
      // already scored, a wrong answer written here would never be
      // revisited.
      if (now - firing.ts.getTime() < RESPONSE_WINDOW_MS) continue;

      const derived = deriveInterventionScore(
        {
          entryId: "",
          at: firing.ts.getTime(),
          outcome: firing.outcome,
          ...(firing.tool === null ? {} : { tool: firing.tool }),
          ...(firing.command === null ? {} : { command: firing.command }),
          followUps,
        },
        RESPONSE_WINDOW_MS,
      );

      if (derived.score === null) continue;
      // The cap in `derived-score.ts`'s header, enforced at the seam that
      // writes rather than only stated where it is computed. A derivation
      // widened later to award the scale's top point fails here instead of
      // quietly filling the table with a claim nobody made.
      if (!isDerivableScore(derived.score)) continue;

      const note = derived.reasons[0];
      await ctx.db.$executeRawUnsafe(
        `INSERT INTO "intervention_scores"
           ("id", "event_id", "rater_type", "rater_id", "score", "note")
         VALUES (gen_random_uuid()::text, $1, 'agent', $2, $3, $4)
         ON CONFLICT ("event_id", "rater_type", "rater_id") DO NOTHING`,
        firing.id,
        DERIVED_RATER_ID,
        derived.score,
        note ?? null,
      );
      scored.push(String(firing.id));
    }
    return scored;
  } catch {
    // Bookkeeping never fails the work it is measuring.
    return [];
  }
}
