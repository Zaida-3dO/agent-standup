// M10 T12 — the project page's pure logic. MILESTONES.md #75.
//
// **What would make this file hollow.** Asserting that `explainDerivedState`
// returns a non-empty string proves nothing — every implementation does.
// The assertions that carry weight are the ones about the claims the page
// must not make:
//
//   - a derived reading must arrive WITH its distribution and its causing
//     child; a sentence that names only the column is the exact loss this
//     task exists to undo,
//   - a childless project must read as *empty*, never as 0%,
//   - and the repair offer must state the closeable-vs-transitionable limit
//     whenever the verification window is shut — a UI that offers a repair
//     without it promises something the state machine then refuses.
//
// Each test names the single-character change that would break it.
import { describe, expect, it } from "vitest";
import {
  COLUMN_LABELS,
  blockedReasonText,
  distributionOf,
  explainDerivedState,
  humanState,
  liveCrewOn,
  progressOf,
  relativeTime,
  repairOfferFor,
  sortChildren,
} from "@/lib/project-detail/view";
import type {
  BlockedDescendant,
  BoardAssignment,
  ProjectChild,
  ProjectDetail,
  StateCounts,
} from "@/lib/project-detail/types";
import { ITEM_STATES } from "@/lib/design/tokens";

/** Every state at zero — the base a fixture overrides the few it cares about. */
function noCounts(): StateCounts {
  return Object.fromEntries(ITEM_STATES.map((state) => [state, 0])) as StateCounts;
}

function counts(overrides: Partial<StateCounts>): StateCounts {
  return { ...noCounts(), ...overrides };
}

function makeChild(overrides: Partial<ProjectChild> = {}): ProjectChild {
  return {
    id: "c-1",
    title: "A child",
    headline: null,
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: null,
    column: "in_progress",
    blockedReason: null,
    total: 0,
    merged: 0,
    childless: false,
    updatedAt: "2026-08-18T10:00:00.000Z",
    assignments: [],
    ...overrides,
  };
}

