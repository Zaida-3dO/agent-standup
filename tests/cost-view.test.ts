// The `/cost` screen's derivations — `src/lib/cost/view.ts` and
// `src/lib/cost/state.ts`, as plain functions with no DOM.
//
// Every case here is a version of the same question: **may this screen claim
// this?** The brief behind T19 is blunt — "a cost dashboard that implies
// completeness it does not have is worse than no cost dashboard" — so the
// assertions are mostly about what the screen must *not* say: that unpriced
// work was free, that a truncated list is a total, or that an empty window
// means nothing was spent.
//
// The composition — that the container actually issues the request and
// re-issues it when the controls change — is `tests/cost-wiring.test.ts`,
// mounted in real React. Neither file covers the other, which is the lesson
// from the undo defect: 34 of 34 pure-function mutants passed while the
// wiring that called them was broken.
import { describe, expect, it } from "vitest";
import {
  completenessOf,
  formatCost,
  formatTokens,
  labelForKey,
  shareOf,
  totalOf,
} from "@/lib/cost/view";
import { buildCostsQuery, costErrorMessageFrom, sinceForDays } from "@/lib/cost/state";
import type { CostGroup, CostsPayload } from "@/lib/cost/types";

function group(overrides: Partial<CostGroup> = {}): CostGroup {
  return {
    key: "k",
    runs: 1,
    toolCalls: 2,
    inputTokens: 1_000,
    outputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    cost: 1,
    unpricedRuns: 0,
    ...overrides,
  };
}

function payload(overrides: Partial<CostsPayload> = {}): CostsPayload {
  return {
    groupBy: "day",
    groups: [group()],
    truncated: false,
    unpricedModels: [],
    ...overrides,
  };
}

describe("formatCost — the difference between free and unknown", () => {
  it("renders an unpriced figure as a dash, never as zero", () => {
    // The single most load-bearing assertion in the screen. `$0.00` asserts
    // the work was free; the dash says we have no rate for the model that
    // served it. Those are different claims and the second is the true one.
    expect(formatCost(null)).toBe("—");
  });

  it("renders a genuine zero as zero", () => {
    // The other half of the same distinction: a priced-and-free figure must
    // not be disguised as unknown either.
    expect(formatCost(0)).toBe("$0.00");
  });

  it("renders money to two places", () => {
    expect(formatCost(12.3456)).toBe("$12.35");
  });
});

describe("totalOf", () => {
  it("sums costs and counts across groups", () => {
    const total = totalOf([group({ cost: 1, runs: 2 }), group({ cost: 2.5, runs: 3 })]);
    expect(total.cost).toBeCloseTo(3.5, 6);
    expect(total.runs).toBe(5);
  });

  it("is null when nothing could be priced, rather than zero", () => {
    const total = totalOf([group({ cost: null }), group({ cost: null })]);
    expect(total.cost).toBeNull();
    expect(total.unpricedGroups).toBe(2);
  });

  it("does not let an unpriced group erase a priced one, in either order", () => {
    // The ordering case: `cost += group.cost` on a null start, or a `null`
    // short-circuit, would make the total depend on which group came first.
    const unpricedFirst = totalOf([group({ cost: null }), group({ cost: 4 })]);
    const pricedFirst = totalOf([group({ cost: 4 }), group({ cost: null })]);
    expect(unpricedFirst.cost).toBeCloseTo(4, 6);
    expect(pricedFirst.cost).toBeCloseTo(4, 6);
  });

  it("still counts an unpriced group's tokens toward the totals", () => {
    // Unpriced means "no rate", not "no work" — the counts are the truth and
    // the cost is a view of them, so dropping the tokens too would understate
    // what actually happened.
    const total = totalOf([group({ cost: null, inputTokens: 500 })]);
    expect(total.inputTokens).toBe(500);
  });
});

