// The session-end survey's server-side producer —
// `src/lib/interventions/wind-down-context.ts`.
//
// ── What these cases are actually protecting ───────────────────────────
//
// The same asymmetry `interventions-stop-context.test.ts` names, one
// feature over: **the silent case matters more than the firing case.** A
// survey that fires at a genuine wind-down is a useful feature; one that
// fires mid-session is worse than nothing, because it gets answered with a
// column of 3s and that noise is indistinguishable from data in every
// aggregate built on top of it. `survey.ts`'s own header says so.
//
// ── The wire contract, which no type checks ────────────────────────────
//
// `readWindDownContext` (`src/lib/hook/stop-catch.ts`) parses this block
// field by field and drops anything it does not recognise, returning
// `undefined` when nothing survives. So a renamed field here is not a type
// error anywhere — it is a survey that silently never fires again. The
// round-trip case at the bottom is written against the real client parser
// rather than a restatement of it, for exactly that reason.

import { describe, expect, it } from "vitest";
import type { TransactionHandle } from "@/lib/service/context";
import {
  assembleWindDownContext,
  truncateSurveyMessage,
  UNRATED_READ_LIMIT,
  MAX_SURVEY_MESSAGE_CHARS,
} from "@/lib/interventions/wind-down-context";
import { readWindDownContext, evaluateStopSurvey } from "@/lib/hook/stop-catch";
import { MAX_SURVEY_ITEMS, WIND_DOWN_QUIET_MS } from "@/lib/interventions/survey";

const DEAD_AFTER = 900;

interface FakeFiring {
  readonly id: bigint;
  readonly entry_id: string;
  readonly ts: Date;
  readonly tool?: string | null;
  readonly message?: string | null;
  readonly outcome?: string;
}

/**
 * A handle answering the producer's one read, and nothing else.
 *
 * Anything else throws, so a query nobody intended fails loudly rather than
 * being quietly answered with `[]` — the same posture the stop-context and
 * hook-decision suites take.
 */
function handle(rows: readonly FakeFiring[]): TransactionHandle & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
      queries.push(query);
      if (query.includes('FROM "intervention_events"')) {
        return rows.map((row) => ({
          id: row.id,
          entry_id: row.entry_id,
          ts: row.ts,
          tool: row.tool ?? null,
          message: row.message ?? null,
          outcome: row.outcome ?? "blocked",
        })) as T;
      }
      throw new Error(`unexpected query: ${query}`);
    },
    $executeRawUnsafe: async () => {
      throw new Error("the wind-down producer must never write");
    },
  } as TransactionHandle & { queries: string[] };
}

function assemble(
  rows: readonly FakeFiring[],
  overrides: { liveCrew?: number; wakeScheduled?: boolean } = {},
) {
  return assembleWindDownContext({
    db: handle(rows),
    sessionId: "s1",
    deadAfterSeconds: DEAD_AFTER,
    liveCrew: overrides.liveCrew ?? 0,
    wakeScheduled: overrides.wakeScheduled ?? false,
  });
}

const firing = (overrides: Partial<FakeFiring> = {}): FakeFiring => ({
  id: 11n,
  entry_id: "I10",
  ts: new Date(1_700_000_000_000),
  ...overrides,
});

describe("a session with nothing to rate", () => {
  it("returns undefined rather than an empty block", async () => {
    // The brief's fourth criterion — no survey AND no noise. Held at the
    // earliest point it can be held, so an empty payload is never sent.
    //
    // Breaks if `if (rows.length === 0) return undefined` becomes
    // `rows.length < 0`, which would ship `{unrated: []}` on every stop of
    // every session in the system.
    expect(await assemble([])).toBeUndefined();
  });

  it("makes exactly one read to find that out", async () => {
    // The `Stop` path runs for every session end. A producer that issued
    // its crew queries again before discovering there was nothing to ask
    // about would double the cost of the commonest case.
    const db = handle([]);
    await assembleWindDownContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      liveCrew: 0,
      wakeScheduled: false,
    });
    expect(db.queries).toHaveLength(1);
  });
});

