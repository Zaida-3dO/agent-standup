// The wind-down producer's query, against a real Postgres —
// `src/lib/interventions/wind-down-context.ts`.
//
// ── Why this file exists, stated as the failure it exists to catch ─────
//
// The unit tests for this producer assert on the *text* of the query,
// against a handle that answers with canned rows. That proves the string was
// written; it cannot prove the string means anything. Mutation testing shows
// the gap concretely: disjoining a tautology into the `NOT EXISTS` clause —
// so that already-rated firings are handed back to the survey forever —
// leaves every text assertion passing, because the substring `NOT EXISTS`
// is still there in a clause that matches everything.
//
// That mutant is the reason for this file. The semantics are pinned here
// instead, by executing the real query against real rows, and each case is
// a way the predicate can be wrong in a direction nothing else would
// notice:
//
//   - **An already-rated firing must not be asked about again.** This is
//     the survivor above, and it is the difference between a survey that
//     converges and one that re-asks the same question at every wind-down
//     until the agent learns to ignore it.
//   - **…but only the agent's OWN rating suppresses it.** A person's later
//     review and a derived score are different populations answering
//     different questions (`scoring.ts`'s `RaterPopulation`); letting either
//     suppress the agent's testimony would silently thin the one population
//     this survey exists to collect, and the thinning would be invisible in
//     every aggregate.
//   - **A `silent` firing must not be asked about at all.** The session was
//     never told anything, so it would be rating something it did not
//     experience — and it would answer, producing noise that looks like
//     data.
//   - **Another session's firings are not this session's to rate.**
//
// ── And the criterion this file is the evidence for ────────────────────
//
// The row's first acceptance criterion is that a real session ending
// produces real scores in `InterventionScore` — **observed, not asserted**.
// The last case here does exactly that: it writes a firing, runs the real
// producer, renders the real survey, answers it through the real
// `score_intervention` operation, and reads the row back out of the
// database. Nothing in that path is a fake.
//
// Skips without TEST_DATABASE_URL, like every other database-backed file
// here; CI's database job runs it, and `check:db-gated:require` fails there
// if the URL is missing rather than skipping silently.