describe("completenessOf — three separate reasons a figure is partial", () => {
  it("calls a clean result complete", () => {
    expect(completenessOf(payload()).complete).toBe(true);
  });

  it("is incomplete when the group list was cut", () => {
    const result = completenessOf(payload({ truncated: true }));
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("is incomplete when a run could not be priced", () => {
    const result = completenessOf(payload({ groups: [group({ unpricedRuns: 3 })] }));
    expect(result.complete).toBe(false);
    expect(result.unpricedRuns).toBe(3);
  });

  it("is incomplete when a model has no configured rate", () => {
    const result = completenessOf(payload({ unpricedModels: ["local-llama"] }));
    expect(result.complete).toBe(false);
    expect(result.unpricedModels).toEqual(["local-llama"]);
  });

  it("sums unpriced runs across every group rather than reporting the first", () => {
    const result = completenessOf(
      payload({ groups: [group({ unpricedRuns: 2 }), group({ unpricedRuns: 3 })] }),
    );
    expect(result.unpricedRuns).toBe(5);
  });
});

describe("labelForKey — a missing key is a group, not an omission", () => {
  it("returns the key when there is one", () => {
    expect(labelForKey("sess-1", "session")).toBe("sess-1");
  });

  it("names why the key is missing, differently per grouping", () => {
    // "Unknown" for both would be true and useless: a run with no session was
    // ingested without one, whereas a run with no stage had an item in no
    // particular state.
    expect(labelForKey(null, "session")).toBe("No session recorded");
    expect(labelForKey(null, "stage")).toBe("No stage recorded");
    expect(labelForKey(null, "session")).not.toBe(labelForKey(null, "stage"));
  });
});

describe("shareOf", () => {
  it("is the group's fraction of the total", () => {
    expect(shareOf(group({ cost: 25 }), 100)).toBeCloseTo(0.25, 6);
  });

  it("is zero for an unpriced group rather than dividing", () => {
    // An unpriced group is not cheap, it is unknown — so it gets no bar,
    // while `formatCost` still shows its dash beside the empty bar.
    expect(shareOf(group({ cost: null }), 100)).toBe(0);
  });

  it("is zero when there is no total to take a share of", () => {
    expect(shareOf(group({ cost: 5 }), null)).toBe(0);
    expect(shareOf(group({ cost: 5 }), 0)).toBe(0);
  });

  it("never exceeds one", () => {
    // Defensive against a group larger than the total, which is reachable
    // when the total is a floor: a bar wider than its track would overflow
    // the cell.
    expect(shareOf(group({ cost: 500 }), 100)).toBe(1);
  });
});

describe("formatTokens", () => {
  it("leaves small counts alone", () => {
    expect(formatTokens(999)).toBe("999");
  });

  it("abbreviates thousands and millions", () => {
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });
});

describe("buildCostsQuery", () => {
  it("always sends groupBy, which has no server default", () => {
    expect(buildCostsQuery({ groupBy: "project" })).toContain("groupBy=project");
  });

  it("omits an absent filter rather than sending it empty", () => {
    // `?itemId=` is an `invalid_input` rejection, where "no item filter" is a
    // perfectly legal read.
    const query = buildCostsQuery({ groupBy: "day" });
    expect(query).not.toContain("itemId");
    expect(query).not.toContain("since");
  });

  it("includes the bounds it was given", () => {
    const query = buildCostsQuery({
      groupBy: "day",
      since: "2026-01-01T00:00:00.000Z",
      itemId: "item-a",
      limit: 10,
    });
    expect(query).toContain("since=2026-01-01");
    expect(query).toContain("itemId=item-a");
    expect(query).toContain("limit=10");
  });
});

describe("sinceForDays", () => {
  it("has no lower bound for all-time", () => {
    expect(sinceForDays(null, new Date("2026-03-05T12:00:00.000Z"))).toBeNull();
  });

  it("starts at a UTC midnight so the window aligns with the day buckets", () => {
    // A rolling "now minus N × 24h" boundary would cut the oldest day in
    // half and draw a partial bar that reads as a genuine drop in spend.
    const since = sinceForDays(7, new Date("2026-03-10T15:30:00.000Z"));
    expect(since).toBe("2026-03-04T00:00:00.000Z");
  });

  it("counts the current day as one of the days", () => {
    // A one-day window covers the day it is asked on, not the one before it.
    // An off-by-one here renders an empty screen for every reader whose most
    // recent spend is same-day.
    expect(sinceForDays(1, new Date("2026-03-10T15:30:00.000Z"))).toBe("2026-03-10T00:00:00.000Z");
  });
});

describe("costErrorMessageFrom", () => {
  it("passes an Error's message through, since fetchCosts throws showable ones", () => {
    expect(costErrorMessageFrom(new Error("GET /api/costs returned 500"))).toBe(
      "GET /api/costs returned 500",
    );
  });

  it("falls back to a readable message for a non-Error", () => {
    expect(costErrorMessageFrom("boom")).toBe("Could not load costs.");
  });
});
