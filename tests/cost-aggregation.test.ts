// Folding per-(group, model) sums into per-group totals — MILESTONES.md #53
// ("Aggregation: cost per item, per session, per stage").
//
// **Needs no database, so it runs everywhere.** The database's job in this
// operation is `GROUP BY`, which Postgres is not on trial for; the part
// worth testing is what happens *after* the rows come back — costing each
// model's share at its own rate, deciding when a total is null, and
// ordering deterministically enough that a truncated report is reproducible.
//
// **What would make this file hollow.** Testing one group, one model, one
// rate. Every interesting property of this fold is about a group holding
// *more than one* model: that is where per-model costing is needed at all,
// where a partial total becomes possible, and where summing stored costs
// would have been indistinguishable from doing it correctly.
import { describe, expect, it } from "vitest";
import { fold } from "@/lib/service/operations/get-costs";
import type { ModelPrices } from "@/lib/telemetry/pricing";

const CHEAP = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
const DEAR = { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 };

const PRICES: ModelPrices = { cheap: CHEAP, dear: DEAR };

/** One row as the `GROUP BY` produces it. `key` may legitimately be null. */
function row(
  key: string | null,
  model: string,
  counts: Partial<{
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    toolCallCount: number;
    runs: number;
  }> = {},
) {
  return {
    key,
    model,
    inputTokens: BigInt(counts.inputTokens ?? 1_000_000),
    outputTokens: BigInt(counts.outputTokens ?? 0),
    cacheWriteTokens: BigInt(counts.cacheWriteTokens ?? 0),
    cacheReadTokens: BigInt(counts.cacheReadTokens ?? 0),
    toolCallCount: counts.toolCallCount ?? 1,
    runs: counts.runs ?? 1,
  };
}

describe("fold — totals across models within one group", () => {
  it("costs each model's share at its own rate", () => {
    // The property that makes per-model grouping necessary. A single blended
    // rate over the group's combined counts gives 2M × (some average) and
    // matches neither model's actual price.
    const result = fold([row("item-a", "cheap"), row("item-a", "dear")], "item", PRICES, 25);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.cost).toBeCloseTo(1 + 10, 10);
    expect(result.groups[0]!.inputTokens).toBe(2_000_000);
    expect(result.groups[0]!.runs).toBe(2);
  });

  it("sums runs and tool calls across the group's models", () => {
    const result = fold(
      [
        row("item-a", "cheap", { runs: 3, toolCallCount: 40 }),
        row("item-a", "dear", { runs: 2, toolCallCount: 7 }),
      ],
      "item",
      PRICES,
      25,
    );
    expect(result.groups[0]!.runs).toBe(5);
    expect(result.groups[0]!.toolCalls).toBe(47);
  });

  it("keeps groups separate", () => {
    const result = fold([row("item-a", "cheap"), row("item-b", "cheap")], "item", PRICES, 25);
    expect(result.groups.map((g) => g.key).sort()).toEqual(["item-a", "item-b"]);
  });
});

describe("fold — unpriced work is reported, not dropped and not free", () => {
  it("reports a partial cost when one model in a group is unpriced", () => {
    // A complete-looking figure that quietly omitted a model is the failure
    // that makes a cost report untrustworthy without ever looking broken.
    // The priced share is reported *with* its incompleteness stated.
    const result = fold(
      [row("item-a", "cheap"), row("item-a", "unconfigured", { runs: 4 })],
      "item",
      PRICES,
      25,
    );
    expect(result.groups[0]!.cost).toBeCloseTo(1, 10);
    expect(result.groups[0]!.unpricedRuns).toBe(4);
  });

  it("still counts an unpriced model's tokens toward the group", () => {
    // The counts are the truth (§11). Dropping them would make the token
    // totals disagree with the corpus as well as the cost.
    const result = fold([row("item-a", "unconfigured")], "item", PRICES, 25);
    expect(result.groups[0]!.inputTokens).toBe(1_000_000);
    expect(result.groups[0]!.runs).toBe(1);
  });

  it("reports null, not zero, when nothing in the group could be priced", () => {
    const result = fold([row("item-a", "unconfigured")], "item", PRICES, 25);
    expect(result.groups[0]!.cost).toBeNull();
  });

  it("does not let row order decide whether a group has a cost", () => {
    // With `+= cost` on a null accumulator, a group whose first row is
    // unpriced would stay null however much its later rows cost — making the
    // figure depend on the database's row ordering.
    const forwards = fold(
      [row("item-a", "unconfigured"), row("item-a", "cheap")],
      "item",
      PRICES,
      25,
    );
    const backwards = fold(
      [row("item-a", "cheap"), row("item-a", "unconfigured")],
      "item",
      PRICES,
      25,
    );
    expect(forwards.groups[0]!.cost).toBeCloseTo(1, 10);
    expect(backwards.groups[0]!.cost).toBeCloseTo(1, 10);
  });

  it("names the unpriced models, deduplicated and sorted", () => {
    // The count says something was unpriced; only the list says what to add
    // to the price table.
    const result = fold(
      [
        row("item-a", "zeta-unconfigured"),
        row("item-b", "alpha-unconfigured"),
        row("item-c", "zeta-unconfigured"),
        row("item-d", "cheap"),
      ],
      "item",
      PRICES,
      25,
    );
    expect(result.unpricedModels).toEqual(["alpha-unconfigured", "zeta-unconfigured"]);
  });

  it("names no models when everything was priced", () => {
    expect(fold([row("item-a", "cheap")], "item", PRICES, 25).unpricedModels).toEqual([]);
  });
});

