// The planner — MILESTONES.md #59, DECISIONS.md §5.
//
// The suite is built around the property the row names first: **the same
// inputs produce the same plan, every time.** That is not a nicety here.
// §5's two-machine race is safe *because* two machines handed the same
// candidates pack them identically ("the list is the allocation"), so a
// non-deterministic sort silently breaks an argument the design already
// made and would look, from outside, like an occasional double dispatch.
//
// Two things follow for how this is tested:
//
//  1. **Ties are seeded deliberately.** A fixture whose items all have
//     distinct priorities cannot test a tiebreak at all — the priority sort
//     alone orders it, and a broken tiebreak passes. Every ordering test
//     below therefore has at least two candidates at the *same* priority.
//  2. **Ordering is asserted against shuffled input**, not against input
//     that is already in the answer's order. Feeding a sorted array to a
//     sort and asserting it comes back sorted is a test that passes when
//     the sort is deleted.

import { describe, expect, it } from "vitest";
import {
  comparePlanCandidates,
  planDispatches,
  PLAN_PRIORITIES,
  type PlanCandidate,
  type PlanPriority,
} from "@/lib/heartbeat/plan";

const candidate = (
  id: string,
  priority: PlanPriority = "P2",
  estimatedPoints = 10,
): PlanCandidate => ({ id, priority, estimatedPoints });

/** Ids of the planned items, which is what almost every assertion is about. */
const planned = (input: Parameters<typeof planDispatches>[0]): readonly string[] =>
  planDispatches(input).dispatch.map((c) => c.id);

