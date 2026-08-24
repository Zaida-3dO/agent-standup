// The session-end survey — asking whether the interventions actually helped.
//
// `./scoring.ts` defines the scale and what the answers add up to. This
// module decides **when to ask** and **what the question looks like**, which
// are the two halves the owner's ask turns on: *"a Stop hook that fires when
// a session is genuinely winding down"*, and *"keep it to a compact
// structured call, not a discursive turn"*.
//
// ── Genuine wind-down, and why that is the hard half ───────────────────
//
// A `Stop` event is not the same thing as a session ending. Agents stop and
// resume constantly: a turn ends whenever the model has nothing more to say
// this instant, and a great many of those are followed immediately by more
// work. Surveying on every one would interrupt the middle of a task to ask
// about a nudge from four minutes ago — which is both the worst possible
// moment to get an honest answer and precisely the interruption the digest
// design exists to avoid.
//
// So this module treats a Stop as *necessary but not sufficient* and adds
// the conditions in `shouldSurvey`. It follows `../hook/stop-catch.ts` in
// posture as well as in shape: it returns a request or nothing, it can
// never refuse a stop, and every absent signal reads as "do not ask" rather
// than as a guess. Silence is the overwhelmingly common answer.
//
// ── Cheap, structurally ────────────────────────────────────────────────
//
// The owner's fourth criterion is that rating must not cost more than the
// guard saves, and the way that is kept true is by bounding the ask rather
// than by asking nicely. Three bounds, all here:
//
//   1. **At most `MAX_SURVEY_ITEMS` firings per survey**, most recent
//      first. A session that tripped one entry thirty times gets asked
//      about it once — `dedupeForSurvey` keeps the most recent firing per
//      entry, because an entry is being judged, not an individual call.
//   2. **The reply is a fixed JSON shape**, parsed by `parseSurveyResponse`.
//      A prose answer would need a model call to interpret, which is the
//      cost this is avoiding.
//   3. **The note is optional and one line.** It exists because two firings
//      can deserve a low score for opposite reasons — the detection was
//      wrong, or it was right and the message was undiscoverable — and only
//      the second is fixed by rewording. But it is never required, so the
//      cheap answer stays available.
//
// This module holds no database client and writes nothing.

import { INTERVENTION_SCORE_MEANINGS, SCALE_POINTS, isValidInterventionScore } from "./scoring";

/**
 * The most firings one survey will ask about.
 *
 * Five. Enough that a busy session's survey is still representative, few
 * enough that answering is a short structured reply rather than a chore —
 * and a chore is answered with a column of 3s, which is worse than not
 * asking because it looks like data.
 */
export const MAX_SURVEY_ITEMS = 5;

/**
 * How long a session must have been quiet before a Stop counts as
 * wind-down, in milliseconds.
 *
 * Two minutes. A stop followed by more work almost always resumes far
 * sooner than this; a stop that is genuinely the end of a session is
 * followed by nothing at all. The value is a judgement and is exported so a
 * caller can tune it — what it must not be is zero, which would make every
 * turn boundary a survey point.
 */
export const WIND_DOWN_QUIET_MS = 2 * 60 * 1000;

/** A firing the survey can ask about. */
export interface SurveyableFiring {
  /** The row in `intervention_events`, so an answer can be attributed. */
  readonly eventId: string;
  readonly entryId: string;
  /** When it fired, epoch milliseconds. */
  readonly at: number;
  /** What the session was doing — the tool it called. */
  readonly tool?: string;
  /** The message the session was shown. This is most of what is judged. */
  readonly message?: string;
  /** Whether it blocked, nudged, was overridden, or said nothing. */
  readonly outcome?: string;
}

/**
 * What is known about a session at the moment it stops.
 *
 * Every field optional, and every absent field reads as "do not ask" — the
 * same discipline `StopContext` uses, and for the same reason: a survey
 * that fired whenever the server failed to report something would interrupt
 * exactly the sessions it knows least about.
 */
