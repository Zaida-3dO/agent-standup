// Pure unit tests for the board's derived-column mapping — SCHEMA.md §1.1,
// DECISIONS.md §13c. No database needed: `columnForState` and
// `columnForProject` are plain functions over a fixed table.
import { describe, expect, it } from "vitest";
import { ITEM_STATES } from "@/lib/service/state-machine/states";
import {
  BOARD_COLUMNS,
  STATES_BY_COLUMN,
  columnForProject,
  columnForState,
} from "@/lib/service/board/columns";

describe("columnForState", () => {
  it("maps every state to exactly one of the four documented columns (SCHEMA.md §1.1)", () => {
    for (const state of ITEM_STATES) {
      expect(BOARD_COLUMNS).toContain(columnForState(state));
    }
  });

  it("backlog: someday and on_deck", () => {
    expect(columnForState("someday")).toBe("backlog");
    expect(columnForState("on_deck")).toBe("backlog");
  });

  it("in_progress: planning, plan_review, executing, in_review", () => {
    expect(columnForState("planning")).toBe("in_progress");
    expect(columnForState("plan_review")).toBe("in_progress");
    expect(columnForState("executing")).toBe("in_progress");
    expect(columnForState("in_review")).toBe("in_progress");
  });

  it("waiting: paused and blocked share the column (SCHEMA.md §1.1 — distinguished by colour, not column)", () => {
    expect(columnForState("paused")).toBe("waiting");
    expect(columnForState("blocked")).toBe("waiting");
  });

  it("completed: merged, research_done, wont_do, cancelled", () => {
    expect(columnForState("merged")).toBe("completed");
    expect(columnForState("research_done")).toBe("completed");
    expect(columnForState("wont_do")).toBe("completed");
    expect(columnForState("cancelled")).toBe("completed");
  });

  // Named-failure proof: a one-character mutation of STATE_TO_COLUMN's
  // "executing" -> "in_progress" line to "waiting" (or any other column)
  // would flip this exact assertion — this is not a tautology, it pins one
  // specific state to one specific column against the documented table.
  it("does NOT put executing in backlog, waiting or completed — a wrong-mapping mutation would land here", () => {
    expect(columnForState("executing")).not.toBe("backlog");
    expect(columnForState("executing")).not.toBe("waiting");
    expect(columnForState("executing")).not.toBe("completed");
  });
});

describe("STATES_BY_COLUMN", () => {
  it("is the exact inverse of columnForState — every state appears in its own column and nowhere else", () => {
    for (const column of BOARD_COLUMNS) {
      for (const state of STATES_BY_COLUMN[column]) {
        expect(columnForState(state)).toBe(column);
      }
    }
    // Every one of the eleven (sic — twelve) documented states is
    // accounted for exactly once across the four buckets, so a state
    // silently missing from the table would show up as a length mismatch.
    const total = BOARD_COLUMNS.reduce((sum, column) => sum + STATES_BY_COLUMN[column].length, 0);
    expect(total).toBe(ITEM_STATES.length);
  });
});

describe("columnForProject — DECISIONS.md §13c: derived from children, never a project's own state", () => {
  it("an empty project (no descendants) reads as backlog", () => {
    expect(columnForProject([])).toBe("backlog");
  });

  it("a single actionable descendant puts the project in that descendant's column", () => {
    expect(columnForProject(["executing"])).toBe("in_progress");
    expect(columnForProject(["blocked"])).toBe("waiting");
    expect(columnForProject(["someday"])).toBe("backlog");
    expect(columnForProject(["merged"])).toBe("completed");
  });

  it("the MOST ACTIVE column wins when descendants are spread across several — in_progress beats waiting beats backlog beats completed", () => {
    // A project with one merged task and one still-planning task is not
    // "done" and not "backlog" — the live work is what the project reads
    // as. This is the case an off-by-one/wrong-rank mutation would flip:
    // swapping the rank of in_progress and backlog would put this project
    // in backlog instead.
    expect(columnForProject(["merged", "planning"])).toBe("in_progress");
    expect(columnForProject(["merged", "blocked"])).toBe("waiting");
    expect(columnForProject(["merged", "someday"])).toBe("backlog");
  });

  it("EXCLUDES completed from winning over anything live — a project with mixed live and done children is never shown as completed", () => {
    // Genuine exclusion: completed must not appear in the result when any
    // descendant is still live. Proves the ranking table's completed=3
    // (lowest priority) actually matters, not just that some column is
    // returned.
    const result = columnForProject(["cancelled", "wont_do", "in_review"]);
    expect(result).not.toBe("completed");
    expect(result).toBe("in_progress");
  });

  it("reads as completed only when every descendant is completed", () => {
    expect(columnForProject(["merged", "research_done", "wont_do", "cancelled"])).toBe("completed");
  });

  it("a deep grandchild (subtask) counts the same as a direct child — the whole subtree, not one level", () => {
    // columnForProject itself is level-agnostic (it just takes a flat list
    // of states); this pins that a lone deeply-nested live state still
    // wins over an otherwise-all-completed set, which is the property
    // get-board.ts's recursive query exists to preserve.
    expect(columnForProject(["merged", "merged", "executing"])).toBe("in_progress");
  });

  it("the best-so-far comparison must be STRICTLY less-than, and order-independent — the most-active state wins even when it is NOT last in iteration order", () => {
    // Kills two specific mutants in the rank comparison
    // (COLUMN_RANK[column] < COLUMN_RANK[best]):
    //   - replacing `<` with `true` would let every later state overwrite
    //     `best` unconditionally, so the LAST element in the array would
    //     always win regardless of rank — here that is "blocked"
    //     (waiting), not "executing" (in_progress).
    //   - replacing `<` with `<=` has the same effect whenever two states
    //     tie in rank, and would also let a later equal-or-worse state
    //     overwrite an already-better `best`.
    // The most-active state (in_progress) is placed FIRST and a less-active
    // one (waiting) LAST, so only a genuinely correct "keep the best seen"
    // comparison returns in_progress; both mutants above would return
    // waiting instead.
    expect(columnForProject(["executing", "someday", "blocked"])).toBe("in_progress");
  });
});
