// src/lib/board/view.ts — the display derivations behind MILESTONES.md #37:
// the four columns, the amber/red split in Waiting, and the needs-you count.
//
// Pure functions over plain data, so these run directly with no DOM — see
// `tests/helpers/react-element.ts` for why this repo's component tests take
// the same shape.
import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMNS,
  columnTitle,
  emptyBoard,
  needsYou,
  needsYouCount,
  needsYouEntries,
  waitingSplit,
  waitingTone,
} from "@/lib/board/view";
import type { Board, BoardEntry, BoardColumnId, BoardItem } from "@/lib/board/types";
import { boardOf } from "./helpers/board-sections";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    title: "An item",
    // The BLUF (MILESTONES.md #107). Null in the default fixture so a case
    // that cares about it has to say so, rather than every card silently
    // carrying one.
    headline: null,
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: "web",
    blockedOnPersonId: null,
    blockedOnType: null,
    blockedReason: null,
    pauseReason: null,
    ...overrides,
  };
}

function entry(column: BoardColumnId, overrides: Partial<BoardItem> = {}): BoardEntry {
  return { item: item(overrides), column };
}

/**
 * A board whose named columns hold the given entries.
 *
 * Takes bare entry lists rather than whole sections because these tests are
 * about tone, badges and tallies — the count and cursor fields are #109/#123
 * concerns proved against real data in `tests/board-pagination.test.ts`, and
 * spelling them out at every fixture site here would bury the subject.
 */
function boardWith(overrides: Partial<Record<BoardColumnId, readonly BoardEntry[]>> = {}): Board {
  return boardOf(overrides);
}

describe("the four columns", () => {
  it("is exactly the four columns from SCHEMA.md §1.1, in board order", () => {
    expect([...BOARD_COLUMNS]).toEqual(["backlog", "in_progress", "waiting", "completed"]);
  });

  it("gives every column a distinct, human heading", () => {
    const titles = BOARD_COLUMNS.map(columnTitle);
    expect(titles).toEqual(["Backlog", "In progress", "Waiting", "Completed"]);
    expect(new Set(titles).size).toBe(BOARD_COLUMNS.length);
  });

  it("starts empty in every column, so nothing indexes undefined", () => {
    const board = emptyBoard();
    for (const column of BOARD_COLUMNS) {
      expect(board[column].entries).toEqual([]);
    }
  });
});

describe("waitingTone — amber for paused, red for blocked", () => {
  it("paints a paused card amber", () => {
    expect(waitingTone(entry("waiting", { state: "paused" }))).toBe("amber");
  });

  it("paints a blocked card red", () => {
    expect(waitingTone(entry("waiting", { state: "blocked" }))).toBe("red");
  });

  it("does not swap the two — the colours are not interchangeable", () => {
    expect(waitingTone(entry("waiting", { state: "paused" }))).not.toBe("red");
    expect(waitingTone(entry("waiting", { state: "blocked" }))).not.toBe("amber");
  });

  it("gives no tone to a card outside the Waiting column, even one whose state is paused", () => {
    // The state alone must not decide the colour: a card the server placed
    // elsewhere is not part of the amber/red split.
    expect(waitingTone(entry("in_progress", { state: "paused" }))).toBeNull();
    expect(waitingTone(entry("backlog", { state: "blocked" }))).toBeNull();
  });

  it("gives no tone to a PROJECT in Waiting — its stored state is a creation leftover, not a fact", () => {
    // A project derived into Waiting by a paused child must not take its
    // colour from its own stale row.
    expect(waitingTone(entry("waiting", { kind: "project", state: "paused" }))).toBeNull();
    expect(waitingTone(entry("waiting", { kind: "project", state: "on_deck" }))).toBeNull();
  });

  it("gives no tone to a state that is neither paused nor blocked", () => {
    expect(waitingTone(entry("waiting", { state: "executing" }))).toBeNull();
  });
});

