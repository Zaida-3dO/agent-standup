// The time scrubber's transitions and readings — MILESTONES.md #87.
//
// Every transition is a pure function over a position, following
// `board/drag-state.ts`: React holds the value and these decide what it
// becomes. Tested as data for the same reason — "what does moving the
// scrubber do" is answerable by reading one module rather than by tracing
// an event handler.
import { describe, expect, it } from "vitest";
import type { BudgetWindow } from "@/lib/settings/budget-windows";
import {
  describeMoment,
  initialScrubber,
  readingsAt,
  scrubbedTo,
  scrubbedToFraction,
} from "@/lib/budget-page/scrubber";

const constant = (value: number) => ({ kind: "constant" as const, value });

const window: BudgetWindow = {
  enabled: true,
  lengthHours: 5,
  boundaries: { selective: constant(60), windDown: constant(80), stop: constant(95) },
};

describe("initialScrubber", () => {
  it("starts at the window's beginning — the state a reader assumes", () => {
    expect(initialScrubber()).toEqual({ atHours: 0 });
  });
});

describe("scrubbedTo", () => {
  it("moves to a position inside the window", () => {
    expect(scrubbedTo({ atHours: 0 }, 2.5, 5)).toEqual({ atHours: 2.5 });
  });

  // Clamped rather than refused: a drag that runs past the end is an
  // ordinary gesture, and stopping at the end is what it means.
  it("clamps past the end rather than refusing the move", () => {
    expect(scrubbedTo({ atHours: 0 }, 900, 5)).toEqual({ atHours: 5 });
  });

  it("clamps below zero", () => {
    expect(scrubbedTo({ atHours: 2 }, -4, 5)).toEqual({ atHours: 0 });
  });

  // A non-finite input would otherwise put the scrubber line at NaN, which
  // renders as a chart that silently stops drawing.
  it("ignores a non-finite position", () => {
    const state = { atHours: 2 };
    expect(scrubbedTo(state, Number.NaN, 5)).toBe(state);
  });

  // Returning the same object when nothing changed is what stops a render
  // loop in the container that holds this in state.
  it("returns the same state when the position did not change", () => {
    const state = { atHours: 2 };
    expect(scrubbedTo(state, 2, 5)).toBe(state);
  });
});

describe("scrubbedToFraction", () => {
  it("reads a fraction of the window as a position in hours", () => {
    expect(scrubbedToFraction({ atHours: 0 }, 0.5, 5)).toEqual({ atHours: 2.5 });
  });

  it("clamps a fraction past the end", () => {
    expect(scrubbedToFraction({ atHours: 0 }, 3, 5)).toEqual({ atHours: 5 });
  });
});

describe("readingsAt", () => {
  it("reports every boundary's value at the moment", () => {
    expect(readingsAt(window, 2)).toEqual([
      { key: "selective", label: "Selective", value: 60 },
      { key: "windDown", label: "Wind down", value: 80 },
      { key: "stop", label: "Stop", value: 95 },
    ]);
  });

  it("follows a moving boundary as the scrubber moves", () => {
    const moving: BudgetWindow = {
      ...window,
      boundaries: {
        ...window.boundaries,
        selective: { kind: "linear", slope: 10, offset: 20, per: "hour" },
      },
    };
    expect(readingsAt(moving, 0)[0]?.value).toBe(20);
    expect(readingsAt(moving, 3)[0]?.value).toBe(50);
  });
});

describe("describeMoment", () => {
  it("says the start plainly", () => {
    expect(describeMoment(0)).toBe("at the start");
  });

  // Below an hour, minutes are a time and a decimal is arithmetic.
  it("gives a sub-hour moment in minutes", () => {
    expect(describeMoment(0.25)).toBe("15 minutes in");
    expect(describeMoment(1 / 60)).toBe("1 minute in");
  });

  it("gives an hour or more in hours, matching the unit to the count", () => {
    expect(describeMoment(1)).toBe("1 hour in");
    expect(describeMoment(2.5)).toBe("2.5 hours in");
  });
});