function makeDetail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  const resolved = { ...noCounts(), ...(overrides.derived?.counts ?? {}) };
  const total = overrides.total ?? Object.values(resolved).reduce((sum, n) => sum + n, 0);
  const merged = overrides.merged ?? resolved.merged;
  return {
    project: {
      id: "p-1",
      title: "A project",
      headline: null,
      area: "web",
      repo: null,
      priority: "P2",
      kind: "project",
    },
    derived: { column: "in_progress", counts: resolved, causingChild: null },
    total,
    merged,
    finished: merged,
    progress: total === 0 ? null : merged / total,
    childless: total === 0,
    lastActivity: "2026-08-18T10:00:00.000Z",
    children: [],
    blockedChildren: [],
    assignments: [],
    activity: [],
    repair: { childless: total === 0, historicalVerificationAvailable: false },
    // `total` and `merged` are resolved from `overrides` at the top of this
    // function, so a fixture setting only `derived.counts` gets values
    // consistent with it and one setting them explicitly still wins. They
    // are therefore NOT restated after the spread — repeating a key that
    // the spread cannot override is a duplicate the compiler rejects.
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<BoardAssignment> = {}): BoardAssignment {
  return {
    holderId: "agent-1",
    holderType: "agent",
    displayName: "Agent One",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("explainDerivedState — the derived reading, made legible", () => {
  it("names the column, the distribution AND the causing child in one sentence", () => {
    const sentence = explainDerivedState(
      {
        column: "waiting",
        counts: counts({ blocked: 1, merged: 5, executing: 3 }),
        causingChild: {
          id: "c-9",
          title: "Wire the webhook",
          state: "blocked",
          blockedReason: "waiting on a key",
        },
      },
      9,
    );
    // The column.
    expect(sentence).toContain("Waiting");
    // The distribution — all three states present, each with its count.
    expect(sentence).toContain("1 blocked");
    expect(sentence).toContain("5 merged");
    expect(sentence).toContain("3 executing");
    // The causing child, by name. This is the assertion that makes the
    // whole function worth having: deleting the causing-child clause from
    // `explainDerivedState` (one `return` moved up a line) fails here while
    // every "is a string" assertion would still pass.
    expect(sentence).toContain("Wire the webhook");
  });

  it("says there is nothing under an empty project rather than reporting a column over no work", () => {
    const sentence = explainDerivedState(
      { column: "backlog", counts: noCounts(), causingChild: null },
      0,
    );
    expect(sentence).toContain("nothing under this project");
    // Changing `total <= 0` to `total < 0` in `explainDerivedState` makes
    // this fall through to the distribution branch and render
    // "Backlog — 0 children: ." — a reading of work that does not exist.
    expect(sentence).not.toContain("0 children:");
  });

  it("omits the cause clause when there is no causing child, rather than naming nothing", () => {
    const sentence = explainDerivedState(
      { column: "backlog", counts: counts({ on_deck: 2 }), causingChild: null },
      2,
    );
    expect(sentence).toContain("2 on deck");
    // `because` appears only when a child is actually named. Removing the
    // `cause === null` early return would render `because "undefined" is`.
    expect(sentence).not.toContain("because");
  });

  it("labels every column, so no reading renders as a raw enum value", () => {
    for (const [column, label] of Object.entries(COLUMN_LABELS)) {
      const sentence = explainDerivedState(
        {
          column: column as keyof typeof COLUMN_LABELS,
          counts: counts({ merged: 1 }),
          causingChild: null,
        },
        1,
      );
      expect(sentence.startsWith(label)).toBe(true);
      // Deleting any entry from COLUMN_LABELS renders `undefined —`.
      expect(sentence).not.toContain("undefined");
    }
  });
});

describe("distributionOf", () => {
  it("omits states with no children rather than emitting twelve bands", () => {
    const segments = distributionOf(counts({ executing: 2, merged: 1 }), 3);
    expect(segments.map((s) => s.state)).toEqual(["executing", "merged"]);
    // Changing `count <= 0` to `count < 0` emits all twelve.
    expect(segments).toHaveLength(2);
  });

  it("keeps lifecycle order rather than sorting by size", () => {
    // `merged` is much larger but comes later in the vocabulary.
    const segments = distributionOf(counts({ executing: 1, merged: 9 }), 10);
    // Sorting by count descending — a plausible alternative implementation —
    // would put `merged` first and fail this.
    expect(segments.map((s) => s.state)).toEqual(["executing", "merged"]);
  });

  it("returns nothing for an empty project rather than dividing by zero", () => {
    // `total <= 0` → `total < 0` would produce `NaN` shares here.
    expect(distributionOf(noCounts(), 0)).toEqual([]);
  });

  it("computes shares over the total, so bands sum to the whole", () => {
    const segments = distributionOf(counts({ executing: 1, merged: 3 }), 4);
    expect(segments.map((s) => s.share)).toEqual([0.25, 0.75]);
  });
});

describe("progressOf — three cases, and the third is the point", () => {
  it("reads a childless project as empty, never as zero percent", () => {
    const reading = progressOf(makeDetail({ childless: true, total: 0, merged: 0 }));
    expect(reading.kind).toBe("empty");
  });

  it("trusts EITHER signal of emptiness on its own, so the two cannot disagree into a 0% bar", () => {
    // The two halves of `childless || total <= 0` are asserted separately
    // and deliberately: a fixture setting both makes `||` and `&&`
    // indistinguishable, which is precisely the shape of a hollow test.
    // Each case below fails under `&&`.
    //
    // The server flagged it, but the arithmetic disagrees — trust the flag,
    // because the server owns that judgement.
    expect(progressOf(makeDetail({ childless: true, total: 4, merged: 0 })).kind).toBe("empty");
    // The flag is missing (an older server), but there is demonstrably
    // nothing to be a fraction of — still empty, never 0%.
    expect(progressOf(makeDetail({ childless: false, total: 0, merged: 0 })).kind).toBe("empty");
  });

  it("reads a real ratio as a percent", () => {
    const reading = progressOf(
      makeDetail({
        derived: {
          column: "in_progress",
          counts: counts({ merged: 1, executing: 3 }),
          causingChild: null,
        },
      }),
    );
    expect(reading).toEqual({ kind: "ratio", value: 0.25, percent: 25 });
  });

  it("clamps a server that reports more merged than total, rather than painting past the track", () => {
    const reading = progressOf(
      makeDetail({ total: 2, merged: 5, progress: 2.5, childless: false }),
    );
    expect(reading).toEqual({ kind: "ratio", value: 1, percent: 100 });
  });

  it("keeps a malformed total distinct from an empty project", () => {
    const reading = progressOf(
      makeDetail({ total: Number.NaN, merged: 1, childless: false, progress: null }),
    );
    // `none`, not `empty`: a rendering bug must never masquerade as a data
    // condition the product has an opinion about.
    expect(reading.kind).toBe("none");
  });
});

describe("liveCrewOn", () => {
  it("counts running and stalled and excludes dead and superseded", () => {
    const detail = makeDetail({
      assignments: [
        makeAssignment({ holderId: "a", liveness: "running" }),
        makeAssignment({ holderId: "b", liveness: "stalled" }),
        makeAssignment({ holderId: "c", liveness: "dead" }),
        // The expected leftover of a takeover. Counting it reports every
        // handover as two agents — removing `superseded` from the exclusion
        // (one `&&` clause) makes this read 3.
        makeAssignment({ holderId: "d", liveness: "superseded" }),
      ],
    });
    expect(liveCrewOn(detail)).toBe(2);
  });

  it("counts one agent holding both a project and its child once", () => {
    const detail = makeDetail({
      assignments: [makeAssignment({ holderId: "same-agent" })],
      children: [makeChild({ assignments: [makeAssignment({ holderId: "same-agent" })] })],
    });
    // Counting assignment rows rather than distinct holders reports 2 here.
    expect(liveCrewOn(detail)).toBe(1);
  });

  it("counts crew on children, not only on the project itself", () => {
    const detail = makeDetail({
      children: [makeChild({ assignments: [makeAssignment({ holderId: "child-holder" })] })],
    });
    // Deleting the `for (const child …)` loop makes this 0 — and a project
    // page would report "no live crew" while an agent was working under it.
    expect(liveCrewOn(detail)).toBe(1);
  });
});

describe("sortChildren", () => {
  it("puts blocked work first and childless nested projects last", () => {
    const ordered = sortChildren([
      makeChild({ id: "done", column: "completed" }),
      makeChild({ id: "broken", kind: "project", column: "backlog", childless: true }),
      makeChild({ id: "stuck", column: "waiting" }),
      makeChild({ id: "live", column: "in_progress" }),
    ]);
    // Flipping the `a.childless ? 1 : -1` sign puts the broken row first.
    expect(ordered.map((c) => c.id)).toEqual(["stuck", "live", "done", "broken"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [
      makeChild({ id: "b", column: "completed" }),
      makeChild({ id: "a", column: "waiting" }),
    ];
    sortChildren(input);
    // Dropping the spread in `[...children].sort(…)` reorders the caller's
    // array, which for a React prop is a value that may be rendered again.
    expect(input.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("breaks a tie by recency, newest first", () => {
    const ordered = sortChildren([
      makeChild({ id: "old", column: "in_progress", updatedAt: "2026-08-01T00:00:00.000Z" }),
      makeChild({ id: "new", column: "in_progress", updatedAt: "2026-08-18T00:00:00.000Z" }),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(["new", "old"]);
  });
});

describe("blockedReasonText", () => {
  it("distinguishes 'blocked with a reason' from 'blocked and nobody said why'", () => {
    const withReason: BlockedDescendant = {
      id: "b-1",
      title: "t",
      state: "blocked",
      blockedReason: "waiting on a key",
      blockedOnType: "person",
      area: "web",
      updatedAt: "2026-08-18T10:00:00.000Z",
    };
    expect(blockedReasonText(withReason)).toBe("waiting on a key");
    // Whitespace is not a reason. Dropping the `.trim()` renders a blank
    // line that looks like a reason nobody can read.
    expect(blockedReasonText({ ...withReason, blockedReason: "   " })).toBe("No reason recorded.");
    expect(blockedReasonText({ ...withReason, blockedReason: null })).toBe("No reason recorded.");
  });
});

describe("humanState", () => {
  it("falls back to the raw value for a state this build has never seen", () => {
    expect(humanState("executing")).toBe("executing");
    // A state added to the server's vocabulary before this client knows it
    // must render as itself, not as "undefined".
    expect(humanState("teleported")).toBe("teleported");
  });
});

describe("relativeTime", () => {
  it("returns a fixed string for an unparseable date rather than 'Invalid Date'", () => {
    expect(relativeTime("not-a-date", Date.parse("2026-08-18T10:00:00.000Z"))).toBe("unknown");
  });

  it("does not render a negative age for a clock skewed into the future", () => {
    const now = Date.parse("2026-08-18T10:00:00.000Z");
    // Dropping the `Math.max(0, …)` renders "-5m ago".
    expect(relativeTime("2026-08-18T10:05:00.000Z", now)).toBe("just now");
  });
});

// ── The honesty requirement ──────────────────────────────────────────────
//
// These are the assertions the task is actually about: the UI must not
// offer a repair that leads to a refusal it did not warn about.

describe("repairOfferFor — never promise what the state machine will refuse", () => {
  it("offers nothing for a project that has children", () => {
    const offer = repairOfferFor({ childless: false, historicalVerificationAvailable: false });
    expect(offer.applicable).toBe(false);
    expect(offer.deadEndsForFinishedWork).toBe(false);
  });

  it("warns that repair does NOT make an item closeable when the verification window is shut", () => {
    const offer = repairOfferFor({ childless: true, historicalVerificationAvailable: false });
    expect(offer.applicable).toBe(true);
    // The limit must exist and must say the actual thing. Inverting the
    // `if (repair.historicalVerificationAvailable)` branch returns the
    // milder sentence, which does not contain "does NOT make it closeable"
    // — so this fails on exactly the mistake that matters.
    expect(offer.limit).not.toBeNull();
    expect(offer.limit).toContain("does NOT make it closeable");
    expect(offer.limit).toContain("not enabled on this deployment");
    // The flag a UI keys its warning tone off.
    expect(offer.deadEndsForFinishedWork).toBe(true);
  });

  it("still states the remaining evidence requirement when the window IS open", () => {
    const offer = repairOfferFor({ childless: true, historicalVerificationAvailable: true });
    expect(offer.applicable).toBe(true);
    // Not a dead end — but not "you're done" either. Returning `limit: null`
    // here (a plausible simplification) would let the page imply that a
    // repaired item can simply be closed, when it still needs a commit and
    // either a review or a verification.
    expect(offer.limit).not.toBeNull();
    expect(offer.limit).toContain("historical_verification");
    expect(offer.deadEndsForFinishedWork).toBe(false);
  });

  it("never claims a repair invents or changes the item's state", () => {
    const offer = repairOfferFor({ childless: true, historicalVerificationAvailable: true });
    // The operations keep whatever state is on the row. A UI implying
    // otherwise would have a user expect a retype to also resolve the item.
    expect(offer.achieves).toContain("Neither invents a state");
  });
});