describe("what the survey is told about a firing", () => {
  it("carries the entry, the tool, the outcome and the message", async () => {
    // Criterion 3: enough context to interpret a 1. The schema comment on
    // `intervention_events.message` is explicit that a rater asked to score
    // a bare entry id cannot recall the call it fired on — so each of these
    // is asserted individually rather than through one object comparison,
    // because dropping any single one is a distinct regression.
    const context = await assemble([
      firing({
        tool: "Bash",
        message: "Broad process kills are denied; scope it to a PID.",
        outcome: "blocked",
      }),
    ]);

    const only = context?.unrated[0];
    expect(only?.entryId).toBe("I10");
    expect(only?.tool).toBe("Bash");
    expect(only?.outcome).toBe("blocked");
    expect(only?.message).toContain("scope it to a PID");
  });

  it("renders the event id as the string score_intervention expects", async () => {
    // `intervention_events.id` is a BIGSERIAL and arrives as a bigint;
    // `score_intervention` takes `eventId` as a string and rejects anything
    // non-numeric. What the rater is shown must be exactly what it passes
    // back — so this pins the rendering, not merely that a value exists.
    //
    // Breaks if `String(row.id)` becomes `row.id`, which would put a bigint
    // on the wire and serialise to `"11n"` or throw on JSON.stringify.
    const context = await assemble([firing({ id: 9007199254740993n })]);
    expect(context?.unrated[0]?.eventId).toBe("9007199254740993");
    expect(typeof context?.unrated[0]?.eventId).toBe("string");
  });

  it("reports the firing time as epoch milliseconds", async () => {
    // `dedupeForSurvey` sorts and dedupes on `at`. A `Date` here would
    // compare as an object and silently pick an arbitrary firing per entry.
    const at = new Date(1_700_000_123_000);
    const context = await assemble([firing({ ts: at })]);
    expect(context?.unrated[0]?.at).toBe(at.getTime());
  });

  it("omits a tool and a message that are null rather than sending nulls", async () => {
    // `SurveyableFiring` declares them optional, and `buildSurvey` prints a
    // line per present field. A null would render as "you were calling:
    // null", which reads as a fact about the call.
    const context = await assemble([firing({ tool: null, message: null })]);
    expect(context?.unrated[0]).not.toHaveProperty("tool");
    expect(context?.unrated[0]).not.toHaveProperty("message");
  });
});

describe("which firings are asked about", () => {
  it("excludes silent firings in the query itself", async () => {
    // `surveyable` in `capture.ts` makes the same exclusion: a session that
    // was never told anything cannot rate what it did not experience, and
    // an agent asked anyway would answer, producing noise that looks like
    // data. Asserted against the SQL because the exclusion happens there —
    // a fake that filtered in JS would pass while the real query did not.
    const db = handle([firing()]);
    await assembleWindDownContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      liveCrew: 0,
      wakeScheduled: false,
    });
    expect(db.queries[0]).toContain("'silent'");
    expect(db.queries[0]).toMatch(/"outcome"\s*<>\s*'silent'/);
  });

  it("excludes firings this session has already rated, by this session", async () => {
    // The suppression is scoped to the agent's own score. A person's later
    // review and a derived score are different populations answering
    // different questions (`scoring.ts`'s `RaterPopulation`), and letting
    // either suppress the agent's testimony would thin the one population
    // this survey exists to collect.
    const db = handle([firing()]);
    await assembleWindDownContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      liveCrew: 0,
      wakeScheduled: false,
    });
    expect(db.queries[0]).toContain("NOT EXISTS");
    expect(db.queries[0]).toMatch(/"rater_type"\s*=\s*'agent'/);
  });

  it("reads a wider window than the survey will ask about", async () => {
    // `dedupeForSurvey` keeps one firing per ENTRY and then takes five.
    // Reading exactly five rows would hand it five firings that could all
    // be the same entry, and the survey would ask one question where it was
    // entitled to ask five.
    //
    // Breaks if `MAX_SURVEY_ITEMS * 8` becomes `MAX_SURVEY_ITEMS`.
    expect(UNRATED_READ_LIMIT).toBeGreaterThan(MAX_SURVEY_ITEMS);
  });

  it("orders newest first, so an overflowing session is asked what it remembers", async () => {
    const db = handle([firing()]);
    await assembleWindDownContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      liveCrew: 0,
      wakeScheduled: false,
    });
    expect(db.queries[0]).toMatch(/ORDER BY\s+e\."ts"\s+DESC/);
  });
});

