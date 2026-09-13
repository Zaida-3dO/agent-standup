// `get_intervention_scores` — can a reader tell a derived score from a
// human one?
//
// The defect these pin: the read side selected `entry_id, score, note` and
// never `rater_id`/`rater_type`, so a machine's inference about a machine
// was indistinguishable from a rater's verdict. Firings accumulate on every
// session while ratings have to be volunteered, so the derived population
// can outnumber the volunteered one by any margin — and where it does,
// every aggregate in the report is ~entirely derived, in the very report
// whose purpose is deciding which guards to retire.
//
// These run against an in-memory handle rather than Postgres, deliberately.
// The claims here are about how rows are CLASSIFIED and rolled up, which is
// arithmetic over rows handed in; a database-gated file would skip silently
// on any machine without TEST_DATABASE_URL and assert nothing. The SQL
// text's own correctness is asserted separately below by reading the query
// the handler issues.
import { describe, expect, it } from "vitest";
import { getInterventionScores } from "@/lib/service/operations/get-intervention-scores";
import type { ServiceContext } from "@/lib/service/context";
import { DERIVED_RATER_ID } from "@/lib/interventions/derived-score";

interface FakeScoreRow {
  entry_id: string;
  score: number;
  note: string | null;
  rater_type: string;
  rater_id: string | null;
  confidence: string | null;
}

/** A score row as the table stores one, with testimony as the default. */
function row(overrides: Partial<FakeScoreRow> & { entry_id: string; score: number }): FakeScoreRow {
  return {
    note: null,
    rater_type: "person",
    rater_id: "ope",
    confidence: null,
    ...overrides,
  };
}

/** A derived row: an `agent` row under the reserved rater id. */
function derivedRow(
  overrides: Partial<FakeScoreRow> & { entry_id: string; score: number },
): FakeScoreRow {
  return row({
    rater_type: "agent",
    rater_id: DERIVED_RATER_ID,
    confidence: "low",
    ...overrides,
  });
}

/**
 * A handle answering the two queries the handler issues.
 *
 * Keyed on which table the query names rather than on call order, so a
 * reordering of the two reads does not silently feed score rows to the
 * firing count.
 */
function handle(
  firings: { entry_id: string; firings: number; rated: number }[],
  scores: FakeScoreRow[],
) {
  const queries: string[] = [];
  return {
    queries,
    db: {
      $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
        queries.push(query);
        if (query.includes(`FROM "intervention_scores"`)) return scores as T;
        return firings.map((f) => ({
          entry_id: f.entry_id,
          firings: BigInt(f.firings),
          rated: BigInt(f.rated),
        })) as T;
      },
      $executeRawUnsafe: async () => {
        throw new Error("a read operation must never write");
      },
    },
  };
}

async function run(
  firings: { entry_id: string; firings: number; rated: number }[],
  scores: FakeScoreRow[],
  input: Record<string, unknown> = {},
) {
  const fake = handle(firings, scores);
  const output = await getInterventionScores.handler(
    { db: fake.db } as unknown as ServiceContext,
    input as never,
  );
  return { output, queries: fake.queries };
}

describe("the query actually asks who rated", () => {
  // **Kills the defect itself.** Deleting `rater_type` or `rater_id` from
  // the SELECT makes every classification below fall back to a single
  // population, and nothing else in the suite would say which column went
  // missing. This is the one assertion on the SQL text, and it is here
  // because the column list is precisely what was wrong.
  it("selects the rater columns the classification depends on", async () => {
    const { queries } = await run(
      [{ entry_id: "I10", firings: 1, rated: 1 }],
      [row({ entry_id: "I10", score: 3 })],
    );

    const scoreQuery = queries.find((q) => q.includes(`FROM "intervention_scores"`));
    expect(scoreQuery).toContain(`"rater_type"`);
    expect(scoreQuery).toContain(`"rater_id"`);
    expect(scoreQuery).toContain(`"confidence"`);
  });
});

describe("telling the two populations apart", () => {
  // Kills: classifying on `rater_type` alone. Every derived score IS an
  // `agent` row — the reserved rater id is the only thing separating the
  // derivation from an agent that rated its own session's firing — so a
  // classifier reading the type alone reports real agent testimony as
  // machine inference.
  it("separates a derived row from a real agent's own rating", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 4, rated: 2 }],
      [
        row({ entry_id: "I10", score: 5, rater_type: "agent", rater_id: "session-abc" }),
        derivedRow({ entry_id: "I10", score: 1 }),
      ],
    );

    const entry = output.entries[0];
    expect(entry?.testimony?.count).toBe(1);
    expect(entry?.testimony?.mean).toBe(5);
    expect(entry?.derived?.count).toBe(1);
    expect(entry?.derived?.mean).toBe(1);
  });

  // **The headline the report was missing.** Kills: summing both totals
  // from the same population, or dropping either. With no human ratings,
  // `totalRated` alone reads as a corpus of judgements when it is a corpus
  // of inferences.
  it("says how many of the ratings were testimony and how many were derived", async () => {
    const { output } = await run(
      [
        { entry_id: "I10", firings: 5, rated: 2 },
        { entry_id: "I11", firings: 3, rated: 1 },
      ],
      [
        derivedRow({ entry_id: "I10", score: 2 }),
        derivedRow({ entry_id: "I10", score: 4 }),
        row({ entry_id: "I11", score: 5 }),
      ],
    );

    expect(output.totalRated).toBe(3);
    expect(output.totalDerived).toBe(2);
    expect(output.totalTestimony).toBe(1);
  });

  // Kills: emitting a zeroed summary instead of null. This is the state the
  // entire current corpus is in, and "nobody has ever vouched for this" has
  // to be readable as such rather than as a rating of zero.
  it("reports an entry nothing human has rated as having no testimony", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 9, rated: 2 }],
      [derivedRow({ entry_id: "I10", score: 2 }), derivedRow({ entry_id: "I10", score: 2 })],
    );

    expect(output.entries[0]?.testimony).toBeNull();
    expect(output.entries[0]?.derived?.count).toBe(2);
  });
});

