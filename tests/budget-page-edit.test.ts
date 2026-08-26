// The budget-window editor's model — MILESTONES.md #87.
//
// Every function under test is pure, so these run in the repo's default
// `environment: "node"` with no DOM. What is asserted is behaviour a reader
// would notice: that a half-typed field does not become a number, that a
// preset is coherent, that switching kind does not destroy what was typed,
// and that a collision is described in the labels the form actually shows.
import { describe, expect, it } from "vitest";
import { findCrossings, type Boundary, type BudgetWindow } from "@/lib/settings/budget-windows";
import {
  BAND_FIELD_LABELS,
  PRESETS,
  bandsInProblem,
  boundaryFromDraft,
  boundaryToDraft,
  describeProblem,
  describeRun,
  draftIncompleteness,
  emptyBoundaryDraft,
  fieldNumber,
  groupProblemRuns,
  presetDraft,
  presetWindow,
  problemPercent,
  windowFromDraft,
  windowToDraft,
  windowsFromDraft,
  windowsToDraft,
  withEntry,
  withEntryAdded,
  withEntryRemoved,
  withKind,
  withWindowAdded,
  withWindowRemoved,
  type WindowDraft,
} from "@/lib/budget-page/edit";

/** A coherent window, as the fixtures in the sibling suites build one. */
function aWindow(): BudgetWindow {
  return {
    enabled: true,
    lengthHours: 24,
    boundaries: {
      selective: { kind: "constant", value: 50 },
      windDown: { kind: "constant", value: 75 },
      stop: { kind: "constant", value: 90 },
    },
  };
}

describe("fieldNumber", () => {
  it("reads a number that has been fully typed", () => {
    expect(fieldNumber("42")).toBe(42);
    expect(fieldNumber(" -5.5 ")).toBe(-5.5);
  });

  it("treats a blank field as unsaid rather than as zero", () => {
    // The distinction the whole draft-as-text design exists for: an empty
    // box means "not filled in", and a zero is a value somebody chose. If
    // this returned 0 the editor would happily save a boundary nobody wrote.
    expect(fieldNumber("")).toBeNull();
    expect(fieldNumber("   ")).toBeNull();
  });

  it("refuses half-typed and non-numeric input instead of coercing it", () => {
    expect(fieldNumber("1e")).toBeNull();
    expect(fieldNumber("-")).toBeNull();
    expect(fieldNumber("abc")).toBeNull();
    // Number("Infinity") is finite-checked, so a boundary cannot be infinite.
    expect(fieldNumber("Infinity")).toBeNull();
  });
});

describe("boundaryToDraft / boundaryFromDraft", () => {
  it("round-trips a constant", () => {
    const draft = boundaryToDraft({ kind: "constant", value: 80 });
    expect(draft.constantValue).toBe("80");
    expect(boundaryFromDraft(draft)).toEqual({ kind: "constant", value: 80 });
  });

  it("round-trips a linear, keeping its unit", () => {
    const draft = boundaryToDraft({ kind: "linear", slope: 15, offset: -5, per: "day" });
    expect(draft.slope).toBe("15");
    expect(draft.offset).toBe("-5");
    expect(draft.per).toBe("day");
    expect(boundaryFromDraft(draft)).toEqual({
      kind: "linear",
      slope: 15,
      offset: -5,
      per: "day",
    });
  });

  it("round-trips a schedule anchored from each end, keeping which end was meant", () => {
    // "after 2 hours" and "in the final 2 hours" are the same digits and a
    // different rule. If the draft lost `anchorFrom`, this round-trip would
    // silently rewrite one as the other.
    const original: Boundary = {
      kind: "schedule",
      entries: [
        { at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 60 } },
        { at: { remaining: 2, per: "hour" }, value: { kind: "constant", value: 90 } },
      ],
    };
    const draft = boundaryToDraft(original);
    expect(draft.entries[0]?.anchorFrom).toBe("elapsed");
    expect(draft.entries[1]?.anchorFrom).toBe("remaining");
    expect(draft.entries[1]?.anchorAmount).toBe("2");
    expect(boundaryFromDraft(draft)).toEqual(original);
  });

  it("round-trips a schedule entry holding a linear", () => {
    const original: Boundary = {
      kind: "schedule",
      entries: [
        {
          at: { elapsed: 1, per: "day" },
          value: { kind: "linear", slope: -3, offset: 70, per: "day" },
        },
      ],
    };
    expect(boundaryFromDraft(boundaryToDraft(original))).toEqual(original);
  });

  it("is incomplete, not zero, while a field is blank", () => {
    expect(boundaryFromDraft(emptyBoundaryDraft("constant"))).toBeNull();
    expect(boundaryFromDraft(emptyBoundaryDraft("linear"))).toBeNull();
  });

  it("refuses a linear with only one of its two numbers filled in", () => {
    const draft = { ...emptyBoundaryDraft("linear"), slope: "5" };
    expect(boundaryFromDraft(draft)).toBeNull();
  });

  it("refuses a negative schedule anchor rather than clamping it to zero", () => {
    // The schema says `nonnegative`. Clamping would store a rule nobody
    // wrote; refusing leaves the form incomplete, which is the truth.
    const base = boundaryToDraft({
      kind: "schedule",
      entries: [{ at: { elapsed: 1, per: "hour" }, value: { kind: "constant", value: 50 } }],
    });
    const negative = withEntry(base, 0, { ...base.entries[0]!, anchorAmount: "-2" });
    expect(boundaryFromDraft(negative)).toBeNull();
  });
});

