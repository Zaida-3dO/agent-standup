// The server-side producer for the session-end survey's context — the
// owner's scoring loop (`./survey.ts`), and the second half of the gap
// `./stop-context.ts` closed for the stop catch.
//
// ── The gap this closes, which is the same gap twice ───────────────────
//
// `./survey.ts` decides when to ask and what the question looks like, and
// it did both correctly from the day it was written. `../hook/stop-catch.ts`
// can evaluate it (`evaluateStopSurvey`) and read its context off a server
// response (`readWindDownContext`). `../hook/response.ts` can render it
// (`renderWithStopSurvey`). `../hook/run.ts` accepts a `survey` option and
// passes it through. `score_intervention` can record an answer, and is
// bound on the MCP surface so a session can actually call it.
//
// **Every one of those was built. None of them had anything to talk to.**
// `hook_decision`'s `Stop` branch returned a `stop` block and nothing else,
// so `readWindDownContext` was never called, `evaluateStopSurvey` received
// `undefined` on every stop, and the scale the owner specified has recorded
// zero scores against hundreds of firings. This is the missing producer,
// written to the same shape as `assembleStopContext` because it is the same
// omission one feature over.
//
// ── What this module assembles, and what it deliberately does not ──────
//
// Three of the five facts `shouldSurvey` tests: the unrated firings, the
// live crew count, and whether a wake is scheduled. It does **not** assemble
// `idleMs`, and that absence is the single most important decision here.
//
// ── Why `idleMs` cannot be answered on this side ───────────────────────
//
// `idleMs` is the condition that distinguishes the last stop of a session
// from the forty before it — it is the whole of "genuinely winding down".
// And the server cannot measure it.
//
// `hook_decision` is a read operation and writes nothing per call, so no
// row anywhere advances when a session makes a tool call. The two
// timestamps that look like they would serve are both lying:
//
//   - **`ToolCall.ts`** arrives through the batched spool drain
//     (`../hook/spool.ts`, `../hook/flush.ts`), not on the hook path. So
//     `NOW() - MAX(ts)` measures time since the last *flush*. A session
//     mid-burst whose spool has not drained reads as maximally idle, which
//     would fire the survey at the busiest possible moment — precisely the
//     interruption `./survey.ts`'s header rules out, and precisely the way
//     a survey starts being answered with a column of 3s.
//   - **`Session.lastSeenAt`** advances only on `register_session`, which
//     happens once. It measures time since the session started.
//
// Both would produce a number, both would typecheck, and both would be
// wrong in the direction that makes the feature worse than not having it.
// So this producer leaves the field absent — which `shouldSurvey` already
// reads as "do not ask", staying silent rather than guessing — and the
// client supplies it from the one clock that is both per-session and
// synchronous: its own spool file, written on every call in this session,
// on the same machine, with no drain in between. See
// `../hook/wind-down-local.ts`.
//
// The consequence is worth stating plainly, because it is a feature rather
// than a compromise: **the survey cannot fire unless both halves agree.**
// The server must find unrated firings and no live crew; the client must
// independently observe genuine quiet. Either one absent is silence.
//
// ── Advisory, and structurally so ──────────────────────────────────────
//
// This produces a value with no verdict in it. `WindDownContextPayload`
// carries firings, counts and flags; there is no field on it that could
// refuse a stop, and the operation that sends it returns `decision: "allow"`
// on the `Stop` branch unconditionally. DECISIONS.md §6 — a refused stop
// can trap an agent in a loop, and a questionnaire that could hold a turn
// open is indefensible where even the catch is advisory.

import type { TransactionHandle } from "@/lib/service/context";
import { MAX_SURVEY_ITEMS, type SurveyableFiring } from "./survey";

/**
 * How many unrated firings are read for one stop.
 *
 * Deliberately larger than `MAX_SURVEY_ITEMS`, because the two bound
 * different things. `dedupeForSurvey` keeps **one firing per entry** and
 * then takes the most recent five, so reading exactly five rows would hand
 * it five firings that could all be the same entry — and the survey would
 * ask one question where it was entitled to ask five. Reading a wider
 * window and letting the deduper choose is what makes the cap mean "five
 * distinct entries" rather than "five rows".
 *
 * Bounded all the same: this runs on a `Stop`, and a session that tripped
 * more than this many unrated firings gets asked about its most recent
 * ones, with the rest staying unrated for a later wind-down. That is the
 * behaviour `dedupeForSurvey` already documents for the overflow case.
 */
export const UNRATED_READ_LIMIT = MAX_SURVEY_ITEMS * 8;

/**
 * How much of a stored message is carried to the rater.
 *
 * The message is most of what is being judged — the schema comment on
 * `intervention_events.message` says so — so truncating it hard would
 * recreate the failure the column exists to prevent: a rater scoring a bare
 * entry id without recalling the call it fired on. But a full message is
 * unbounded text and this rides a hook response, so it is capped at a
 * length that comfortably holds a guard's message while refusing to carry a
 * pathological one.
 *
 * The head rather than the tail, matching `MAX_TOOL_RESULT_CHARS` in
 * `../hook/payload.ts`: a message's first characters say what it is about.
 */
export const MAX_SURVEY_MESSAGE_CHARS = 600;