describe("what a flag rests on", () => {
  // **The judgement this report exists to support.** Kills: hardcoding
  // `flaggedEvidence` to "testimony", or deriving it from the wrong
  // population. A guard retired on the strength of a machine's guess about
  // a machine is the failure the scoring work exists to prevent — so a flag
  // resting only on inference has to say so.
  it("marks a flag resting only on derived scores as derived", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 9, rated: 3 }],
      [
        derivedRow({ entry_id: "I10", score: 1 }),
        derivedRow({ entry_id: "I10", score: 2 }),
        derivedRow({ entry_id: "I10", score: 2 }),
      ],
    );

    expect(output.flagged).toEqual(["I10"]);
    expect(output.entries[0]?.flaggedEvidence).toBe("derived");
  });

  // Kills: reporting "derived" whenever ANY derived score is present. One
  // rater who was there is what makes a flag actionable; a mixed population
  // with real testimony in it is not the same as pure inference.
  it("marks a flag with any human corroboration as testimony", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 9, rated: 3 }],
      [
        derivedRow({ entry_id: "I10", score: 1 }),
        derivedRow({ entry_id: "I10", score: 2 }),
        row({ entry_id: "I10", score: 1 }),
      ],
    );

    expect(output.flagged).toEqual(["I10"]);
    expect(output.entries[0]?.flaggedEvidence).toBe("testimony");
  });

  // Kills: emitting `flaggedEvidence` unconditionally. An unflagged entry
  // is making no claim, and labelling it "derived" would read as one.
  it("says nothing about evidence on an entry that was not flagged", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 9, rated: 1 }],
      [row({ entry_id: "I10", score: 5 })],
    );

    expect(output.flagged).toEqual([]);
    expect(output.entries[0]?.flaggedEvidence).toBeUndefined();
  });
});

describe("the derivation's own caveat", () => {
  // Kills: dropping `confidence` from the row mapping, or tallying it over
  // testimony as well. A derived population that is entirely `low` means
  // "the session complied", which is evidence the guard was not an obstacle
  // and is NOT evidence it helped.
  it("tallies derived confidence, and only over derived rows", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 9, rated: 3 }],
      [
        derivedRow({ entry_id: "I10", score: 2, confidence: "high" }),
        derivedRow({ entry_id: "I10", score: 4, confidence: "low" }),
        row({ entry_id: "I10", score: 5, confidence: "high" }),
      ],
    );

    expect(output.entries[0]?.derivedConfidence).toEqual({ high: 1, low: 1 });
  });

  // Kills: folding a null confidence into `none`. `none` is a thing the
  // derivation said about the evidence; a null is a row written before the
  // column existed, and reading the second as the first would invent a
  // caveat nobody recorded.
  it("counts a pre-column derived row as unrecorded, not as none", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 9, rated: 2 }],
      [
        derivedRow({ entry_id: "I10", score: 2, confidence: null }),
        derivedRow({ entry_id: "I10", score: 2, confidence: "none" }),
      ],
    );

    expect(output.entries[0]?.derivedConfidence).toEqual({ unrecorded: 1, none: 1 });
  });

  // Kills: emitting a stray tally on entries with no derived scores.
  it("is empty when nothing was derived", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 2, rated: 1 }],
      [row({ entry_id: "I10", score: 4 })],
    );

    expect(output.entries[0]?.derivedConfidence).toEqual({});
  });
});

describe("existing readers are not moved", () => {
  // Kills: narrowing the headline `mean`/`count` to one population. Callers
  // already read these, and the split is additive on purpose — changing
  // what `mean` spans would silently alter every existing reading of it.
  it("keeps the headline mean spanning both populations", async () => {
    const { output } = await run(
      [{ entry_id: "I10", firings: 9, rated: 2 }],
      [row({ entry_id: "I10", score: 5 }), derivedRow({ entry_id: "I10", score: 1 })],
    );

    const entry = output.entries[0];
    expect(entry?.mean).toBe(3);
    expect(entry?.rated).toBe(2);
    expect(entry?.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 1 });
    expect(entry?.removalSignals).toBe(1);
  });

  // Kills: dropping the unrated-entry row. An entry that fired and was
  // never rated is a distinct state, and the population split must not turn
  // it into an omission.
  it("still reports an entry nothing has rated at all", async () => {
    const { output } = await run([{ entry_id: "I99", firings: 6, rated: 0 }], []);

    const entry = output.entries[0];
    expect(entry?.mean).toBeNull();
    expect(entry?.testimony).toBeNull();
    expect(entry?.derived).toBeNull();
    expect(output.totalFirings).toBe(6);
    expect(output.totalTestimony).toBe(0);
  });
});
