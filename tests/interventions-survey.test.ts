// The session-end survey — `src/lib/interventions/survey.ts`.
//
// Two halves, and each has a failure mode worth naming.
//
// **When to ask.** The owner's criterion is that it fire "on genuine
// wind-down, not mid-work". A Stop is not the end of a session — agents stop
// and resume constantly — so every property below is one of the ways
// `shouldSurvey` could turn back into "ask on every turn boundary", which is
// both the worst moment to get an honest answer and the interruption the
// digest design exists to avoid.
//
// **What the ask costs.** The fourth criterion is that rating must not cost
// more than the guard saves. That is kept true by bounds — one item per
// entry, a cap, and a fixed reply shape — so the tests treat each bound as
// load-bearing rather than cosmetic.
//
// The parser tests lean on the direction of failure: it is tolerant about
// the envelope a model wraps JSON in and strict about the contents, and a
// rejected answer is *reported* rather than dropped. That asymmetry matters
// because the raters most likely to write a malformed reply are the
// frustrated ones, and silently dropping their answers would make the
// catalogue look better than it is.
import { describe, expect, it } from "vitest";
import {
  MAX_SURVEY_ITEMS,
  WIND_DOWN_QUIET_MS,
  buildSurvey,
  dedupeForSurvey,
  parseSurveyResponse,
  shouldSurvey,
  type SurveyableFiring,
} from "@/lib/interventions/survey";
import { INTERVENTION_SCORE_MEANINGS } from "@/lib/interventions/scoring";

function firing(overrides: Partial<SurveyableFiring> = {}): SurveyableFiring {
  return { eventId: "1", entryId: "I10", at: 1_000, ...overrides };
}

/** A context that would survey, so each test can spoil exactly one thing. */
function windingDown(overrides = {}) {
  return { unrated: [firing()], liveCrew: 0, idleMs: WIND_DOWN_QUIET_MS, ...overrides };
}

describe("shouldSurvey", () => {
  it("asks when the session has genuinely wound down", () => {
    expect(shouldSurvey(windingDown())).toBe(true);
  });

  // Kills: dropping the empty check. An empty survey is pure cost — it
  // interrupts a session to ask it about nothing.
  it("stays silent with nothing to ask about", () => {
    expect(shouldSurvey(windingDown({ unrated: [] }))).toBe(false);
    expect(shouldSurvey(windingDown({ unrated: undefined }))).toBe(false);
  });

  // Kills: dropping the `alreadySurveyed` check. Asking twice trains a
  // session to answer without reading, which produces data that looks fine
  // and means nothing.
  it("asks only once", () => {
    expect(shouldSurvey(windingDown({ alreadySurveyed: true }))).toBe(false);
  });

  // Kills: `> 0` → `>= 0`, which would silence every survey; or dropping
  // the check, which would survey an orchestrator mid-flight. A session
  // whose crew are still running is going to be woken to read their
  // results — its turn boundary is mid-work by any honest reading.
  it("stays silent while dispatched crew are still running", () => {
    expect(shouldSurvey(windingDown({ liveCrew: 1 }))).toBe(false);
    expect(shouldSurvey(windingDown({ liveCrew: 0 }))).toBe(true);
  });

  // Kills: dropping the wake check. A session with a wake pending is
  // pausing, not ending.
  it("stays silent when something is scheduled to wake the session", () => {
    expect(shouldSurvey(windingDown({ wakeScheduled: true }))).toBe(false);
  });

  // **The property that distinguishes wind-down from a turn boundary.**
  // Kills: `>=` → `>` at the boundary, and — far worse — defaulting an
  // absent `idleMs` to something that passes. An unknown idle time must
  // stay silent, because a survey that fired on unknown would fire on every
  // single Stop, which is the exact failure this function exists to
  // prevent.
  it("requires a real quiet period, and treats an unknown one as no", () => {
    expect(shouldSurvey(windingDown({ idleMs: WIND_DOWN_QUIET_MS - 1 }))).toBe(false);
    expect(shouldSurvey(windingDown({ idleMs: WIND_DOWN_QUIET_MS }))).toBe(true);
    expect(shouldSurvey(windingDown({ idleMs: undefined }))).toBe(false);
  });

  // Kills: ignoring the caller's quiet period and always using the default.
  it("honours a caller's quiet period", () => {
    expect(shouldSurvey(windingDown({ idleMs: 500 }), 1_000)).toBe(false);
    expect(shouldSurvey(windingDown({ idleMs: 1_000 }), 1_000)).toBe(true);
  });
});