export interface WindDownContext {
  /** Firings from this session that have not yet been rated. */
  readonly unrated?: readonly SurveyableFiring[];
  /** How many crew this session dispatched are still running. */
  readonly liveCrew?: number;
  /** Whether something is scheduled to wake this session again. */
  readonly wakeScheduled?: boolean;
  /** Milliseconds since this session last did anything, at the stop. */
  readonly idleMs?: number;
  /** Whether this session has already been surveyed. */
  readonly alreadySurveyed?: boolean;
}

/**
 * Whether this stop is a genuine wind-down worth surveying at.
 *
 * Five conditions, all required, and each rules out a different way of
 * asking at the wrong moment:
 *
 *   - **Something to ask about.** No unrated firings, no survey. An empty
 *     survey is pure cost.
 *   - **Not already surveyed.** Asking twice trains a session to answer
 *     without reading, which produces data that looks fine and means
 *     nothing.
 *   - **No live crew.** An orchestrator whose crew are still running has
 *     not finished; it is going to be woken to read their results, and its
 *     own turn boundary is mid-work by any honest reading.
 *   - **Nothing scheduled to wake it.** Same fact by the other route — a
 *     session with a wake pending is pausing, not ending.
 *   - **Quiet for long enough.** The signal that distinguishes the last
 *     stop of a session from the forty before it. Absent means unknown,
 *     which stays silent: a survey fired on an unknown idle time would fire
 *     on every stop, which is the failure this whole function exists to
 *     prevent.
 */
export function shouldSurvey(
  context: WindDownContext,
  quietMs: number = WIND_DOWN_QUIET_MS,
): boolean {
  if (context.alreadySurveyed === true) return false;

  const unrated = context.unrated;
  if (unrated === undefined || unrated.length === 0) return false;

  if (context.liveCrew !== undefined && context.liveCrew > 0) return false;
  if (context.wakeScheduled === true) return false;

  const idleMs = context.idleMs;
  if (idleMs === undefined) return false;
  return idleMs >= quietMs;
}

/**
 * Picks the firings one survey asks about.
 *
 * **One per entry**, keeping the most recent: the thing being rated is the
 * catalogue entry, not the individual call, so ten firings of `I11` are ten
 * chances to answer the same question. The most recent is kept rather than
 * the first because it is the one the session actually remembers.
 *
 * Then most-recent-first and capped at `MAX_SURVEY_ITEMS`. A session that
 * tripped eleven distinct entries is asked about the five it hit most
 * recently and the rest stay unrated — which is correct: they remain
 * unrated in the table and can be asked about at the next wind-down, rather
 * than being force-fed into one oversized survey that gets a column of 3s.
 */
export function dedupeForSurvey(
  firings: readonly SurveyableFiring[],
  limit: number = MAX_SURVEY_ITEMS,
): SurveyableFiring[] {
  const latestByEntry = new Map<string, SurveyableFiring>();
  for (const firing of firings) {
    const held = latestByEntry.get(firing.entryId);
    if (held === undefined || firing.at > held.at) latestByEntry.set(firing.entryId, firing);
  }

  return [...latestByEntry.values()].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
}

/** The survey as a caller delivers it. */
export interface SurveyRequest {
  readonly kind: "intervention-survey";
  /** The firings being asked about, already deduped and capped. */
  readonly firings: readonly SurveyableFiring[];
  /** The prompt text, including the scale and the required reply shape. */
  readonly prompt: string;
}

/**
 * Builds the survey for a set of firings.
 *
 * The scale is rendered from `INTERVENTION_SCORE_MEANINGS` rather than
 * restated here. That is the single most important line in this module: a
 * prompt with its own copy of the wording would drift from the stored
 * definition, and the drift would be invisible — every score would still be
 * a number between 1 and 5, and every aggregate would still compute, while
 * meaning something the owner never asked for.
 */