describe("withKind", () => {
  it("keeps what was typed into the other kinds", () => {
    // Switching kind to look at another shape and switching back must not
    // silently empty the fields — which is what a discriminated union of
    // drafts would have done.
    const constant = boundaryToDraft({ kind: "constant", value: 80 });
    const asLinear = withKind(constant, "linear");
    expect(asLinear.kind).toBe("linear");
    expect(asLinear.constantValue).toBe("80");
    expect(withKind(asLinear, "constant").constantValue).toBe("80");
  });

  it("seeds a step when switching to a schedule with none", () => {
    const empty = { ...emptyBoundaryDraft("constant"), entries: [] };
    expect(withKind(empty, "schedule").entries).toHaveLength(1);
  });

  it("returns the same draft when the kind has not changed", () => {
    const draft = emptyBoundaryDraft("linear");
    expect(withKind(draft, "linear")).toBe(draft);
  });
});

describe("schedule step editing", () => {
  it("adds a step by copying the last, since a step is usually a variation", () => {
    const draft = boundaryToDraft({
      kind: "schedule",
      entries: [{ at: { elapsed: 3, per: "hour" }, value: { kind: "constant", value: 55 } }],
    });
    const added = withEntryAdded(draft);
    expect(added.entries).toHaveLength(2);
    expect(added.entries[1]?.constantValue).toBe("55");
    // A copy, not the same object — editing one step must not edit the other.
    expect(added.entries[1]).not.toBe(added.entries[0]);
  });

  it("refuses to remove the last step, because an empty schedule is unsaveable", () => {
    const one = boundaryToDraft({
      kind: "schedule",
      entries: [{ at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 50 } }],
    });
    expect(withEntryRemoved(one, 0)).toBe(one);
  });

  it("removes a step when more than one remains", () => {
    const two = withEntryAdded(
      boundaryToDraft({
        kind: "schedule",
        entries: [{ at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 50 } }],
      }),
    );
    expect(withEntryRemoved(two, 0).entries).toHaveLength(1);
  });

  it("ignores an out-of-range index rather than corrupting the list", () => {
    const two = withEntryAdded(emptyBoundaryDraft("schedule"));
    expect(withEntryRemoved(two, 9).entries).toHaveLength(2);
    expect(withEntry(two, 9, two.entries[0]!)).toBe(two);
  });
});

describe("windowFromDraft", () => {
  it("round-trips a whole window", () => {
    expect(windowFromDraft(windowToDraft(aWindow()))).toEqual(aWindow());
  });

  it("refuses a zero or negative length, which the schema calls positive", () => {
    const draft = { ...windowToDraft(aWindow()), lengthHours: "0" };
    expect(windowFromDraft(draft)).toBeNull();
    expect(windowFromDraft({ ...draft, lengthHours: "-4" })).toBeNull();
  });

  it("carries the enabled flag through unchanged", () => {
    const off = windowToDraft({ ...aWindow(), enabled: false });
    expect(windowFromDraft(off)?.enabled).toBe(false);
  });
});