describe("dedupeForSurvey", () => {
  // Kills: dropping the dedupe. The thing being rated is the catalogue
  // entry, not the call — ten firings of I11 are ten chances to answer one
  // question, and asking all ten is how a survey becomes a chore answered
  // with a column of 3s.
  it("asks about an entry once, keeping the firing the session remembers", () => {
    const asked = dedupeForSurvey([
      firing({ eventId: "1", entryId: "I11", at: 100 }),
      firing({ eventId: "2", entryId: "I11", at: 900 }),
      firing({ eventId: "3", entryId: "I11", at: 500 }),
    ]);

    expect(asked).toHaveLength(1);
    // The most recent, not the first — it is the one the session remembers.
    expect(asked[0]?.eventId).toBe("2");
  });

  // Kills: raising the cap, or removing the slice.
  it("caps the survey", () => {
    const many = Array.from({ length: MAX_SURVEY_ITEMS + 3 }, (_, index) =>
      firing({ eventId: String(index), entryId: `I${index}`, at: index }),
    );

    expect(dedupeForSurvey(many)).toHaveLength(MAX_SURVEY_ITEMS);
  });

  // Kills: reversing the sort. When the survey is capped, the entries kept
  // must be the ones most recently hit — those are the ones the session can
  // still speak to.
  it("keeps the most recent entries when it has to choose", () => {
    const many = Array.from({ length: MAX_SURVEY_ITEMS + 2 }, (_, index) =>
      firing({ eventId: String(index), entryId: `I${index}`, at: index }),
    );

    const asked = dedupeForSurvey(many);
    expect(asked[0]?.at).toBe(MAX_SURVEY_ITEMS + 1);
    expect(asked.map((entry) => entry.at)).toEqual(
      [...asked.map((e) => e.at)].sort((a, b) => b - a),
    );
  });

  it("is empty for no firings", () => {
    expect(dedupeForSurvey([])).toEqual([]);
  });
});

describe("buildSurvey", () => {
  // **The single most important property in this module.** Kills: rendering
  // the scale from a hand-written copy of the five lines rather than from
  // the stored definition. A paraphrase drifts invisibly — every score would
  // still be 1-5 and every aggregate would still compute, while meaning
  // something the owner never asked for.
  it("renders the scale from the stored definition, not a copy", () => {
    const survey = buildSurvey([firing()]);

    for (const score of [1, 2, 3, 4, 5]) {
      expect(survey?.prompt).toContain(INTERVENTION_SCORE_MEANINGS[score]);
    }
  });

  // Kills: dropping the eventId from the rendered item. Without it a reply
  // cannot be attributed to a firing, and the whole aggregate is built from
  // exactly those attributions.
  it("names the firing so an answer can be attributed to it", () => {
    const survey = buildSurvey([firing({ eventId: "4242", entryId: "I15" })]);

    expect(survey?.prompt).toContain("4242");
    expect(survey?.prompt).toContain("I15");
  });

  // Kills: dropping the message from the rendered item. The message is most
  // of what is being judged — a correct detection with a message that names
  // a remedy it then refuses deserves a low score *for the message*, and a
  // rater shown only an entry id could not tell the two apart.
  it("quotes back what the session was doing and what it was told", () => {
    const survey = buildSurvey([
      firing({ tool: "Bash", message: "Kill by process id instead.", outcome: "blocked" }),
    ]);

    expect(survey?.prompt).toContain("Bash");
    expect(survey?.prompt).toContain("Kill by process id instead.");
    expect(survey?.prompt).toContain("blocked");
  });

  // Kills: removing the JSON contract from the prompt. A prose answer needs
  // a model call to interpret, which is the cost this design avoids.
  it("demands a structured reply", () => {
    const survey = buildSurvey([firing()]);

    expect(survey?.prompt).toContain('"scores"');
    expect(survey?.prompt).toMatch(/JSON only/i);
  });

  it("is null when there is nothing to ask", () => {
    expect(buildSurvey([])).toBeNull();
  });
});

