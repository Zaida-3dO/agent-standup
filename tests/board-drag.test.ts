// Dragging a card between columns — MILESTONES.md #73.
//
// The pure half: the target state per column, the optimistic move, the
// revert, and the refusal messages. No DOM, no server — every function
// under test is a plain function over plain data, which is why the
// interaction's logic lives in `@/lib/board/drag` rather than inside an
// event handler.
import { describe, expect, it } from "vitest";
import {
  TARGET_STATE,
  acceptsDrop,
  applyOptimisticMove,
  findEntry,
  isDraggable,
  isMove,
  networkRefusalMessage,
  reconcile,
  refusalMessage,
  revertMove,
} from "@/lib/board/drag";
import { BOARD_COLUMNS, emptyBoard } from "@/lib/board/view";
import { STATE_TO_COLUMN_FOR_TESTS } from "./helpers/board-states";
import type { Board, BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    title: "An item",
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

function boardWith(overrides: Partial<Board> = {}): Board {
  return { ...emptyBoard(), ...overrides };
}

describe("TARGET_STATE", () => {
  it("has an entry for every column, so none is left undefined", () => {
    for (const column of BOARD_COLUMNS) {
      expect(TARGET_STATE, `${column} missing`).toHaveProperty(column);
    }
  });

  it("picks a state that actually belongs to the column it is the target for", () => {
    // The worst bug available here: a target state in the *wrong* column
    // means every drop on that column moves the card somewhere else, and
    // the optimistic update would show it landing where it was dropped
    // before the server put it elsewhere.
    for (const column of BOARD_COLUMNS) {
      const target = TARGET_STATE[column];
      if (target === null) continue;
      expect(STATE_TO_COLUMN_FOR_TESTS[target], `${column}'s target`).toBe(column);
    }
  });

  it("makes Waiting unreachable, because BOTH its states need fields a drag has not got", () => {
    // `blocked` needs blocked_reason + blocked_on_type; `paused` needs
    // pause_reason + resume_condition (guards/blocked-paused.ts). There is
    // no third state to fall back on, so every drop here would be refused —
    // proved against the real guards in
    // tests/board-drag-transitions.test.ts.
    expect(TARGET_STATE.waiting).toBeNull();
    expect(acceptsDrop("waiting")).toBe(false);
  });

  it("keeps every other column droppable", () => {
    expect(acceptsDrop("backlog")).toBe(true);
    expect(acceptsDrop("in_progress")).toBe(true);
    // Completed is offered even though a guard often refuses it: that
    // refusal is about the item lacking a summary, not about the gesture.
    expect(acceptsDrop("completed")).toBe(true);
  });
});

describe("isDraggable", () => {
  it("refuses a project — its column derives from its children", () => {
    // DECISIONS.md §13c. The service refuses the transition outright, so
    // offering the gesture would teach the wrong model of the data.
    expect(isDraggable(entry("waiting", { kind: "project" }))).toBe(false);
  });

  it("allows a task and a subtask", () => {
    expect(isDraggable(entry("backlog", { kind: "task" }))).toBe(true);
    expect(isDraggable(entry("backlog", { kind: "subtask" }))).toBe(true);
  });
});

describe("isMove", () => {
  it("is false for a drop on the column the card is already in", () => {
    // Not a no-op worth issuing: it would write a state-change event
    // recording that nothing happened.
    expect(isMove(entry("backlog"), "backlog")).toBe(false);
  });

  it("is true for a drop on a different column", () => {
    expect(isMove(entry("backlog"), "in_progress")).toBe(true);
  });

  it("is false for a project, whatever the column", () => {
    expect(isMove(entry("backlog", { kind: "project" }), "in_progress")).toBe(false);
  });

  it("is false for a drop on Waiting, which accepts none", () => {
    expect(isMove(entry("backlog"), "waiting")).toBe(false);
  });
});

describe("applyOptimisticMove", () => {
  it("moves the card to the target column immediately", () => {
    const board = boardWith({ backlog: [entry("backlog", { id: "a" })] });
    const moved = applyOptimisticMove(board, "a", "in_progress");
    expect(moved.backlog).toHaveLength(0);
    expect(moved.in_progress.map((e) => e.item.id)).toEqual(["a"]);
  });

  it("updates the entry's OWN column, not just its position", () => {
    // The client reads `entry.column` everywhere (#37's convention), so a
    // card moved between arrays without this would render in one column and
    // describe itself as being in another — and the Waiting tone would be
    // read from the stale one.
    const board = boardWith({ backlog: [entry("backlog", { id: "a" })] });
    const moved = applyOptimisticMove(board, "a", "completed");
    expect(moved.completed[0]!.column).toBe("completed");
  });

  it("updates the item's state to the target column's, so the chip is not stale", () => {
    const board = boardWith({ backlog: [entry("backlog", { id: "a", state: "on_deck" })] });
    const moved = applyOptimisticMove(board, "a", "completed");
    expect(moved.completed[0]!.item.state).toBe("merged");
  });

  it("does not mutate the board it was given", () => {
    const board = boardWith({ backlog: [entry("backlog", { id: "a" })] });
    applyOptimisticMove(board, "a", "in_progress");
    expect(board.backlog).toHaveLength(1);
    expect(board.in_progress).toHaveLength(0);
  });

  it("leaves the board alone for a drop that is not a move", () => {
    const board = boardWith({ backlog: [entry("backlog", { id: "a" })] });
    expect(applyOptimisticMove(board, "a", "backlog")).toBe(board);
    expect(applyOptimisticMove(board, "missing", "completed")).toBe(board);
  });

  it("refuses to move a project even when asked directly", () => {
    const board = boardWith({ waiting: [entry("waiting", { id: "p", kind: "project" })] });
    expect(applyOptimisticMove(board, "p", "completed")).toBe(board);
  });
});

describe("revertMove", () => {
  it("puts the card back in its original column", () => {
    const original = entry("backlog", { id: "a", state: "on_deck" });
    const moved = applyOptimisticMove(boardWith({ backlog: [original] }), "a", "in_progress");
    const reverted = revertMove(moved, original);
    expect(reverted.in_progress).toHaveLength(0);
    expect(reverted.backlog.map((e) => e.item.id)).toEqual(["a"]);
  });

  it("restores the item's ORIGINAL state, not the one the drag guessed", () => {
    // A revert that restored only the position would leave the card back in
    // its old column still carrying the guessed state — a subtler wrong
    // answer than not reverting at all, because it looks correct.
    const original = entry("backlog", { id: "a", state: "on_deck" });
    const moved = applyOptimisticMove(boardWith({ backlog: [original] }), "a", "completed");
    expect(moved.completed[0]!.item.state).toBe("merged");

    const reverted = revertMove(moved, original);
    expect(reverted.backlog[0]!.item.state).toBe("on_deck");
    expect(reverted.backlog[0]!.column).toBe("backlog");
  });

  it("never leaves the card in two columns at once", () => {
    const original = entry("backlog", { id: "a" });
    const moved = applyOptimisticMove(boardWith({ backlog: [original] }), "a", "completed");
    const reverted = revertMove(moved, original);
    const appearances = BOARD_COLUMNS.flatMap((column) =>
      reverted[column].filter((e) => e.item.id === "a"),
    );
    expect(appearances).toHaveLength(1);
  });
});

describe("reconcile", () => {
  it("settles on the SERVER's column and item, not the optimistic guess", () => {
    // A guard is free to land the item somewhere other than the requested
    // state. Without this the board would show the guess indefinitely.
    const board = applyOptimisticMove(
      boardWith({ backlog: [entry("backlog", { id: "a" })] }),
      "a",
      "in_progress",
    );
    const settled = reconcile(board, {
      item: item({ id: "a", state: "blocked" }),
      column: "waiting",
    });
    expect(settled.in_progress).toHaveLength(0);
    expect(settled.waiting[0]!.item.state).toBe("blocked");
  });
});

describe("findEntry", () => {
  it("finds a card in any column and reports null for one that is absent", () => {
    const board = boardWith({ waiting: [entry("waiting", { id: "a" })] });
    expect(findEntry(board, "a")?.item.id).toBe("a");
    expect(findEntry(board, "nope")).toBeNull();
  });
});

describe("refusalMessage", () => {
  it("prefers the server's own message — a guard names the field it wants", () => {
    expect(refusalMessage(422, "A summary is required to merge.")).toBe(
      "A summary is required to merge.",
    );
  });

  it("explains a project refusal in terms of what to do instead", () => {
    const message = refusalMessage(403, null);
    expect(message).toContain("children");
  });

  it("has a message for every refusal, never an empty string", () => {
    // The failure this row exists to avoid is a silent revert, so a blank
    // message is as bad as no message at all.
    for (const status of [400, 403, 404, 409, 422, 500]) {
      expect(refusalMessage(status, null).trim(), `status ${status}`).not.toBe("");
    }
    expect(networkRefusalMessage().trim()).not.toBe("");
  });

  it("falls back to its own wording when the server sent a blank message", () => {
    expect(refusalMessage(404, "   ")).toContain("could not be found");
  });

  it("names the status for a refusal it has no specific wording for", () => {
    expect(refusalMessage(500, null)).toContain("500");
  });
});