describe("planDispatches — sorting by priority", () => {
  it("dispatches more urgent work first", () => {
    expect(
      planned({
        candidates: [candidate("c", "P3"), candidate("a", "P0"), candidate("b", "P1")],
        headroomPoints: 100,
        inFlightPoints: 0,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("orders every priority the enum names, from shuffled input", () => {
    const shuffled = [
      candidate("p2", "P2"),
      candidate("p0", "P0"),
      candidate("p3", "P3"),
      candidate("p1", "P1"),
    ];
    expect(planned({ candidates: shuffled, headroomPoints: 100, inFlightPoints: 0 })).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("prefers a P0 over a P1 even when the P1 was listed first", () => {
    expect(
      planned({
        candidates: [candidate("first", "P1"), candidate("second", "P0")],
        headroomPoints: 100,
        inFlightPoints: 0,
      }),
    ).toEqual(["second", "first"]);
  });
});

// ── The tiebreak ─────────────────────────────────────────────────────────
//
// This block is the reason the row exists. Every candidate in it shares a
// priority, so priority sorting contributes nothing and the id tiebreak is
// the only thing producing the order. Delete the tiebreak and these fail;
// nothing else in the suite would.
describe("planDispatches — deterministic ordering on a genuine tie", () => {
  it("breaks a tie on id, ascending", () => {
    expect(
      planned({
        candidates: [
          candidate("item-c", "P1"),
          candidate("item-a", "P1"),
          candidate("item-b", "P1"),
        ],
        headroomPoints: 100,
        inFlightPoints: 0,
      }),
    ).toEqual(["item-a", "item-b", "item-c"]);
  });

  it("produces the same order however the tied input is arranged", () => {
    // Every permutation of three tied items must land on one answer. This
    // is the property directly: an unstable or input-order-dependent
    // tiebreak fails here even if it happens to look right for one input.
    const ids = ["x1", "x2", "x3"];
    const permutations = [
      ["x1", "x2", "x3"],
      ["x1", "x3", "x2"],
      ["x2", "x1", "x3"],
      ["x2", "x3", "x1"],
      ["x3", "x1", "x2"],
      ["x3", "x2", "x1"],
    ];

    for (const order of permutations) {
      expect(
        planned({
          candidates: order.map((id) => candidate(id, "P2")),
          headroomPoints: 100,
          inFlightPoints: 0,
        }),
      ).toEqual(ids);
    }
  });

  it("breaks a tie the same way when the tied items compete for headroom", () => {
    // The consequence of the tiebreak, not just its shape: with room for
    // exactly one of two tied items, *which* one is dispatched must be
    // fixed. A coin-flip tiebreak makes this a 50% flake — the failure
    // mode that hid in a merge gate here for weeks.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        planned({
          candidates: [candidate("bbb", "P1", 60), candidate("aaa", "P1", 60)],
          headroomPoints: 100,
          inFlightPoints: 0,
        }),
      ).toEqual(["aaa"]);
    }
  });

  it("is stable across repeated runs of the identical input", () => {
    const candidates = [
      candidate("m", "P1"),
      candidate("d", "P1"),
      candidate("z", "P0"),
      candidate("a", "P1"),
      candidate("k", "P0"),
    ];
    const first = planned({ candidates, headroomPoints: 100, inFlightPoints: 0 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(planned({ candidates, headroomPoints: 100, inFlightPoints: 0 })).toEqual(first);
    }
    expect(first).toEqual(["k", "z", "a", "d", "m"]);
  });

  it("orders ids by code point rather than by locale", () => {
    // `localeCompare` would order these differently under some locales,
    // which is a cross-machine divergence invisible in a one-locale suite.
    // Asserting the code-point answer pins the comparison that was chosen.
    expect(
      planned({
        candidates: [candidate("b", "P1"), candidate("B", "P1"), candidate("a", "P1")],
        headroomPoints: 100,
        inFlightPoints: 0,
      }),
    ).toEqual(["B", "a", "b"]);
  });

  it("does not reorder the caller's array", () => {
    const candidates = [candidate("c", "P1"), candidate("a", "P1")];
    planDispatches({ candidates, headroomPoints: 100, inFlightPoints: 0 });
    expect(candidates.map((c) => c.id)).toEqual(["c", "a"]);
  });
});

describe("comparePlanCandidates — a total order", () => {
  it("never returns 0 for two distinct ids", () => {
    expect(comparePlanCandidates(candidate("a"), candidate("b"))).toBeLessThan(0);
    expect(comparePlanCandidates(candidate("b"), candidate("a"))).toBeGreaterThan(0);
  });

  it("is antisymmetric across a priority difference", () => {
    const urgent = candidate("z", "P0");
    const routine = candidate("a", "P3");
    expect(comparePlanCandidates(urgent, routine)).toBeLessThan(0);
    expect(comparePlanCandidates(routine, urgent)).toBeGreaterThan(0);
  });

  it("sorts an unrecognised priority last rather than throwing", () => {
    // Unattended code on a five-minute timer: one row with a priority this
    // build does not know must not stop the machine dispatching anything.
    const unknown = { id: "u", priority: "P9" as PlanPriority, estimatedPoints: 1 };
    expect(
      planned({
        candidates: [unknown, candidate("a", "P3")],
        headroomPoints: 100,
        inFlightPoints: 0,
      }),
    ).toEqual(["a", "u"]);
  });
});

describe("planDispatches — packing against headroom", () => {
  it("fills until the headroom is exhausted", () => {
    expect(
      planned({
        candidates: [candidate("a", "P0", 40), candidate("b", "P1", 40), candidate("c", "P2", 40)],
        headroomPoints: 100,
        inFlightPoints: 0,
      }),
    ).toEqual(["a", "b"]);
  });

  it("reports the arithmetic behind the plan", () => {
    const plan = planDispatches({
      candidates: [candidate("a", "P0", 30), candidate("b", "P1", 25)],
      headroomPoints: 100,
      inFlightPoints: 20,
    });
    expect(plan.committedPoints).toBe(55);
    // 100 headroom − 20 in-flight − 55 committed.
    expect(plan.remainingPoints).toBe(25);
  });

  it("takes an item costing exactly the remaining headroom", () => {
    // The boundary. Headroom is a budget to spend, not a level to stay
    // under — refusing the exact fit idles a machine against a window it
    // was entitled to use.
    const plan = planDispatches({
      candidates: [candidate("exact", "P1", 100)],
      headroomPoints: 100,
      inFlightPoints: 0,
    });
    expect(plan.dispatch.map((c) => c.id)).toEqual(["exact"]);
    expect(plan.remainingPoints).toBe(0);
  });

  it("refuses an item one point over the remaining headroom", () => {
    const plan = planDispatches({
      candidates: [candidate("over", "P1", 101)],
      headroomPoints: 100,
      inFlightPoints: 0,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.skipped).toEqual([{ id: "over", reason: "no-headroom" }]);
  });

  // ── Zero headroom, from three directions ──────────────────────────────
  it("plans nothing when there is no headroom at all", () => {
    const plan = planDispatches({
      candidates: [candidate("a", "P0", 1)],
      headroomPoints: 0,
      inFlightPoints: 0,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.committedPoints).toBe(0);
    expect(plan.remainingPoints).toBe(0);
    expect(plan.skipped).toEqual([{ id: "a", reason: "no-headroom" }]);
  });

  it("plans nothing when in-flight work has consumed the window", () => {
    expect(
      planned({
        candidates: [candidate("a", "P0", 1)],
        headroomPoints: 50,
        inFlightPoints: 50,
      }),
    ).toEqual([]);
  });

  it("plans nothing when in-flight work has overrun the window", () => {
    // Wind-down is the backstop for an overrun (§5), so the planner's job
    // here is simply to start nothing more — and never to report a
    // negative remaining, which reads as headroom to spend.
    const plan = planDispatches({
      candidates: [candidate("a", "P0", 1)],
      headroomPoints: 50,
      inFlightPoints: 80,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.remainingPoints).toBe(0);
  });

  it("still dispatches a zero-cost item against zero headroom", () => {
    // Consistent with the exact-fit rule: 0 <= 0. Nothing is spent, so
    // there is no reason to withhold it.
    expect(
      planned({
        candidates: [candidate("free", "P1", 0)],
        headroomPoints: 0,
        inFlightPoints: 0,
      }),
    ).toEqual(["free"]);
  });

  it("subtracts in-flight work before packing", () => {
    // Second of §5's two conditions. Without the subtraction both items
    // fit, so this fails loudly if in-flight stops being counted.
    expect(
      planned({
        candidates: [candidate("a", "P0", 30), candidate("b", "P1", 30)],
        headroomPoints: 100,
        inFlightPoints: 50,
      }),
    ).toEqual(["a"]);
  });

  it("plans nothing from no candidates, which is the common tick", () => {
    const plan = planDispatches({ candidates: [], headroomPoints: 100, inFlightPoints: 0 });
    expect(plan.dispatch).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.remainingPoints).toBe(100);
  });
});

describe("planDispatches — first fit, not greedy stop", () => {
  it("keeps packing past an item too expensive to fit", () => {
    // The distinguishing behaviour. Under greedy-stop the answer would be
    // ["big"] alone — one expensive item would block a machine with room
    // for cheaper work behind it.
    expect(
      planned({
        candidates: [
          candidate("big", "P0", 60),
          candidate("huge", "P1", 60),
          candidate("small", "P2", 30),
        ],
        headroomPoints: 100,
        inFlightPoints: 0,
      }),
    ).toEqual(["big", "small"]);
  });

  it("records why each unplanned item was skipped", () => {
    const plan = planDispatches({
      candidates: [candidate("fits", "P0", 60), candidate("nope", "P1", 60)],
      headroomPoints: 100,
      inFlightPoints: 0,
    });
    expect(plan.skipped).toEqual([{ id: "nope", reason: "no-headroom" }]);
  });

  it("does not let a skipped item consume headroom", () => {
    const plan = planDispatches({
      candidates: [
        candidate("a", "P0", 60),
        candidate("skipped", "P1", 90),
        candidate("b", "P2", 40),
      ],
      headroomPoints: 100,
      inFlightPoints: 0,
    });
    expect(plan.dispatch.map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.committedPoints).toBe(100);
  });
});

describe("planDispatches — estimates it cannot use", () => {
  const unusable = (points: number): PlanCandidate => ({
    id: "bad",
    priority: "P1",
    estimatedPoints: points,
  });

  it("skips a NaN estimate rather than packing against it", () => {
    // NaN compares false against everything, so an unguarded planner would
    // skip it too — but silently, and it would also poison `committed` if
    // the comparison were ever flipped. The explicit reason is what makes
    // it diagnosable.
    const plan = planDispatches({
      candidates: [unusable(Number.NaN)],
      headroomPoints: 100,
      inFlightPoints: 0,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.skipped).toEqual([{ id: "bad", reason: "not-estimable" }]);
    expect(plan.committedPoints).toBe(0);
  });

  it("skips a negative estimate, which would hand back headroom", () => {
    // The dangerous one: a negative estimate would *increase* remaining
    // headroom and let the planner over-dispatch without limit.
    const plan = planDispatches({
      candidates: [unusable(-50), candidate("real", "P1", 100)],
      headroomPoints: 100,
      inFlightPoints: 0,
    });
    expect(plan.dispatch.map((c) => c.id)).toEqual(["real"]);
    expect(plan.committedPoints).toBe(100);
  });

  it("skips an infinite estimate", () => {
    const plan = planDispatches({
      candidates: [unusable(Number.POSITIVE_INFINITY)],
      headroomPoints: 100,
      inFlightPoints: 0,
    });
    expect(plan.skipped).toEqual([{ id: "bad", reason: "not-estimable" }]);
  });

  it("keeps dispatching usable work alongside an unusable estimate", () => {
    // One malformed row must not cost the tick.
    expect(
      planned({
        candidates: [unusable(Number.NaN), candidate("good", "P2", 10)],
        headroomPoints: 100,
        inFlightPoints: 0,
      }),
    ).toEqual(["good"]);
  });
});

describe("the priority list is the sort order", () => {
  it("names the four priorities, most urgent first", () => {
    expect([...PLAN_PRIORITIES]).toEqual(["P0", "P1", "P2", "P3"]);
  });
});