describe("the message cap", () => {
  it("leaves a message that fits exactly as it was", () => {
    const message = "a".repeat(MAX_SURVEY_MESSAGE_CHARS);
    expect(truncateSurveyMessage(message)).toBe(message);
  });

  it("marks a message it cut, so a clipped one is not read as a vague one", () => {
    // Two firings deserve a low score for opposite reasons — the detection
    // was wrong, or the message did not say what to do next. A sentence
    // that stops mid-clause looks like the second when it may be neither.
    //
    // Breaks if the `… [truncated]` suffix is dropped: the slice alone
    // still shortens the text and every length assertion would still pass.
    const cut = truncateSurveyMessage("b".repeat(MAX_SURVEY_MESSAGE_CHARS + 50));
    expect(cut).toContain("[truncated]");
    expect(cut.length).toBeLessThan(MAX_SURVEY_MESSAGE_CHARS + 50);
  });
});

describe("the crew facts are carried, never re-derived", () => {
  it("passes the caller's counts straight through", async () => {
    // `hook_decision` hands these over from `assembleStopContext` so there
    // is one definition of "is anyone still working for you". A producer
    // that re-derived them would be a second definition, and the two would
    // disagree the first time either query was tuned.
    const context = await assemble([firing()], { liveCrew: 3, wakeScheduled: true });
    expect(context?.liveCrew).toBe(3);
    expect(context?.wakeScheduled).toBe(true);
  });

  it("never issues a crew query of its own", async () => {
    const db = handle([firing()]);
    await assembleWindDownContext({
      db,
      sessionId: "s1",
      deadAfterSeconds: DEAD_AFTER,
      liveCrew: 2,
      wakeScheduled: false,
    });
    expect(db.queries.some((query) => query.includes('"Assignment"'))).toBe(false);
  });
});

describe("the wire contract with the real client parser", () => {
  it("survives a JSON round trip into readWindDownContext", async () => {
    // The only thing standing between a renamed field and a survey that
    // silently never fires again. Written against the real parser, and
    // through actual JSON, because the payload crosses an HTTP boundary.
    const context = await assemble([
      firing({ tool: "Bash", message: "scope it to a PID", outcome: "blocked" }),
    ]);

    const wire = JSON.parse(JSON.stringify(context));
    const read = readWindDownContext(wire);

    expect(read?.unrated).toHaveLength(1);
    expect(read?.unrated?.[0]?.eventId).toBe("11");
    expect(read?.unrated?.[0]?.entryId).toBe("I10");
    expect(read?.unrated?.[0]?.message).toBe("scope it to a PID");
    expect(read?.liveCrew).toBe(0);
    expect(read?.wakeScheduled).toBe(false);
  });

  it("produces a block that actually surveys once the client adds the quiet", async () => {
    // End to end across the seam, which is the whole point of the row: the
    // server's block plus the client's `idleMs` must reach a real survey
    // with the owner's scale in it. Every previous case could pass with the
    // feature still inert.
    const context = await assemble([
      firing({ tool: "Bash", message: "scope it to a PID", outcome: "blocked" }),
    ]);
    const read = readWindDownContext(JSON.parse(JSON.stringify(context)));

    const survey = evaluateStopSurvey(
      { eventType: "Stop", sessionId: "s1" },
      { ...read, idleMs: WIND_DOWN_QUIET_MS + 1 },
    );

    expect(survey).not.toBeNull();
    expect(survey?.asked).toBe(1);
    // The owner's wording, not a paraphrase — a tidied scale would score
    // differently while still producing numbers between 1 and 5.
    expect(survey?.text).toContain("wrong path");
    expect(survey?.text).toContain("Please remove");
    // And the context a 1 needs to be interpretable.
    expect(survey?.text).toContain("scope it to a PID");
    expect(survey?.text).toContain("11");
  });

  it("still says nothing when the server found firings but the session is not quiet", async () => {
    // The discrimination, from the server's side. A populated block is not
    // by itself permission to ask.
    const context = await assemble([firing()]);
    const read = readWindDownContext(JSON.parse(JSON.stringify(context)));

    expect(
      evaluateStopSurvey({ eventType: "Stop", sessionId: "s1" }, { ...read, idleMs: 0 }),
    ).toBeNull();
  });
});