describe("parseSurveyResponse", () => {
  it("reads a clean reply", () => {
    const { answers, rejected } = parseSurveyResponse(
      '{"scores":[{"eventId":"7","score":5},{"eventId":"8","score":2,"note":"misleading"}]}',
    );

    expect(rejected).toEqual([]);
    expect(answers).toEqual([
      { eventId: "7", score: 5 },
      { eventId: "8", score: 2, note: "misleading" },
    ]);
  });

  // Kills: requiring the reply to be bare JSON. Discarding an otherwise
  // good answer over a formatting habit makes it indistinguishable, in the
  // aggregate, from an entry nobody minded.
  it("tolerates the wrapping a model puts around JSON", () => {
    const { answers } = parseSurveyResponse(
      'Sure — here are my ratings:\n```json\n{"scores":[{"eventId":"7","score":4}]}\n```\nHope that helps.',
    );

    expect(answers).toEqual([{ eventId: "7", score: 4 }]);
  });

  // **Kills a brace scan that is not string-aware.** A rater complaining
  // about a message is quite likely to quote a brace, and an *unbalanced*
  // one — a bare `}` in prose — closes a naive depth counter early, cutting
  // the JSON mid-string and turning a valid low score into an unparseable
  // reply. That loses exactly the answers that matter most.
  //
  // Note the brace must be unbalanced to be a real test: a balanced pair
  // like `interface{}` leaves a depth counter at the same place it would
  // have ended anyway, so it passes whether or not the scan understands
  // strings. An earlier version of this test used exactly that and was
  // hollow — it survived deleting the string-awareness entirely.
  it("survives an unbalanced brace inside a note", () => {
    const { answers, rejected } = parseSurveyResponse(
      '{"scores":[{"eventId":"9","score":1,"note":"it refused my edit at the } line"}]}',
    );

    expect(rejected).toEqual([]);
    expect(answers[0]?.note).toBe("it refused my edit at the } line");
  });

  // Kills: dropping the escape handling in the scanner. An escaped quote
  // inside a note is otherwise read as the string *ending*, which puts the
  // scanner back into brace-counting mode partway through prose — and the
  // stray `}` that follows then closes the object early.
  //
  // The escaped quote must be **unpaired** for this to test anything. Two
  // of them toggle the scanner in and out of string mode an even number of
  // times and it lands in exactly the same place either way; an earlier
  // version of this test used a quoted phrase and was hollow for precisely
  // that reason. One quote, then a bare brace, is the shape that separates
  // the two implementations.
  it("survives an unpaired escaped quote before a stray brace", () => {
    const { answers, rejected } = parseSurveyResponse(
      '{"scores": [{"eventId": "9", "score": 2, "note": "it printed a stray \\" and then a } brace"}]}',
    );

    expect(rejected).toEqual([]);
    expect(answers[0]?.note).toBe('it printed a stray " and then a } brace');
  });

  // Kills: coercing an out-of-range score instead of rejecting it, and —
  // the direction that biases the data — dropping it silently. A frustrated
  // rater is exactly who writes a 0 or a 10.
  it("rejects an off-scale score and says so", () => {
    const { answers, rejected } = parseSurveyResponse(
      '{"scores":[{"eventId":"7","score":0},{"eventId":"8","score":9}]}',
    );

    expect(answers).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toContain("7");
  });

  // Kills: accepting a second answer for the same firing. Picking either
  // would invent an intention; both are refused and the ambiguity is named.
  it("refuses a firing answered twice", () => {
    const { answers, rejected } = parseSurveyResponse(
      '{"scores":[{"eventId":"7","score":5},{"eventId":"7","score":1}]}',
    );

    expect(answers).toHaveLength(1);
    expect(answers[0]?.score).toBe(5);
    expect(rejected[0]).toContain("more than once");
  });

  // Kills: returning silently on unparseable input. A caller that could not
  // tell "no answers" from "the reply was broken" would record a session as
  // having declined to rate anything.
  it("reports an unreadable reply rather than returning empty", () => {
    expect(parseSurveyResponse("no json here").rejected).toHaveLength(1);
    expect(parseSurveyResponse("{not valid json}").rejected).toHaveLength(1);
    expect(parseSurveyResponse('{"nope":[]}').rejected[0]).toContain("scores");
  });

  // Kills: keeping a whitespace-only note, which would put an empty line
  // into a maintainer's report.
  it("drops a blank note", () => {
    const { answers } = parseSurveyResponse('{"scores":[{"eventId":"7","score":3,"note":"   "}]}');
    expect(answers[0]?.note).toBeUndefined();
  });

  // Kills: dropping the per-answer validation, which would let one bad
  // entry take a whole reply's worth of good answers with it.
  it("keeps the good answers alongside the bad", () => {
    const { answers, rejected } = parseSurveyResponse(
      '{"scores":[{"eventId":"7","score":5},{"score":3},{"eventId":"9","score":1}]}',
    );

    expect(answers.map((answer) => answer.eventId)).toEqual(["7", "9"]);
    expect(rejected).toHaveLength(1);
  });
});