export function buildSurvey(firings: readonly SurveyableFiring[]): SurveyRequest | null {
  const asked = dedupeForSurvey(firings);
  if (asked.length === 0) return null;

  const scale = SCALE_POINTS.map(
    (score) => `  ${score} — ${INTERVENTION_SCORE_MEANINGS[score]}`,
  ).join("\n");

  const items = asked
    .map((firing, index) => {
      const parts = [`${index + 1}. [${firing.entryId}] eventId ${firing.eventId}`];
      if (firing.tool !== undefined) parts.push(`   you were calling: ${firing.tool}`);
      if (firing.outcome !== undefined) parts.push(`   it: ${firing.outcome}`);
      if (firing.message !== undefined) parts.push(`   it told you: ${firing.message}`);
      return parts.join("\n");
    })
    .join("\n");

  const prompt = [
    `Before you finish: ${asked.length} intervention${asked.length === 1 ? "" : "s"} fired during ` +
      "this session. Rate how useful each one actually was, so the unhelpful ones can be removed.",
    "",
    scale,
    "",
    items,
    "",
    "Reply with JSON only — no prose, no explanation outside the notes:",
    '{"scores":[{"eventId":"<id>","score":<1-5>,"note":"<optional, one line>"}]}',
    "",
    "A note is worth adding when the score is low, because a 1 or a 2 can mean two very " +
      "different things: the detection was wrong, or the detection was right and the message " +
      "did not say what to do next. Only the second is fixed by rewording it.",
  ].join("\n");

  return { kind: "intervention-survey", firings: asked, prompt };
}

/** One parsed answer. */
export interface SurveyAnswer {
  readonly eventId: string;
  readonly score: number;
  readonly note?: string;
}

/** What a parse produced, and what it had to throw away. */
export interface ParsedSurvey {
  readonly answers: readonly SurveyAnswer[];
  /**
   * Answers that could not be read, with why.
   *
   * Reported rather than silently dropped. A survey whose replies are half
   * malformed is a survey producing a biased aggregate — if the malformed
   * ones skew low, and a frustrated rater is exactly who writes an
   * out-of-range score or a prose reply, then dropping them quietly makes
   * the catalogue look better than it is. That is the one direction this
   * must not fail in.
   */
  readonly rejected: readonly string[];
}

/**
 * Reads a survey reply.
 *
 * Tolerant of the wrapping a model puts around JSON — a fenced block, or
 * text either side — because the alternative is discarding an otherwise
 * good answer over a formatting habit, and a discarded answer is
 * indistinguishable in the aggregate from an entry nobody minded.
 *
 * Every individual answer is still validated strictly: an unparseable one
 * is rejected with a reason rather than coerced. Tolerant about the
 * envelope, strict about the contents.
 */
export function parseSurveyResponse(raw: string): ParsedSurvey {
  const rejected: string[] = [];
  const json = extractJsonObject(raw);
  if (json === null) return { answers: [], rejected: ["no JSON object found in reply"] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { answers: [], rejected: ["reply was not valid JSON"] };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { answers: [], rejected: ["reply was not a JSON object"] };
  }

  const scores = (parsed as Record<string, unknown>).scores;
  if (!Array.isArray(scores)) return { answers: [], rejected: ["reply had no `scores` array"] };

  const answers: SurveyAnswer[] = [];
  const seen = new Set<string>();

  for (const entry of scores) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      rejected.push("an answer was not an object");
      continue;
    }
    const record = entry as Record<string, unknown>;

    const eventId = record.eventId;
    if (typeof eventId !== "string" || eventId.trim() === "") {
      rejected.push("an answer had no eventId");
      continue;
    }
    if (!isValidInterventionScore(record.score)) {
      rejected.push(`${eventId}: score was not an integer 1-5`);
      continue;
    }
    // A rater answering twice for one firing is ambiguous, and picking
    // either would be inventing an intention. Both are refused, and the
    // rejection names the firing so the ambiguity is visible rather than
    // resolved by ordering.
    if (seen.has(eventId)) {
      rejected.push(`${eventId}: answered more than once`);
      continue;
    }
    seen.add(eventId);

    const note =
      typeof record.note === "string" && record.note.trim() !== "" ? record.note.trim() : undefined;
    answers.push({
      eventId: eventId.trim(),
      score: record.score,
      ...(note === undefined ? {} : { note }),
    });
  }

  return { answers, rejected };
}

/**
 * Finds the outermost JSON object in a reply.
 *
 * Brace-matched rather than a regular expression, and string-aware: a note
 * containing a `}` — which a rater complaining about a message is quite
 * likely to write — would truncate a naive scan at the wrong character and
 * turn a valid reply into an unparseable one.
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }

  return null;
}
