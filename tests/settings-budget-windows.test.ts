// The `budget.windows` shape and its crossing check (SCHEMA.md §17.4).
//
// The check under test is the one §17.4 calls worth the most: boundaries
// with different slopes cross somewhere, and the crossing point is where
// the system would be told to wind down harder than it stops. A validator
// that only looked at the values as written would pass every moving
// boundary here, so most of these tests are pairs — a coherent value that
// must be accepted, and one that is coherent *at the start* and crosses
// later, which must be rejected.
import { describe, expect, it } from "vitest";
import {
  boundaryAt,
  budgetWindowsSchema,
  findCrossings,
  type Boundary,
  type BudgetWindow,
} from "@/lib/settings/budget-windows";

function windowWith(boundaries: Record<string, unknown>, lengthHours = 5): Record<string, unknown> {
  return { enabled: true, lengthHours, boundaries };
}

const constant = (value: number) => ({ kind: "constant" as const, value });

describe("the boundary shapes", () => {
  it("accepts a constant, a linear and a schedule", () => {
    const value = {
      fiveHour: windowWith({
        selective: constant(50),
        windDown: { kind: "linear", slope: 1, offset: 70, per: "hour" },
        stop: {
          kind: "schedule",
          entries: [
            { at: { elapsed: 0, per: "hour" }, value: constant(90) },
            { at: { remaining: 1, per: "hour" }, value: constant(98) },
          ],
        },
      }),
    };
    expect(budgetWindowsSchema.safeParse(value).success).toBe(true);
  });

  it("rejects a boundary kind it does not know", () => {
    const value = {
      fiveHour: windowWith({
        selective: { kind: "exponential", base: 2 },
        windDown: constant(80),
        stop: constant(95),
      }),
    };
    expect(budgetWindowsSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a schedule inside a schedule", () => {
    // §17.4: one level expresses every rule anyone has wanted; the second
    // level is where a shape becomes a language.
    const value = {
      fiveHour: windowWith({
        selective: constant(50),
        windDown: constant(80),
        stop: {
          kind: "schedule",
          entries: [
            {
              at: { elapsed: 0, per: "hour" },
              value: {
                kind: "schedule",
                entries: [{ at: { elapsed: 0, per: "hour" }, value: constant(90) }],
              },
            },
          ],
        },
      }),
    };
    expect(budgetWindowsSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an empty schedule, which would have no value at any moment", () => {
    const value = {
      fiveHour: windowWith({
        selective: constant(50),
        windDown: constant(80),
        stop: { kind: "schedule", entries: [] },
      }),
    };
    // Rejects — and does so by returning, not by throwing. safeParse is
    // the whole contract of a write-time validator, and a validator that
    // throws on malformed input is a 500 where a 400 was meant, on the one
    // path whose entire job is to say no politely.
    expect(() => budgetWindowsSchema.safeParse(value)).not.toThrow();
    expect(budgetWindowsSchema.safeParse(value).success).toBe(false);
  });

  it("rejects rather than throws on every malformed shape a write could carry", () => {
    // A refinement runs even when the shape it refines failed to parse, so
    // anything reached from one has to be total. Each of these is a value
    // that fails the shape and then reaches the crossing check.
    const malformed: unknown[] = [
      { w: windowWith({ selective: constant(50), windDown: constant(80) }) },
      { w: windowWith({ selective: null, windDown: constant(80), stop: constant(95) }) },
      { w: { enabled: true, lengthHours: 5 } },
      { w: { enabled: true, lengthHours: 0, boundaries: {} } },
      { w: null },
      { w: [] },
      {
        w: windowWith({
          selective: { kind: "schedule" },
          windDown: constant(80),
          stop: constant(95),
        }),
      },
    ];
    for (const value of malformed) {
      expect(() => budgetWindowsSchema.safeParse(value), JSON.stringify(value)).not.toThrow();
      expect(budgetWindowsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("reports a missing value rather than crashing when a schedule has no entry in force", () => {
    // findCrossings is reachable directly, so its own totality matters too.
    const window = windowWith({
      selective: constant(50),
      windDown: constant(80),
      stop: { kind: "schedule", entries: [] },
    }) as unknown as BudgetWindow;
    const problems = findCrossings(window);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.message.includes("no value"))).toBe(true);
  });

  it("returns null from boundaryAt for a schedule with nothing in it", () => {
    expect(boundaryAt({ kind: "schedule", entries: [] } as never, 0, 5)).toBeNull();
  });

  it("rejects an unknown field rather than ignoring it", () => {
    // A typo'd field silently dropped is a rule the operator believes they
    // configured and that never fires.
    const value = {
      fiveHour: windowWith({
        selective: { kind: "constant", value: 50, untilHour: 3 },
        windDown: constant(80),
        stop: constant(95),
      }),
    };
    expect(budgetWindowsSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a window missing one of its three boundaries", () => {
    const value = { fiveHour: windowWith({ selective: constant(50), stop: constant(95) }) };
    expect(budgetWindowsSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a window with no length, which leaves a schedule unanchored", () => {
    const value = {
      fiveHour: {
        enabled: true,
        boundaries: { selective: constant(50), windDown: constant(80), stop: constant(95) },
      },
    };
    expect(budgetWindowsSchema.safeParse(value).success).toBe(false);
  });

  it("accepts an empty map, which is the default", () => {
    expect(budgetWindowsSchema.safeParse({}).success).toBe(true);
  });
});

describe("evaluating a boundary at a moment", () => {
  it("returns a constant unchanged wherever it is asked", () => {
    expect(boundaryAt(constant(80), 0, 5)).toBe(80);
    expect(boundaryAt(constant(80), 5, 5)).toBe(80);
  });

  it("moves a linear with elapsed time", () => {
    // 15 × days − 5, the shape §17.4 gives as the example.
    const linear: Boundary = { kind: "linear", slope: 15, offset: -5, per: "day" };
    expect(boundaryAt(linear, 0, 168)).toBe(-5);
    expect(boundaryAt(linear, 24, 168)).toBe(10);
    expect(boundaryAt(linear, 48, 168)).toBe(25);
  });

  it("anchors a schedule entry from the end of the window when written that way", () => {
    // "80, rising to 92 in the final hour" — the entry must take effect at
    // hour 4 of a 5-hour window, not hour 1.
    const schedule: Boundary = {
      kind: "schedule",
      entries: [
        { at: { elapsed: 0, per: "hour" }, value: constant(80) },
        { at: { remaining: 1, per: "hour" }, value: constant(92) },
      ],
    };
    expect(boundaryAt(schedule, 0, 5)).toBe(80);
    expect(boundaryAt(schedule, 3.9, 5)).toBe(80);
    expect(boundaryAt(schedule, 4, 5)).toBe(92);
    expect(boundaryAt(schedule, 5, 5)).toBe(92);
  });

  it("holds a schedule entry until the next one starts", () => {
    const schedule: Boundary = {
      kind: "schedule",
      entries: [
        { at: { elapsed: 0, per: "hour" }, value: constant(10) },
        { at: { elapsed: 2, per: "hour" }, value: constant(20) },
        { at: { elapsed: 4, per: "hour" }, value: constant(30) },
      ],
    };
    expect(boundaryAt(schedule, 1.99, 5)).toBe(10);
    expect(boundaryAt(schedule, 2, 5)).toBe(20);
    expect(boundaryAt(schedule, 3.99, 5)).toBe(20);
    expect(boundaryAt(schedule, 4, 5)).toBe(30);
  });

  it("applies the first entry before it starts rather than leaving a hole", () => {
    const schedule: Boundary = {
      kind: "schedule",
      entries: [{ at: { elapsed: 2, per: "hour" }, value: constant(40) }],
    };
    expect(boundaryAt(schedule, 0, 5)).toBe(40);
  });
});

describe("the crossing check", () => {
  it("accepts boundaries that stay in order for the whole window", () => {
    const window = windowWith({
      selective: constant(50),
      windDown: constant(80),
      stop: constant(95),
    }) as unknown as BudgetWindow;
    expect(findCrossings(window)).toEqual([]);
  });

  it("rejects boundaries already out of order at the start", () => {
    const window = windowWith({
      selective: constant(90),
      windDown: constant(80),
      stop: constant(95),
    }) as unknown as BudgetWindow;
    const problems = findCrossings(window);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.message).toContain("above");
  });

  // The case the check exists for: correct as written, wrong later.
  it("rejects two lines that are in order at the start and cross partway through", () => {
    const window = windowWith({
      selective: { kind: "linear", slope: 10, offset: 40, per: "hour" },
      // Starts above selective (80 > 40) and is overtaken at hour 4.
      windDown: constant(80),
      stop: constant(95),
    }) as unknown as BudgetWindow;

    const problems = findCrossings(window);
    expect(problems.length).toBeGreaterThan(0);
    // And it names the moment, which is the whole value of sampling.
    expect(problems[0]?.atHours).toBeGreaterThan(3);
    expect(problems.some((p) => p.message.includes("selective"))).toBe(true);
  });

  // Sampling only the two endpoints would pass this: the boundaries are in
  // order at hour 0 and back in order by hour 5, and cross only in the
  // middle. That is the exact shape §17.4 describes — two lines with
  // different slopes cross *somewhere* — so a check that looks only at the
  // ends is not doing the job the section asks for.
  it("catches a crossing that happens strictly between the endpoints", () => {
    const window = windowWith({
      // A shallow V: dips below wind down around the middle of the window
      // and returns above it by the end.
      selective: {
        kind: "schedule",
        entries: [
          { at: { elapsed: 0, per: "hour" }, value: constant(40) },
          { at: { elapsed: 2, per: "hour" }, value: constant(90) },
          { at: { elapsed: 4, per: "hour" }, value: constant(40) },
        ],
      },
      windDown: constant(80),
      stop: constant(95),
    }) as unknown as BudgetWindow;

    const problems = findCrossings(window);
    // In order at both ends...
    expect(boundaryAt(window.boundaries.selective, 0, 5)).toBeLessThan(80);
    expect(boundaryAt(window.boundaries.selective, 5, 5)).toBeLessThan(80);
    // ...and crossed in the middle, which is what must be caught.
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.atHours > 0 && p.atHours < 5)).toBe(true);
  });

  // This is the case that makes the even grid load-bearing, and it is worth
  // being precise about why, because most mid-window violations do NOT
  // need it: constants and linears are monotonic, so any violation between
  // two of them is still present at an endpoint, and a schedule's switch
  // points are sampled explicitly whatever the grid is.
  //
  // What neither covers is a schedule entry holding a *linear*, which moves
  // within its own segment. Here the boundary is in range at hour 0, at its
  // own switch point (hour 1) and at hour 5, and climbs past 100 in between
  // — so only a sample strictly inside the segment sees it.
  it("catches a violation inside a schedule segment, between its switch points", () => {
    const window = windowWith({
      selective: constant(10),
      windDown: constant(20),
      stop: {
        kind: "schedule",
        entries: [
          { at: { elapsed: 0, per: "hour" }, value: constant(30) },
          // In force from hour 1 to hour 4. A linear only ever moves one
          // way, so the segment is bounded by the next entry rather than
          // by the line coming back — it is 40 at its own start and 100 at
          // hour 3, and exceeds 100 strictly inside its own span.
          {
            at: { elapsed: 1, per: "hour" },
            value: { kind: "linear", slope: 30, offset: 10, per: "hour" },
          },
          { at: { elapsed: 4, per: "hour" }, value: constant(50) },
        ],
      },
    }) as unknown as BudgetWindow;

    // In range at hour 0, at both switch points, and at the end.
    for (const at of [0, 1, 4, 5]) {
      const value = boundaryAt(window.boundaries.stop, at, 5);
      expect(value, `hour ${at}`).not.toBeNull();
      expect(value!, `hour ${at}`).toBeLessThanOrEqual(100);
    }
    // At hour 3.1 the segment's linear is 10 + 30×3.1 = 103, out of range.
    expect(boundaryAt(window.boundaries.stop, 3.1, 5)!).toBeGreaterThan(100);

    const problems = findCrossings(window);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.message.includes("outside 0–100"))).toBe(true);
    // And the moment named is strictly inside the segment, not a switch
    // point — which is what a coarser grid would fail to report.
    expect(problems.some((p) => p.atHours > 1 && p.atHours < 4)).toBe(true);
  });

  it("rejects a boundary that leaves 0–100 partway through", () => {
    const window = windowWith({
      selective: constant(50),
      windDown: constant(80),
      // Climbs past 100 before the window ends.
      stop: { kind: "linear", slope: 10, offset: 90, per: "hour" },
    }) as unknown as BudgetWindow;
    const problems = findCrossings(window);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.message.includes("outside 0–100"))).toBe(true);
  });

  it("rejects a negative boundary", () => {
    const window = windowWith({
      selective: constant(-10),
      windDown: constant(80),
      stop: constant(95),
    }) as unknown as BudgetWindow;
    expect(findCrossings(window).some((p) => p.message.includes("outside"))).toBe(true);
  });

  it("catches a crossing that a schedule introduces only at its own switch point", () => {
    // A schedule's discontinuities are not on an even grid, so the sample
    // points include every entry's own start. Here everything is in order
    // until hour 3, at which point stop drops below wind down.
    const window = windowWith({
      selective: constant(40),
      windDown: constant(80),
      stop: {
        kind: "schedule",
        entries: [
          { at: { elapsed: 0, per: "hour" }, value: constant(95) },
          { at: { elapsed: 3, per: "hour" }, value: constant(60) },
        ],
      },
    }) as unknown as BudgetWindow;

    const problems = findCrossings(window);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.atHours >= 3)).toBe(true);
  });

  // Every other schedule case here uses a whole-hour switch point, which
  // happens to land on the even grid — so none of them prove the explicit
  // switch-point sampling does anything. This one puts the switch at a
  // moment the grid cannot land on, and makes the violation exist only
  // from that moment: it is found only because the entry's own start is
  // sampled regardless of the grid.
  it("catches a violation at a switch point that falls between grid points", () => {
    const switchAt = 3.017; // not a multiple of any sane grid step
    const window = windowWith({
      selective: constant(10),
      windDown: constant(20),
      stop: {
        kind: "schedule",
        entries: [
          { at: { elapsed: 0, per: "hour" }, value: constant(90) },
          // For this one narrow stretch stop sits below wind down — the
          // system told to wind down harder than it stops — and then
          // recovers, so the endpoints see nothing wrong.
          { at: { elapsed: switchAt, per: "hour" }, value: constant(15) },
          { at: { elapsed: switchAt + 0.011, per: "hour" }, value: constant(90) },
        ],
      },
    }) as unknown as BudgetWindow;

    // Fine at both endpoints, so only an interior sample can find it.
    expect(boundaryAt(window.boundaries.stop, 0, 5)).toBe(90);
    expect(boundaryAt(window.boundaries.stop, 5, 5)).toBe(90);

    const problems = findCrossings(window);
    expect(problems.length).toBeGreaterThan(0);
    // Reported at the switch point itself — a moment no even grid over a
    // 5-hour window lands on.
    expect(problems.some((p) => p.atHours === switchAt)).toBe(true);
  });

  it("accepts a schedule that rises without ever crossing", () => {
    // "80, rising to 92 in the final hour" — the §17.4 example, which must
    // not be rejected by a check tuned to catch the one above.
    const window = windowWith({
      selective: constant(50),
      windDown: {
        kind: "schedule",
        entries: [
          { at: { elapsed: 0, per: "hour" }, value: constant(80) },
          { at: { remaining: 1, per: "hour" }, value: constant(92) },
        ],
      },
      stop: constant(98),
    }) as unknown as BudgetWindow;
    expect(findCrossings(window)).toEqual([]);
  });

  it("allows boundaries that touch without crossing", () => {
    // At-or-below, not strictly below: two bands meeting at a point is a
    // band with no width, not an inversion.
    const window = windowWith({
      selective: constant(80),
      windDown: constant(80),
      stop: constant(95),
    }) as unknown as BudgetWindow;
    expect(findCrossings(window)).toEqual([]);
  });
});

describe("the schema runs the crossing check", () => {
  // The check is worth nothing if the schema does not call it — this is
  // what connects §17.4's guarantee to an actual write.
  it("refuses a crossing value and names the window it is in", () => {
    const parsed = budgetWindowsSchema.safeParse({
      weekly: windowWith(
        {
          selective: { kind: "linear", slope: 10, offset: 40, per: "hour" },
          windDown: constant(80),
          stop: constant(95),
        },
        5,
      ),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(" ");
      expect(message).toContain("weekly");
    }
  });

  it("checks every window, not only the first", () => {
    const parsed = budgetWindowsSchema.safeParse({
      fine: windowWith({
        selective: constant(50),
        windDown: constant(80),
        stop: constant(95),
      }),
      broken: windowWith({
        selective: constant(99),
        windDown: constant(80),
        stop: constant(95),
      }),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toContain("broken");
    }
  });
});