describe("draftIncompleteness", () => {
  it("says nothing when the draft is ready to save", () => {
    expect(draftIncompleteness(windowToDraft(aWindow()))).toBeNull();
  });

  it("asks for a length before anything else", () => {
    const draft: WindowDraft = { ...windowToDraft(aWindow()), lengthHours: "" };
    expect(draftIncompleteness(draft)).toBe("Give the window a length in hours.");
  });

  it("distinguishes a length that is missing from one that is not positive", () => {
    const draft: WindowDraft = { ...windowToDraft(aWindow()), lengthHours: "0" };
    expect(draftIncompleteness(draft)).toContain("more than zero");
  });

  it("names the band whose fields are empty, in the label the form shows", () => {
    const draft = windowToDraft(aWindow());
    const blanked: WindowDraft = {
      ...draft,
      boundaries: { ...draft.boundaries, windDown: emptyBoundaryDraft("constant") },
    };
    const message = draftIncompleteness(blanked);
    // "Wind down", not "windDown" — the reader is looking at a labelled field.
    expect(message).toContain(BAND_FIELD_LABELS.windDown);
    expect(message).not.toContain("windDown");
  });

  it("says a schedule needs a moment and a value, not just 'fill in the fields'", () => {
    const draft = windowToDraft(aWindow());
    const withSchedule: WindowDraft = {
      ...draft,
      boundaries: { ...draft.boundaries, stop: emptyBoundaryDraft("schedule") },
    };
    expect(draftIncompleteness(withSchedule)).toContain("schedule");
  });
});

describe("presets", () => {
  it.each(PRESETS)("%s is a coherent window with no crossings", (name) => {
    // The property that matters: picking a preset can never land the editor
    // in a faulted state. Asserted against the real checker rather than by
    // eyeballing the numbers.
    expect(findCrossings(presetWindow(name))).toEqual([]);
  });

  it.each(PRESETS)("%s survives the trip through the form as a draft", (name) => {
    expect(windowFromDraft(presetDraft(name))).toEqual(presetWindow(name));
  });

  it("offers three genuinely different shapes, not three constants", () => {
    const kinds = PRESETS.map((name) => presetWindow(name).boundaries.stop.kind);
    expect(new Set(kinds).size).toBeGreaterThan(1);
  });
});