import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assembleWindDownContext,
  truncateSurveyMessage,
  MAX_SURVEY_MESSAGE_CHARS,
} from "@/lib/interventions/wind-down-context";
import { readWindDownContext, evaluateStopSurvey } from "@/lib/hook/stop-catch";
import { parseSurveyResponse, WIND_DOWN_QUIET_MS } from "@/lib/interventions/survey";
import { scoreIntervention } from "@/lib/service/operations/score-intervention";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the wind-down producer — against Postgres", () => {
  const dbName = scratchDatabaseName("interventions_wind_down");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.interventionScore.deleteMany({});
    await prisma.interventionEvent.deleteMany({});
  });

  /** Writes one firing and hands back its id, as the hook path would. */
  async function recordFiring(options: {
    sessionId?: string;
    entryId?: string;
    outcome?: "silent" | "nudged" | "blocked" | "overridden";
    tool?: string;
    message?: string;
    ts?: Date;
  }): Promise<bigint> {
    const row = await prisma.interventionEvent.create({
      data: {
        entryId: options.entryId ?? "I10",
        sessionId: options.sessionId ?? "s1",
        outcome: (options.outcome ?? "blocked") as never,
        level: "block",
        phase: "pre",
        ...(options.tool === undefined ? {} : { tool: options.tool }),
        ...(options.message === undefined ? {} : { message: options.message }),
        ...(options.ts === undefined ? {} : { ts: options.ts }),
      },
    });
    return row.id;
  }

  function assemble(sessionId = "s1") {
    return assembleWindDownContext({
      db: prisma as never,
      sessionId,
      deadAfterSeconds: 900,
      liveCrew: 0,
      wakeScheduled: false,
    });
  }

  it("asks about a firing nobody has rated", async () => {
    const id = await recordFiring({ message: "scope it to a PID" });
    const context = await assemble();

    expect(context?.unrated).toHaveLength(1);
    expect(context?.unrated[0]?.eventId).toBe(String(id));
  });

  it("stops asking once this session has rated it", async () => {
    // **The case a text assertion cannot make.** A `NOT EXISTS` clause that
    // matches everything still contains the words `NOT EXISTS`; only running
    // it against real rows can tell the difference, and this is where it
    // shows.
    const id = await recordFiring({});
    await prisma.interventionScore.create({
      data: { eventId: id, raterType: "agent" as never, raterId: "s1", score: 4 },
    });

    expect(await assemble()).toBeUndefined();
  });

  it("still asks when only a PERSON has rated it", async () => {
    // A person reviewing a firing later is a different population answering
    // a different question. Suppressing the agent's own testimony because a
    // person happened to comment would thin the population invisibly.
    //
    // ── Why `raterId` is the session id here, which looks wrong ────────
    //
    // It is deliberate, and it is what makes this case test the predicate
    // it names. The suppression has two predicates — `rater_type = 'agent'`
    // and `rater_id = <session>` — and a person row carrying a
    // person-shaped `raterId` is excluded by the second one all on its own,
    // so it would prove nothing about the first: delete `rater_type =
    // 'agent'` and such a case still passes.
    //
    // Giving the person row the *same* `raterId` as the session isolates
    // the type predicate, which is the only thing standing between the
    // agent population and a person's answer silently standing in for it.
    // The unique index is `(eventId, raterType, raterId)`, so the two rows
    // coexist by design — which is exactly the arrangement being tested.
    const id = await recordFiring({});
    await prisma.interventionScore.create({
      data: { eventId: id, raterType: "person" as never, raterId: "s1", score: 2 },
    });

    const context = await assemble();
    expect(context?.unrated).toHaveLength(1);
  });

  it("still asks when a DIFFERENT session's agent rated it", async () => {
    // `rater_id` is the session. An agent score from another session is
    // another session's testimony, and it is not this one's answer.
    //
    // Breaks if the `rater_id = $1` predicate is dropped — which is a
    // subtler mutation than dropping the whole clause and is exactly the
    // kind a text assertion cannot see.
    const id = await recordFiring({});
    await prisma.interventionScore.create({
      data: { eventId: id, raterType: "agent" as never, raterId: "some-other-session", score: 5 },
    });

    const context = await assemble();
    expect(context?.unrated).toHaveLength(1);
  });

  it("never asks about a silent firing", async () => {
    // The session was never told anything, so it cannot rate what it did
    // not experience — and it would answer anyway, producing noise that is
    // indistinguishable from data in the aggregate.
    await recordFiring({ outcome: "silent" });
    expect(await assemble()).toBeUndefined();
  });

  it("does not offer one session another session's firings", async () => {
    await recordFiring({ sessionId: "other" });
    expect(await assemble("s1")).toBeUndefined();
  });

  it("caps an over-long message on the firing it emits", async () => {
    // `truncateSurveyMessage` is tested directly as a unit. What this case
    // adds is that the ASSEMBLER applies it: a cap proved to work but not
    // proved to be called is the "tested as a unit, unasserted at the call
    // site" shape, where dropping the call at this line keeps every other
    // test in both wind-down suites green.
    //
    // It matters because `UNRATED_READ_LIMIT` is `MAX_SURVEY_ITEMS * 8`, so
    // the untruncated worst case is 40 rows of unbounded
    // `intervention_events.message` text riding a hook response on a `Stop`.
    //
    // Asserted against the exported `MAX_SURVEY_MESSAGE_CHARS` and the real
    // marker rather than a hardcoded 600, so the two cannot drift; and the
    // stored message is read back from the database to confirm the source
    // row really was longer than the cap — otherwise a test that truncated
    // nothing would look identical to this one.
    const long = "x".repeat(MAX_SURVEY_MESSAGE_CHARS + 250);
    const id = await recordFiring({ message: long });

    const stored = await prisma.interventionEvent.findUniqueOrThrow({ where: { id } });
    expect(stored.message).toHaveLength(MAX_SURVEY_MESSAGE_CHARS + 250);

    const context = await assemble();
    const emitted = context?.unrated[0]?.message;

    expect(emitted).toBeDefined();
    expect(emitted!.length).toBeLessThan(stored.message!.length);
    expect(emitted).toBe(truncateSurveyMessage(long));
    expect(emitted!.endsWith("… [truncated]")).toBe(true);
  });

  it("leaves a message that fits under the cap exactly as it was stored", async () => {
    // The other half, so the case above cannot be satisfied by something
    // that truncates unconditionally.
    const short = "scope it to a PID";
    await recordFiring({ message: short });

    const context = await assemble();
    expect(context?.unrated[0]?.message).toBe(short);
  });

  it("keeps one firing per entry, newest first, once the survey dedupes", async () => {
    // The producer reads a wide window deliberately so `dedupeForSurvey`
    // has distinct entries to choose between rather than five firings of
    // one entry. Both halves are exercised here because the split only
    // makes sense as a pair.
    const base = Date.now() - 600_000;
    await recordFiring({ entryId: "I10", ts: new Date(base) });
    await recordFiring({ entryId: "I10", ts: new Date(base + 1_000) });
    await recordFiring({ entryId: "I22", ts: new Date(base + 2_000) });

    const context = await assemble();
    expect(context?.unrated).toHaveLength(3);

    const survey = evaluateStopSurvey(
      { eventType: "Stop", sessionId: "s1" },
      {
        ...readWindDownContext(JSON.parse(JSON.stringify(context))),
        idleMs: WIND_DOWN_QUIET_MS + 1,
      },
    );

    // Three firings, two entries, two questions.
    expect(survey?.asked).toBe(2);
  });

  it("produces a real InterventionScore row from a real session ending", async () => {
    // ── Acceptance criterion 1, observed rather than asserted ──────────
    //
    // The whole loop with no fakes in it: a firing is written as the hook
    // path writes one, the real producer finds it, the real parser reads
    // the wire shape, the real survey is rendered, a reply is parsed by the
    // real parser, and the real operation writes the score. The final
    // assertion reads the row back out of Postgres.
    //
    // This is the case that would have caught the original defect. Every
    // individual piece of this feature was green before this row existed,
    // and the feature recorded nothing, because nothing joined them up.
    const id = await recordFiring({
      entryId: "I10",
      tool: "Bash",
      message: "Broad process kills are denied; scope it to a PID.",
      outcome: "blocked",
    });

    // 1. The server assembles what it knows.
    const context = await assemble();
    // 2. It crosses the wire and the client parses it.
    const read = readWindDownContext(JSON.parse(JSON.stringify(context)));
    // 3. The client adds the quiet it measured, and the survey is built.
    const survey = evaluateStopSurvey(
      { eventType: "Stop", sessionId: "s1" },
      { ...read, idleMs: WIND_DOWN_QUIET_MS + 1 },
    );
    expect(survey).not.toBeNull();
    // The prompt must name the id the agent has to quote back, or the loop
    // is unanswerable however well the rest of it works.
    expect(survey?.text).toContain(`eventId ${id}`);

    // 4. The agent answers in the shape the prompt demanded.
    const parsed = parseSurveyResponse(
      `{"scores":[{"eventId":"${id}","score":5,"note":"stopped me killing every node process"}]}`,
    );
    expect(parsed.rejected).toHaveLength(0);
    expect(parsed.answers).toHaveLength(1);

    // 5. The existing operation records it — reused, not reimplemented.
    const answer = parsed.answers[0]!;
    await scoreIntervention.handler({ db: prisma } as never, {
      eventId: answer.eventId,
      score: answer.score,
      raterType: "agent",
      raterId: "s1",
      ...(answer.note === undefined ? {} : { note: answer.note }),
    });

    // 6. The row is in the database.
    const stored = await prisma.interventionScore.findMany({ where: { eventId: id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.score).toBe(5);
    expect(stored[0]?.raterType).toBe("agent");
    expect(stored[0]?.raterId).toBe("s1");
    // The note is what separates a genuine 1 from a sulk when somebody
    // reads this back in three months.
    expect(stored[0]?.note).toContain("node process");

    // 7. And the loop converges: the same session, stopping again, is not
    //    asked the same question twice.
    expect(await assemble()).toBeUndefined();
  });
});
