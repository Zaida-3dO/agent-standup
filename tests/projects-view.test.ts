// M10 T11 — the projects grid's pure logic. MILESTONES.md #74.
//
// **What would make this file hollow.** Asserting that a project with 2 of
// 4 children merged reads "50%" proves the arithmetic and nothing else. The
// assertions that carry weight here are the ones about the cases an obvious
// implementation gets wrong:
//
//   - a childless project must read as *empty*, never as 0% — the single
//     most likely defect, because `merged / total || 0` and `total === 0 ?
//     0 : …` both produce a plausible, wrong, renderable number,
//   - a `superseded` holder must not count as live crew, because that row
//     is the expected leftover of a takeover and counting it reports every
//     handover as two agents,
//   - the distribution must omit empty states rather than emit twelve
//     bands, and must keep lifecycle order rather than sort by size.
//
// Each test names the single-character change that would break it.
import { describe, expect, it } from "vitest";
import {
  distributionOf,
  liveCrewCount,
  progressOf,
  relativeTime,
  sortProjects,
} from "@/lib/projects/view";
import type { BoardAssignment, ProjectRollup, StateCounts } from "@/lib/projects/types";
import { ITEM_STATES } from "@/lib/design/tokens";

/** Every state at zero — the base a fixture overrides the few it cares about. */
function noCounts(): StateCounts {
  return Object.fromEntries(ITEM_STATES.map((state) => [state, 0])) as StateCounts;
}

function makeProject(overrides: Partial<ProjectRollup> = {}): ProjectRollup {
  const counts = { ...noCounts(), ...(overrides.counts ?? {}) };
  const total = overrides.total ?? Object.values(counts).reduce((sum, n) => sum + n, 0);
  const merged = overrides.merged ?? counts.merged;
  // The three derived values are applied AFTER the spread, so a fixture
  // that sets only `counts` gets a `total` and `merged` consistent with it
  // rather than the defaults — while a fixture that sets them explicitly
  // still wins, because they were read out of `overrides` above.
  return {
    id: "p-1",
    title: "A project",
    headline: null,
    area: "web",
    repo: null,
    priority: "P2",
    finished: overrides.finished ?? merged,
    progress: total === 0 ? null : merged / total,
    childless: total === 0,
    lastActivity: "2026-08-18T10:00:00.000Z",
    assignments: [],
    ...overrides,
    counts,
    total,
    merged,
  };
}

function makeAssignment(overrides: Partial<BoardAssignment> = {}): BoardAssignment {
  return {
    holderId: "crew-one",
    holderType: "agent",
    displayName: "crew-one",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("progressOf", () => {
  it("reads a childless project as EMPTY, not as zero percent", () => {
    // The honesty requirement, and the defect this whole function exists to
    // make impossible: `0` claims work exists and none is done.
    //
    // Breaks if: the `childless || total <= 0` branch is removed — the
    // function falls through to the ratio branch and returns
    // `{kind: "ratio", percent: 0}`.
    const reading = progressOf(makeProject({ total: 0, merged: 0, childless: true }));

    expect(reading.kind).toBe("empty");
    // Explicitly not a ratio of zero — the two are different claims.
    expect(reading).not.toHaveProperty("percent");
  });

  it("distinguishes an empty project from one where nothing is merged yet", () => {
    // Both would render "0%" under a naive implementation, and they are
    // completely different facts: one has no work, the other has five
    // pieces of it not yet done.
    //
    // Breaks if: `empty` is derived from `merged === 0` instead of from the
    // child count.
    const empty = progressOf(makeProject({ total: 0, merged: 0, childless: true }));
    const nothingDone = progressOf(
      makeProject({ counts: { ...noCounts(), executing: 5 }, merged: 0 }),
    );

    expect(empty.kind).toBe("empty");
    expect(nothingDone).toEqual({ kind: "ratio", value: 0, percent: 0 });
  });

  it("computes the ratio and rounds the percentage", () => {
    // Breaks if: the rounding is dropped — `percent` becomes 66.666… and
    // the card renders a fractional percentage.
    const reading = progressOf(makeProject({ counts: { ...noCounts(), merged: 2, executing: 1 } }));

    expect(reading).toEqual({ kind: "ratio", value: 2 / 3, percent: 67 });
  });

  it("clamps a bar that would otherwise overflow its track", () => {
    // A server reporting more merged children than total is a bug, but the
    // card should not paint a 400%-wide bar over the page while it lasts.
    //
    // Breaks if: the `Math.min(1, …)` is removed — `percent` becomes 400.
    const reading = progressOf(makeProject({ total: 1, merged: 4, progress: 4 }));

    expect(reading).toEqual({ kind: "ratio", value: 1, percent: 100 });
  });

  it("reports a non-finite total as none rather than as empty", () => {
    // A malformed response must not masquerade as a data condition the
    // product has an opinion about.
    //
    // Breaks if: the `Number.isFinite` guard is removed — the function
    // returns a `ratio` whose percent is `NaN`.
    expect(progressOf(makeProject({ total: Number.NaN, merged: 1, childless: false })).kind).toBe(
      "none",
    );
  });
});

describe("distributionOf", () => {
  it("omits states with no children rather than emitting twelve bands", () => {
    // Breaks if: the `count <= 0` skip is removed — twelve segments come
    // back and the length check fails.
    const segments = distributionOf({ ...noCounts(), merged: 3, executing: 1 }, 4);

    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.state)).toEqual(["executing", "merged"]);
  });

  it("keeps lifecycle order, not descending by count", () => {
    // So the strip reads left-to-right as a lifecycle and a project does
    // not reshuffle its bands as work moves between two states of similar
    // size.
    //
    // Breaks if: a `.sort((a, b) => b.count - a.count)` is added — `merged`
    // (the larger) would come first and this fails.
    const segments = distributionOf({ ...noCounts(), merged: 9, on_deck: 1 }, 10);

    expect(segments.map((s) => s.state)).toEqual(["on_deck", "merged"]);
  });

  it("computes each band's share of the whole", () => {
    // Breaks if: `share` is divided by anything but `total` — e.g. by the
    // number of segments, which is 2 here and would give 0.5/0.5.
    const segments = distributionOf({ ...noCounts(), merged: 3, blocked: 1 }, 4);

    expect(segments.find((s) => s.state === "merged")!.share).toBeCloseTo(0.75);
    expect(segments.find((s) => s.state === "blocked")!.share).toBeCloseTo(0.25);
  });

  it("returns nothing at all for a project with no children", () => {
    // Breaks if: the `total <= 0` guard is removed — the division produces
    // `Infinity` shares.
    expect(distributionOf(noCounts(), 0)).toEqual([]);
  });
});