describe("adding and removing windows", () => {
  it("adds a window under a trimmed name, seeded with a coherent preset", () => {
    const draft = windowsToDraft({});
    const result = withWindowAdded(draft, "  weekly  ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.names).toEqual(["weekly"]);
    expect(findCrossings(windowFromDraft(result.draft.windows.weekly!)!)).toEqual([]);
  });

  it("refuses a blank name", () => {
    const result = withWindowAdded(windowsToDraft({}), "   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("name");
  });

  it("refuses to overwrite an existing window, naming it", () => {
    // A silent overwrite here would destroy a window by typing a name —
    // the one mistake this form must not allow.
    const draft = windowsToDraft({ weekly: aWindow() });
    const result = withWindowAdded(draft, "weekly");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("weekly");
  });

  it("removes a window from both the order and the map", () => {
    const draft = windowsToDraft({ weekly: aWindow(), nightly: aWindow() });
    const after = withWindowRemoved(draft, "weekly");
    expect(after.names).toEqual(["nightly"]);
    expect(after.windows.weekly).toBeUndefined();
  });

  it("ignores a removal of something that is not there", () => {
    const draft = windowsToDraft({ weekly: aWindow() });
    expect(withWindowRemoved(draft, "absent")).toBe(draft);
  });
});

describe("windowsFromDraft", () => {
  it("returns the whole map when every window is complete", () => {
    const draft = windowsToDraft({ weekly: aWindow() });
    expect(windowsFromDraft(draft)).toEqual({ weekly: aWindow() });
  });

  it("returns null when any single window is incomplete", () => {
    // Save is all-or-nothing because the setting is the whole map; a
    // partial write has no way to express a deletion.
    const draft = windowsToDraft({ weekly: aWindow() });
    const broken = {
      ...draft,
      windows: { weekly: { ...draft.windows.weekly!, lengthHours: "" } },
    };
    expect(windowsFromDraft(broken)).toBeNull();
  });
});

describe("drawing a collision", () => {
  /** A window whose wind-down sits above stop — a real, named crossing. */
  function crossed(): BudgetWindow {
    return {
      enabled: true,
      lengthHours: 10,
      boundaries: {
        selective: { kind: "constant", value: 20 },
        windDown: { kind: "constant", value: 80 },
        stop: { kind: "constant", value: 40 },
      },
    };
  }

  it("names both colliding bands so the offending fields can be marked", () => {
    const problem = findCrossings(crossed())[0]!;
    expect(bandsInProblem(problem).sort()).toEqual(["stop", "windDown"]);
  });

  it("marks a mis-ordering at the midpoint of the two crossed values", () => {
    // The one height that reads as "these two swapped here" rather than as
    // a mark on one of them.
    const problem = findCrossings(crossed())[0]!;
    expect(problemPercent(problem)).toBe(60);
  });

  it("describes a mis-ordering in the form's labels, naming both values", () => {
    const problem = findCrossings(crossed())[0]!;
    const said = describeProblem(problem);
    expect(said).toContain("Wind down");
    expect(said).toContain("Stop");
    expect(said).toContain("80");
    expect(said).toContain("40");
    // The schema's key spelling must not leak into a sentence beside a
    // field labelled "Wind down".
    expect(said).not.toContain("windDown");
  });

  it("describes an out-of-range boundary with its value and the bound", () => {
    const problem = findCrossings({
      enabled: true,
      lengthHours: 10,
      boundaries: {
        selective: { kind: "constant", value: 20 },
        windDown: { kind: "constant", value: 40 },
        stop: { kind: "constant", value: 140 },
      },
    }).find((p) => p.message.includes("outside"))!;
    const said = describeProblem(problem);
    expect(said).toContain("Stop");
    expect(said).toContain("140");
    expect(said).toContain("0–100");
  });

  it("describes a missing value as missing rather than as zero", () => {
    const problem = findCrossings({
      enabled: true,
      lengthHours: 10,
      boundaries: {
        selective: { kind: "constant", value: 20 },
        windDown: { kind: "constant", value: 40 },
        // A schedule whose only entry starts late still has a value from the
        // top per `boundaryAt`; an entries-empty schedule is what has none.
        stop: { kind: "schedule", entries: [] as never },
      },
    }).find((p) => p.message.includes("no value"))!;
    expect(describeProblem(problem)).toContain("no value");
    expect(describeProblem(problem)).toContain("Stop");
  });

  it("falls back to the schema's own sentence when there is no structured detail", () => {
    // A CrossingProblem may be constructed by a caller that only has a
    // sentence — the editor must print it rather than nothing.
    const said = describeProblem({ atHours: 3, message: "something the schema said" });
    expect(said).toBe("something the schema said");
    expect(bandsInProblem({})).toEqual([]);
    expect(problemPercent({})).toBeNull();
  });

  it("says when the collision happens, not just that it does", () => {
    const problem = findCrossings(crossed())[0]!;
    // Every sample of this window collides, so the first is at the start.
    expect(describeProblem(problem)).toContain("start");
    expect(describeProblem({ ...problem, atHours: 3 })).toContain("3 hours in");
  });
});

// ── Saying a collision once ─────────────────────────────────────────────
//
// The defect these cover, measured on the rendered page: two crossed
// `constant` boundaries printed 101 near-identical list items across
// 1873px for a fact that does not vary over the window.
describe("groupProblemRuns", () => {
  /** Two constants the wrong way round — collides at every sampled moment. */
  function crossedThroughout(): BudgetWindow {
    return {
      enabled: true,
      lengthHours: 10,
      boundaries: {
        selective: { kind: "constant", value: 20 },
        windDown: { kind: "constant", value: 80 },
        stop: { kind: "constant", value: 40 },
      },
    };
  }

  it("has the 101 near-identical problems that motivated this, so the rest is not vacuous", () => {
    const problems = findCrossings(crossedThroughout());
    expect(problems.length).toBe(101);
    // Every one is the same fault said about a different moment.
    expect(new Set(problems.map((p) => describeProblem(p))).size).toBe(101);
  });

  it("collapses a fault that holds all window into ONE entry, not 101", () => {
    const runs = groupProblemRuns(findCrossings(crossedThroughout()));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.moments).toBe(101);
  });

  it("keeps every moment accounted for, so nothing is silently dropped", () => {
    const problems = findCrossings(crossedThroughout());
    const runs = groupProblemRuns(problems);
    expect(runs.reduce((total, run) => total + run.moments, 0)).toBe(problems.length);
  });

  it("spans the run from the window's start to its end", () => {
    const runs = groupProblemRuns(findCrossings(crossedThroughout()));
    expect(runs[0]!.fromHours).toBe(0);
    expect(runs[0]!.toHours).toBe(10);
  });

  it("says a window-long fault as one interval statement, not a moment", () => {
    const window = crossedThroughout();
    const runs = groupProblemRuns(findCrossings(window));
    const said = describeRun(runs[0]!, window.lengthHours);
    expect(said).toContain("for the whole window");
    // The fault itself is still named in the form's own labels.
    expect(said).toContain("Wind down");
    expect(said).toContain("Stop");
    // And it speaks of the span rather than of one sampled instant.
    expect(said).not.toContain("at the start of the window");
  });

  it("does not merge two DIFFERENT faults into one line", () => {
    const runs = groupProblemRuns([
      {
        atHours: 0,
        message: "a",
        detail: { kind: "mis-ordered", lower: "windDown", upper: "stop" },
      },
      {
        atHours: 1,
        message: "b",
        detail: { kind: "mis-ordered", lower: "selective", upper: "stop" },
      },
    ]);
    expect(runs).toHaveLength(2);
  });

  it("reports a fault that clears and returns as two runs, because it is two", () => {
    const same = { kind: "mis-ordered", lower: "windDown", upper: "stop" };
    const other = { kind: "out-of-range", band: "selective", value: 120 };
    const runs = groupProblemRuns([
      { atHours: 0, message: "a", detail: same },
      { atHours: 1, message: "a", detail: other },
      { atHours: 2, message: "a", detail: same },
    ]);
    expect(runs).toHaveLength(3);
    expect(runs[0]!.fromHours).toBe(0);
    expect(runs[2]!.fromHours).toBe(2);
  });

  it("leaves a single isolated fault worded exactly as it was before grouping", () => {
    const problem = {
      atHours: 3,
      message: "m",
      detail: {
        kind: "mis-ordered",
        lower: "windDown",
        lowerValue: 82,
        upper: "stop",
        upperValue: 75,
      },
    };
    const runs = groupProblemRuns([problem]);
    expect(runs).toHaveLength(1);
    expect(describeRun(runs[0]!, 10)).toBe(describeProblem(problem));
    expect(describeRun(runs[0]!, 10)).toContain("3 hours in");
  });

  it("names the interval when a run spans part of the window only", () => {
    const detail = {
      kind: "mis-ordered",
      lower: "windDown",
      lowerValue: 82,
      upper: "stop",
      upperValue: 75,
    };
    const runs = groupProblemRuns([
      { atHours: 2, message: "m", detail },
      { atHours: 4, message: "m", detail },
    ]);
    const said = describeRun(runs[0]!, 10);
    expect(said).toContain("from 2h to 4h");
    expect(said).not.toContain("for the whole window");
  });

  it("quotes the earliest problem's numbers, so the run speaks from where it began", () => {
    const runs = groupProblemRuns([
      {
        atHours: 2,
        message: "first",
        detail: {
          kind: "mis-ordered",
          lower: "windDown",
          lowerValue: 82,
          upper: "stop",
          upperValue: 75,
        },
      },
      {
        atHours: 4,
        message: "later",
        detail: {
          kind: "mis-ordered",
          lower: "windDown",
          lowerValue: 90,
          upper: "stop",
          upperValue: 60,
        },
      },
    ]);
    expect(runs).toHaveLength(1);
    expect(describeRun(runs[0]!, 10)).toContain("82%");
  });

  it("groups nothing when there is nothing", () => {
    expect(groupProblemRuns([])).toEqual([]);
  });
});