describe("needsYou — the narrow rule that keeps the badge trustworthy", () => {
  const me = "user-a";

  it("counts an item blocked on me", () => {
    expect(
      needsYou(
        entry("waiting", { state: "blocked", blockedOnType: "person", blockedOnPersonId: me }),
        me,
      ),
    ).toBe(true);
  });

  it("does NOT count an item blocked on someone else", () => {
    expect(
      needsYou(
        entry("waiting", {
          state: "blocked",
          blockedOnType: "person",
          blockedOnPersonId: "user-b",
        }),
        me,
      ),
    ).toBe(false);
  });

  it("does NOT count a PAUSED item, even one naming me — paused means nobody is on it", () => {
    expect(
      needsYou(
        entry("waiting", { state: "paused", blockedOnType: "person", blockedOnPersonId: me }),
        me,
      ),
    ).toBe(false);
  });

  it("does NOT count an item blocked on an external process", () => {
    expect(
      needsYou(
        entry("waiting", {
          state: "blocked",
          blockedOnType: "external_process",
          blockedOnPersonId: me,
        }),
        me,
      ),
    ).toBe(false);
  });

  it("does NOT count an item blocked on a time", () => {
    expect(
      needsYou(
        entry("waiting", { state: "blocked", blockedOnType: "time", blockedOnPersonId: me }),
        me,
      ),
    ).toBe(false);
  });

  it("does NOT count a project, whose stored state is not a fact about it", () => {
    expect(
      needsYou(
        entry("waiting", {
          kind: "project",
          state: "blocked",
          blockedOnType: "person",
          blockedOnPersonId: me,
        }),
        me,
      ),
    ).toBe(false);
  });

  it("counts nothing when no profile is active — a stranger's queue is not yours", () => {
    expect(
      needsYou(
        entry("waiting", { state: "blocked", blockedOnType: "person", blockedOnPersonId: me }),
        null,
      ),
    ).toBe(false);
  });

  it("does not treat a null blockedOnPersonId as matching a null profile", () => {
    // Both null: the naive `a === b` check would return true here.
    expect(
      needsYou(
        entry("waiting", { state: "blocked", blockedOnType: "person", blockedOnPersonId: null }),
        null,
      ),
    ).toBe(false);
  });
});

describe("needsYouCount / needsYouEntries", () => {
  const me = "user-a";
  const mine = (id: string): Partial<BoardItem> => ({
    id,
    state: "blocked",
    blockedOnType: "person",
    blockedOnPersonId: me,
  });

  it("counts every matching card across the whole board, not just Waiting", () => {
    const board = boardWith({
      waiting: [entry("waiting", mine("a")), entry("waiting", mine("b"))],
      // Defensive: if an item is ever blocked from another column, the badge
      // must not silently under-count it.
      in_progress: [entry("in_progress", mine("c"))],
    });
    expect(needsYouCount(board, me)).toBe(3);
  });

  it("is zero on an empty board", () => {
    expect(needsYouCount(emptyBoard(), me)).toBe(0);
  });

  it("is zero when nothing is blocked on this person", () => {
    const board = boardWith({
      waiting: [
        entry("waiting", { state: "paused" }),
        entry("waiting", {
          state: "blocked",
          blockedOnType: "person",
          blockedOnPersonId: "user-b",
        }),
      ],
    });
    expect(needsYouCount(board, me)).toBe(0);
  });

  it("is zero with no active profile even when the board is full of blocked work", () => {
    const board = boardWith({
      waiting: [entry("waiting", mine("a")), entry("waiting", mine("b"))],
    });
    expect(needsYouCount(board, null)).toBe(0);
  });

  it("returns the matching entries themselves, in board-column order", () => {
    const board = boardWith({
      completed: [entry("completed", mine("z"))],
      waiting: [entry("waiting", mine("w"))],
      backlog: [entry("backlog", mine("b"))],
    });
    // BOARD_COLUMNS order: backlog, in_progress, waiting, completed.
    expect(needsYouEntries(board, me).map((e) => e.item.id)).toEqual(["b", "w", "z"]);
  });

  it("returns only the matching entries, never the whole column", () => {
    const board = boardWith({
      waiting: [entry("waiting", mine("a")), entry("waiting", { id: "other", state: "paused" })],
    });
    expect(needsYouEntries(board, me).map((e) => e.item.id)).toEqual(["a"]);
  });
});

describe("waitingSplit — the amber/red tally under the shared column", () => {
  it("tallies paused as amber and blocked as red, separately", () => {
    const board = boardWith({
      waiting: [
        entry("waiting", { id: "1", state: "paused" }),
        entry("waiting", { id: "2", state: "paused" }),
        entry("waiting", { id: "3", state: "blocked" }),
      ],
    });
    expect(waitingSplit(board)).toEqual({ amber: 2, red: 1, other: 0 });
  });

  it("is all zeroes when Waiting is empty", () => {
    expect(waitingSplit(emptyBoard())).toEqual({ amber: 0, red: 0, other: 0 });
  });

  it("counts a project in Waiting as `other`, so no card vanishes from the tally", () => {
    const board = boardWith({
      waiting: [
        entry("waiting", { id: "1", kind: "project", state: "paused" }),
        entry("waiting", { id: "2", state: "blocked" }),
      ],
    });
    const split = waitingSplit(board);
    expect(split).toEqual({ amber: 0, red: 1, other: 1 });
    // Every card in the column is accounted for by exactly one bucket.
    expect(split.amber + split.red + split.other).toBe(board.waiting.entries.length);
  });

  it("ignores cards in other columns entirely", () => {
    const board = boardWith({
      waiting: [entry("waiting", { state: "paused" })],
      in_progress: [entry("in_progress", { state: "paused" })],
      completed: [entry("completed", { state: "blocked" })],
    });
    expect(waitingSplit(board)).toEqual({ amber: 1, red: 0, other: 0 });
  });
});