describe("liveCrewCount", () => {
  it("counts running and stalled holders", () => {
    // Breaks if: `stalled` is dropped from the predicate — the count
    // becomes 1.
    const project = makeProject({
      assignments: [
        makeAssignment({ liveness: "running" }),
        makeAssignment({ holderId: "crew-two", liveness: "stalled" }),
      ],
    });

    expect(liveCrewCount(project)).toBe(2);
  });

  it("does NOT count a superseded holder", () => {
    // A `superseded` row is the expected leftover of a takeover, not a
    // second agent — counting it reports every handover as two crew on one
    // project.
    //
    // Breaks if: the predicate becomes `!== "dead"` — superseded slips
    // through and the count becomes 2.
    const project = makeProject({
      assignments: [
        makeAssignment({ liveness: "running" }),
        makeAssignment({ holderId: "crew-old", liveness: "superseded" }),
      ],
    });

    expect(liveCrewCount(project)).toBe(1);
  });

  it("does not count a dead holder", () => {
    // Breaks if: the predicate stops filtering — the count becomes 1.
    const project = makeProject({ assignments: [makeAssignment({ liveness: "dead" })] });

    expect(liveCrewCount(project)).toBe(0);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("labels each band", () => {
    // Breaks if: any divisor changes — e.g. hours computed from 100
    // minutes, which moves the 3h case.
    expect(relativeTime("2026-08-18T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-08-18T11:30:00.000Z", now)).toBe("30m ago");
    expect(relativeTime("2026-08-18T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-08-16T12:00:00.000Z", now)).toBe("2d ago");
    expect(relativeTime("2026-06-18T12:00:00.000Z", now)).toBe("2mo ago");
    expect(relativeTime("2024-08-18T12:00:00.000Z", now)).toBe("2y ago");
  });

  it("returns a label rather than Invalid Date for an unparseable value", () => {
    // A naive implementation renders the string "Invalid Date" onto the
    // card.
    //
    // Breaks if: the `Number.isNaN` guard is removed.
    expect(relativeTime("not a date", now)).toBe("unknown");
  });

  it("does not render a future timestamp as a negative age", () => {
    // Clock skew between the server and the browser is routine.
    //
    // Breaks if: the `Math.max(0, …)` clamp is removed — this returns
    // "-60m ago".
    expect(relativeTime("2026-08-18T13:00:00.000Z", now)).toBe("just now");
  });
});

describe("sortProjects", () => {
  it("puts childless projects last, but keeps them", () => {
    // Last rather than hidden: they are what a reader can do least with,
    // and removing them is how a page stops matching reality.
    //
    // Breaks if: the `childless` comparison is removed — the childless
    // project sorts first by recency and this fails.
    const childless = makeProject({
      id: "empty",
      total: 0,
      childless: true,
      lastActivity: "2026-08-18T11:00:00.000Z",
    });
    const real = makeProject({
      id: "real",
      counts: { ...noCounts(), executing: 1 },
      lastActivity: "2026-08-01T10:00:00.000Z",
    });

    expect(sortProjects([childless, real]).map((p) => p.id)).toEqual(["real", "empty"]);
  });

  it("puts projects with live crew above idle ones", () => {
    // Breaks if: the crew comparison is removed — the more recent project
    // wins on recency and this fails.
    const held = makeProject({
      id: "held",
      counts: { ...noCounts(), executing: 1 },
      lastActivity: "2026-08-01T10:00:00.000Z",
      assignments: [makeAssignment()],
    });
    const idle = makeProject({
      id: "idle",
      counts: { ...noCounts(), executing: 1 },
      lastActivity: "2026-08-18T10:00:00.000Z",
    });

    expect(sortProjects([idle, held]).map((p) => p.id)).toEqual(["held", "idle"]);
  });

  it("does not mutate the array it was given", () => {
    // A sort in place would reorder a React prop, which may be rendered
    // again.
    //
    // Breaks if: the spread is dropped and `projects.sort(...)` is called
    // directly.
    const a = makeProject({ id: "a", total: 0, childless: true });
    const b = makeProject({ id: "b", counts: { ...noCounts(), executing: 1 } });
    const input = [a, b];

    sortProjects(input);

    expect(input.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
