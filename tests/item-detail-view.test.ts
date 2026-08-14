// The item-detail view's pure derivations — MILESTONES.md #72.
//
// These run with no DOM and no database: every function under test is a
// plain function over plain data, which is the whole reason the display
// decisions live in `@/lib/item-detail/view` rather than inside the
// components. Same split as `tests/board-view.test.ts`.
import { describe, expect, it } from "vitest";
import {
  artifactsByRound,
  hasSummary,
  humanEventType,
  humanState,
  latestVerdict,
  orderedHistory,
  showsOwnState,
  subtaskProgress,
  summaryEntries,
  waitingReason,
} from "@/lib/item-detail/view";
import type { DetailArtifact, DetailHistoryEntry, DetailSubtask } from "@/lib/item-detail/types";

function subtask(overrides: Partial<DetailSubtask> = {}): DetailSubtask {
  return {
    id: "sub-1",
    parentId: "root",
    title: "A subtask",
    kind: "task",
    state: "executing",
    priority: "P2",
    depth: 1,
    column: "in_progress",
    ...overrides,
  };
}

function artifact(overrides: Partial<DetailArtifact> = {}): DetailArtifact {
  return {
    id: "art-1",
    kind: "code_review",
    verdict: "lgtm",
    reviewRound: 1,
    commitSha: null,
    ref: null,
    body: null,
    findings: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function historyEntry(overrides: Partial<DetailHistoryEntry> = {}): DetailHistoryEntry {
  return {
    id: "1",
    ts: "2026-01-01T00:00:00.000Z",
    type: "state_change",
    actorType: "agent",
    actorId: null,
    sessionId: null,
    body: null,
    payload: null,
    ...overrides,
  };
}

describe("humanState", () => {
  it("renders the stored snake_case vocabulary as words", () => {
    expect(humanState("plan_review")).toBe("plan review");
    expect(humanState("research_done")).toBe("research done");
  });

  it("leaves a single-word state alone", () => {
    expect(humanState("executing")).toBe("executing");
  });
});

describe("showsOwnState", () => {
  // The load-bearing case: DECISIONS.md §13c — a project's stored state is
  // a creation leftover, so the detail view must not present it as fact.
  it("refuses to show a project's own state", () => {
    expect(showsOwnState("project")).toBe(false);
  });

  it("shows a task's and a subtask's own state", () => {
    expect(showsOwnState("task")).toBe(true);
    expect(showsOwnState("subtask")).toBe(true);
  });
});

describe("waitingReason", () => {
  it("reads pauseReason when paused and blockedReason when blocked", () => {
    expect(
      waitingReason({ state: "paused", pauseReason: "waiting on a deploy", blockedReason: null }),
    ).toBe("waiting on a deploy");
    expect(
      waitingReason({ state: "blocked", pauseReason: null, blockedReason: "needs a decision" }),
    ).toBe("needs a decision");
  });

  it("never reads the other state's reason", () => {
    // A paused item carrying a stale blockedReason must not show it — the
    // two fields are independent (SCHEMA.md §1.1) and crossing them would
    // report a blocker on something that is merely parked.
    expect(
      waitingReason({ state: "paused", pauseReason: null, blockedReason: "stale blocker" }),
    ).toBeNull();
  });

  it("gives no reason for a state that is not in Waiting", () => {
    expect(waitingReason({ state: "executing", pauseReason: "x", blockedReason: "y" })).toBeNull();
  });
});

describe("subtaskProgress", () => {
  it("counts every terminal state as done", () => {
    const progress = subtaskProgress([
      subtask({ id: "a", state: "merged" }),
      subtask({ id: "b", state: "research_done" }),
      subtask({ id: "c", state: "wont_do" }),
      subtask({ id: "d", state: "cancelled" }),
      subtask({ id: "e", state: "executing" }),
    ]);
    expect(progress).toEqual({ done: 4, total: 5 });
  });

  it("excludes projects from BOTH halves, so a fully-merged tree reads as done", () => {
    // The bug this guards: counting a structural project as an unfinished
    // denominator makes a completed piece of work read as 2/3 purely
    // because it is organised into a sub-project.
    const progress = subtaskProgress([
      subtask({ id: "a", state: "merged" }),
      subtask({ id: "b", state: "merged" }),
      subtask({ id: "p", kind: "project", state: "on_deck", column: null }),
    ]);
    expect(progress).toEqual({ done: 2, total: 2 });
  });

  it("reports zero of zero for an empty tree", () => {
    expect(subtaskProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe("artifactsByRound", () => {
  it("groups by review round with rounds ascending", () => {
    const rounds = artifactsByRound([
      artifact({ id: "r2", reviewRound: 2 }),
      artifact({ id: "r1", reviewRound: 1 }),
      artifact({ id: "r1b", reviewRound: 1 }),
    ]);
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(rounds[0]!.artifacts.map((a) => a.id)).toEqual(["r1", "r1b"]);
    expect(rounds[1]!.artifacts.map((a) => a.id)).toEqual(["r2"]);
  });

  it("returns nothing for no artifacts", () => {
    expect(artifactsByRound([])).toEqual([]);
  });
});

describe("latestVerdict", () => {
  it("reports the LATEST round's verdict, not the first or the most favourable", () => {
    // The bug this guards: surfacing a round-1 `lgtm` on work that round 2
    // sent back would report a stale pass.
    expect(
      latestVerdict([
        artifact({ id: "a", reviewRound: 1, verdict: "lgtm" }),
        artifact({ id: "b", reviewRound: 2, verdict: "changes_requested" }),
      ]),
    ).toBe("changes_requested");
  });

  it("still reports a later pass after an earlier rejection", () => {
    expect(
      latestVerdict([
        artifact({ id: "a", reviewRound: 1, verdict: "changes_requested" }),
        artifact({ id: "b", reviewRound: 2, verdict: "lgtm" }),
      ]),
    ).toBe("lgtm");
  });

  it("ignores artifacts with no verdict — a plan or a screenshot is not a review", () => {
    expect(
      latestVerdict([
        artifact({ id: "a", reviewRound: 1, verdict: "lgtm" }),
        artifact({ id: "b", kind: "screenshot", reviewRound: 2, verdict: null }),
      ]),
    ).toBe("lgtm");
  });

  it("is null when nothing has a verdict", () => {
    expect(latestVerdict([artifact({ verdict: null })])).toBeNull();
    expect(latestVerdict([])).toBeNull();
  });
});

describe("humanEventType", () => {
  it("renders an event type as words", () => {
    expect(humanEventType("state_change")).toBe("state change");
  });
});

describe("orderedHistory", () => {
  it("orders newest first by event id, numerically not lexically", () => {
    // Lexical ordering would put "9" after "10" — the bug a string sort
    // introduces the moment the ledger passes ten entries.
    const ordered = orderedHistory([
      historyEntry({ id: "9" }),
      historyEntry({ id: "10" }),
      historyEntry({ id: "2" }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["10", "9", "2"]);
  });

  it("does not mutate its input", () => {
    const input = [historyEntry({ id: "1" }), historyEntry({ id: "2" })];
    orderedHistory(input);
    expect(input.map((e) => e.id)).toEqual(["1", "2"]);
  });
});

describe("hasSummary", () => {
  it("is false for null and true for a summary", () => {
    expect(hasSummary(null)).toBe(false);
    expect(
      hasSummary({
        shipped: [],
        notDone: [],
        userFacing: true,
        whatToTest: null,
        howVerified: null,
        watchFor: [],
        finalState: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("summaryEntries", () => {
  it("passes strings through", () => {
    expect(summaryEntries(["a", "b"])).toEqual(["a", "b"]);
  });

  it("reads the `text` field of a not_done-shaped entry", () => {
    expect(summaryEntries([{ text: "the thing", reason: "ran out of time" }])).toEqual([
      "the thing",
    ]);
  });

  it("degrades rather than throwing on a shape it has never seen", () => {
    // A `Json` column is validated in code, not by the column (SCHEMA.md
    // §5a), so a malformed stored summary is reachable — and it must not
    // take out the screen that would let anyone see it.
    expect(summaryEntries("not an array")).toEqual([]);
    expect(summaryEntries(null)).toEqual([]);
    expect(summaryEntries(undefined)).toEqual([]);
    expect(summaryEntries([42])).toEqual(["42"]);
  });
});