describe("fold — a null key is a group, not an omission", () => {
  it("keeps rows whose grouping column is null", () => {
    const result = fold([row(null, "cheap"), row("item-a", "cheap")], "session", PRICES, 25);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.some((g) => g.key === null)).toBe(true);
  });

  it("does not merge a null key with a group literally named 'null'", () => {
    // A session could genuinely be called "null", and collapsing the two
    // would silently add one group's cost to another's.
    const result = fold([row(null, "cheap"), row("null", "dear")], "session", PRICES, 25);
    expect(result.groups).toHaveLength(2);
    const nullGroup = result.groups.find((g) => g.key === null)!;
    const namedGroup = result.groups.find((g) => g.key === "null")!;
    expect(nullGroup.cost).toBeCloseTo(1, 10);
    expect(namedGroup.cost).toBeCloseTo(10, 10);
  });
});

describe("fold — ordering and truncation", () => {
  it("orders most expensive first", () => {
    const result = fold([row("cheap-item", "cheap"), row("dear-item", "dear")], "item", PRICES, 25);
    expect(result.groups.map((g) => g.key)).toEqual(["dear-item", "cheap-item"]);
  });

  it("sorts unpriced groups last rather than as zero", () => {
    // An unpriced group is unknown, not cheap. Placing it above a genuinely
    // small one would present "we do not know" as "this was the most
    // expensive" once the list is read from the top.
    const result = fold(
      [row("unknown-cost", "unconfigured"), row("known-cheap", "cheap")],
      "item",
      PRICES,
      25,
    );
    expect(result.groups.map((g) => g.key)).toEqual(["known-cheap", "unknown-cost"]);
  });

  it("cuts to the limit and says that it did", () => {
    // A short list is visibly short; a total that silently omitted its tail
    // looks exactly like a correct total.
    const rows = [row("a", "cheap"), row("b", "cheap"), row("c", "cheap")];
    const result = fold(rows, "item", PRICES, 2);
    expect(result.groups).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("reports untruncated when everything fits", () => {
    expect(fold([row("a", "cheap")], "item", PRICES, 25).truncated).toBe(false);
  });

  it("breaks a cost tie deterministically, so truncation is reproducible", () => {
    // Without a tiebreak, which of several equal-cost groups survived the
    // limit would depend on row order and could differ between two identical
    // calls — a total nobody can act on.
    const rows = [row("zeta", "cheap"), row("alpha", "cheap"), row("mid", "cheap")];
    const forwards = fold(rows, "item", PRICES, 2);
    const backwards = fold([...rows].reverse(), "item", PRICES, 2);
    expect(forwards.groups.map((g) => g.key)).toEqual(backwards.groups.map((g) => g.key));
    expect(forwards.groups.map((g) => g.key)).toEqual(["alpha", "mid"]);
  });

  it("orders equal-cost null-keyed groups after named ones", () => {
    const result = fold(
      [row(null, "unconfigured"), row("named", "unconfigured")],
      "item",
      PRICES,
      25,
    );
    expect(result.groups.map((g) => g.key)).toEqual(["named", null]);
  });

  it("echoes the grouping it was asked for", () => {
    expect(fold([], "stage", PRICES, 25).groupBy).toBe("stage");
  });

  it("returns an empty report rather than failing on no rows", () => {
    const result = fold([], "item", PRICES, 25);
    expect(result.groups).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.unpricedModels).toEqual([]);
  });
});

describe("fold — the total is recomputed, never a sum of stored costs", () => {
  it("changes when the price table changes, for identical counts", () => {
    // This is #52's "always recomputable" as an observable property. Summing
    // a stored `cost` column would give the same answer under both tables,
    // because the stored figure was computed under whichever rates were
    // configured when the run was written.
    const rows = [row("item-a", "cheap")];
    const atOldRates = fold(rows, "item", { cheap: CHEAP }, 25);
    const atNewRates = fold(rows, "item", { cheap: { ...CHEAP, input: CHEAP.input * 2 } }, 25);
    expect(atOldRates.groups[0]!.cost).toBeCloseTo(1, 10);
    expect(atNewRates.groups[0]!.cost).toBeCloseTo(2, 10);
  });

  it("prices a model that was unpriced once a rate is added, with no rewrite", () => {
    const rows = [row("item-a", "later-configured")];
    expect(fold(rows, "item", PRICES, 25).groups[0]!.cost).toBeNull();
    expect(
      fold(rows, "item", { ...PRICES, "later-configured": CHEAP }, 25).groups[0]!.cost,
    ).toBeCloseTo(1, 10);
  });
});