/**
 * The `windDown` block, exactly as the hook's `readWindDownContext` parses
 * it.
 *
 * **The field names are a wire contract, not a local choice.** The client
 * validates each one independently and drops anything it does not
 * recognise, so a near-miss on a name is indistinguishable from sending
 * nothing at all — the reader would see a silent survey and no error. Every
 * name here matches `WindDownContext` in `./survey.ts` and the parser in
 * `../hook/stop-catch.ts`; the shape is restated rather than imported
 * because this module sits on the service side of the boundary and produces
 * a serialisable payload, the same posture `StopContextPayload` takes.
 *
 * `idleMs` and `alreadySurveyed` are absent by design — the first because
 * this side cannot measure it (see the module header), the second because
 * it is a fact about a conversation the server does not hold.
 */
export interface WindDownContextPayload {
  /** Firings from this session that carry no score yet. */
  readonly unrated: readonly SurveyableFiring[];
  /** How many crew under this session's root are still running. */
  readonly liveCrew: number;
  /** Whether something is already lined up to wake this session. */
  readonly wakeScheduled: boolean;
}

/** One row of the unrated-firings read. */
interface UnratedRow {
  id: bigint;
  entry_id: string;
  ts: Date;
  tool: string | null;
  message: string | null;
  outcome: string;
}

/**
 * Truncates a message for the survey, marking it when it was cut.
 *
 * The marker is not decoration. A rater shown a sentence that stops
 * mid-clause cannot tell whether the guard's message was unhelpfully vague
 * or merely clipped in transit — and those deserve opposite scores. Saying
 * it was truncated puts that distinction back.
 */
export function truncateSurveyMessage(
  message: string,
  limit: number = MAX_SURVEY_MESSAGE_CHARS,
): string {
  if (message.length <= limit) return message;
  return `${message.slice(0, limit)}… [truncated]`;
}

/**
 * Assembles the `windDown` block for one `Stop` event, or `undefined` when
 * there is nothing to say.
 *
 * ── Why `undefined` rather than an empty block ─────────────────────────
 *
 * A session with no unrated firings has nothing to be surveyed about, and
 * sending `{unrated: [], liveCrew: 0, wakeScheduled: false}` would be
 * spending a payload to say so. `shouldSurvey` returns false on an empty
 * `unrated` either way, so the two are equivalent in behaviour and the
 * absent one is honest about having found nothing. This is the brief's
 * fourth criterion — a session with zero firings produces no survey **and
 * no noise** — held at the earliest point it can be held.
 *
 * ── Why the score join is `NOT EXISTS` and not a left join ─────────────
 *
 * A firing may carry several scores: `intervention_scores` is unique per
 * `(eventId, raterType, raterId)`, so an agent score and a person score
 * coexist by design, and a derived score may sit beside both. A left join
 * would multiply rows and a `DISTINCT` over it would hide that. `NOT
 * EXISTS` asks the question actually being asked — *has this session already
 * rated this firing* — and asks it per firing.
 *
 * **Scoped to this session's own agent score, deliberately.** The rater
 * whose answer would suppress the question is the one being asked. A
 * person's later review of the same firing, or a derived score computed
 * from the behavioural record, are different populations answering
 * different questions (`scoring.ts`'s `RaterPopulation`), and letting either
 * suppress the agent's own testimony would silently thin the one population
 * this survey exists to collect.
 */
export async function assembleWindDownContext(options: {
  readonly db: TransactionHandle;
  readonly sessionId: string;
  /** `liveness.dead_after_seconds` — the liveness bound, handed in. */
  readonly deadAfterSeconds: number;
  /** Already-assembled crew facts, so the two stop reads are not duplicated. */
  readonly liveCrew: number;
  readonly wakeScheduled: boolean;
}): Promise<WindDownContextPayload | undefined> {
  const { db, sessionId, liveCrew, wakeScheduled } = options;

  // Read the firings first and return early when there are none. This is
  // the overwhelmingly common case — most sessions trip no guard at all —
  // and it is the whole of the "no noise on a quiet session" criterion.
  const rows = await db.$queryRawUnsafe<UnratedRow[]>(
    `SELECT e."id"        AS "id",
            e."entry_id"  AS "entry_id",
            e."ts"        AS "ts",
            e."tool"      AS "tool",
            e."message"   AS "message",
            e."outcome"::text AS "outcome"
       FROM "intervention_events" e
      WHERE e."session_id" = $1
        AND e."outcome" <> 'silent'
        AND NOT EXISTS (
              SELECT 1
                FROM "intervention_scores" s
               WHERE s."event_id" = e."id"
                 AND s."rater_type" = 'agent'
                 AND s."rater_id" = $1)
      ORDER BY e."ts" DESC
      LIMIT $2`,
    sessionId,
    UNRATED_READ_LIMIT,
  );

  if (rows.length === 0) return undefined;

  const unrated: SurveyableFiring[] = rows.map((row) => ({
    // `id` is a BIGSERIAL and arrives as a bigint. Rendered as a string
    // because the wire has no bigint and because `score_intervention` takes
    // its `eventId` as a string — so what the rater is shown is exactly
    // what it must pass back, with no conversion for it to get wrong.
    eventId: String(row.id),
    entryId: row.entry_id,
    at: row.ts.getTime(),
    ...(row.tool === null ? {} : { tool: row.tool }),
    ...(row.message === null ? {} : { message: truncateSurveyMessage(row.message) }),
    outcome: row.outcome,
  }));

  return { unrated, liveCrew, wakeScheduled };
}

/**
 * Excludes `silent` firings, matching `surveyable` in `./capture.ts`.
 *
 * Stated here as well because the exclusion is made in SQL above and a
 * reader checking that the two agree should find the claim written down. A
 * `silent` firing was never shown to the session, so asking it to rate one
 * is asking it to rate something it did not experience — and it would
 * answer, producing noise indistinguishable from data.
 */
export const SURVEY_EXCLUDES_SILENT = true;
