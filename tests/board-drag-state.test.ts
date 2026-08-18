// The drag interaction, driven end to end — MILESTONES.md #73.
//
// A whole drag is a sequence of pure calls here: pick up, drop (which
// applies the optimistic move), then either the server's acceptance or its
// refusal. That is the entire reason the interaction is a reducer rather
// than a handful of `setState` calls inside an event handler — with
// `environment: "node"` and no DOM, this is the only way the intermediate
// boards are inspectable at all.
//
// **The refusals are the point of this file.** The state machine is real
// and it refuses moves; a drag that shows a move which then silently
// reverts, or worse does not revert, is the failure this row has to avoid.
import { describe, expect, it } from "vitest";
import {
  boardReplaced,
  dragEnded,
  dragStarted,
  draggedOver,
  dropped,
  initialDragState,
  isStale,
  moveRefused,
  moveSettled,
  refusalDismissed,
} from "@/lib/board/drag-state";
import type { Board, BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";
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
    state: "on_deck",
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
 * Takes bare entry lists rather than whole sections: a column's count and
 * cursor (MILESTONES.md #109, #123) are proved against real data in
 * `tests/board-pagination.test.ts`, and restating them at every fixture
 * site here would bury what these tests are actually about.
 */
function boardWith(overrides: Partial<Record<BoardColumnId, readonly BoardEntry[]>> = {}): Board {
  return boardOf(overrides);
}

/** Which column a card is rendered in, or null. */
function columnOf(board: Board, itemId: string): BoardColumnId | null {
  for (const column of ["backlog", "in_progress", "waiting", "completed"] as const) {
    if (board[column].entries.some((e) => e.item.id === itemId)) return column;
  }
  return null;
}

/** A state with one draggable card sitting in the backlog, already picked up. */
function pickedUp() {
  const original = entry("backlog", { id: "a", state: "on_deck" });
  const state = initialDragState(boardWith({ backlog: [original] }));
  return { original, state: dragStarted(state, "a") };
}

describe("picking a card up and putting it down", () => {
  it("records which card is being dragged and which column it is over", () => {
    const { state } = pickedUp();
    expect(state.draggingItemId).toBe("a");

    const over = draggedOver(state, "completed");
    expect(over.overColumn).toBe("completed");
  });

  it("clears the drag when it ends without a drop", () => {
    const { state } = pickedUp();
    const ended = dragEnded(draggedOver(state, "completed"));
    expect(ended.draggingItemId).toBeNull();
    expect(ended.overColumn).toBeNull();
    // And nothing moved.
    expect(columnOf(ended.board, "a")).toBe("backlog");
  });

  it("clears a previous refusal when a new drag starts", () => {
    // A stale message about the last move would read as though it applied
    // to the one now in progress.
    const { state, original } = pickedUp();
    const { state: afterDrop } = dropped(draggedOver(state, "completed"), "completed");
    const refused = moveRefused(afterDrop, afterDrop.sequence, "nope");
    expect(refused.refusal).toBe("nope");

    expect(dragStarted(refused, original.item.id).refusal).toBeNull();
  });

  it("dismisses a refusal on request", () => {
    const { state } = pickedUp();
    const { state: afterDrop } = dropped(state, "completed");
    const refused = moveRefused(afterDrop, afterDrop.sequence, "nope");
    expect(refusalDismissed(refused).refusal).toBeNull();
  });
});

describe("the optimistic move — 'showing immediately'", () => {
  it("moves the card BEFORE any request is made", () => {
    const { state } = pickedUp();
    const { state: afterDrop, request } = dropped(state, "in_progress");

    // The card is already there, and the request has only just been handed
    // back to the caller to make.
    expect(columnOf(afterDrop.board, "a")).toBe("in_progress");
    expect(request).toEqual({ itemId: "a", column: "in_progress", sequence: 1 });
  });

  it("marks the card as pending while its move is in flight", () => {
    const { state } = pickedUp();
    const { state: afterDrop } = dropped(state, "in_progress");
    expect(afterDrop.pendingItemId).toBe("a");
  });

  it("keeps the original entry so a refusal can put it back exactly", () => {
    const { state } = pickedUp();
    const { state: afterDrop } = dropped(state, "completed");
    expect(afterDrop.pendingOriginal?.column).toBe("backlog");
    expect(afterDrop.pendingOriginal?.item.state).toBe("on_deck");
  });

  it("makes NO request for a drop on the card's own column", () => {
    const { state } = pickedUp();
    const { state: afterDrop, request } = dropped(state, "backlog");
    expect(request).toBeNull();
    expect(afterDrop.pendingItemId).toBeNull();
    expect(columnOf(afterDrop.board, "a")).toBe("backlog");
  });

  it("makes NO request for a drop with nothing being dragged", () => {
    const state = initialDragState(boardWith({ backlog: [entry("backlog", { id: "a" })] }));
    const { request } = dropped(state, "completed");
    expect(request).toBeNull();
  });

  it("makes NO request for a project, which has no state to transition", () => {
    // DECISIONS.md §13c — belt and braces with the card not being draggable
    // in the first place.
    const project = entry("waiting", { id: "p", kind: "project" });
    const state = dragStarted(initialDragState(boardWith({ waiting: [project] })), "p");
    const { state: afterDrop, request } = dropped(state, "in_progress");
    expect(request).toBeNull();
    expect(columnOf(afterDrop.board, "p")).toBe("waiting");
  });
});

describe("the server accepts", () => {
  it("settles on the entry the server returned", () => {
    const { state } = pickedUp();
    const { state: afterDrop, request } = dropped(state, "in_progress");
    const settled = moveSettled(afterDrop, request!.sequence, {
      item: item({ id: "a", state: "executing" }),
      column: "in_progress",
    });

    expect(columnOf(settled.board, "a")).toBe("in_progress");
    expect(settled.board.in_progress.entries[0]!.item.state).toBe("executing");
    expect(settled.pendingItemId).toBeNull();
    expect(settled.refusal).toBeNull();
  });

  it("follows the server even when it landed the item somewhere else entirely", () => {
    // A guard is free to put the item in a different state than the one
    // asked for. The board has to end up where the server says, not where
    // the drag guessed.
    const { state } = pickedUp();
    const { state: afterDrop, request } = dropped(state, "in_progress");
    const settled = moveSettled(afterDrop, request!.sequence, {
      item: item({ id: "a", state: "blocked" }),
      column: "waiting",
    });

    expect(columnOf(settled.board, "a")).toBe("waiting");
    expect(settled.board.waiting.entries[0]!.item.state).toBe("blocked");
  });
});

describe("the server refuses — the failure this row exists to handle", () => {
  it("puts the card BACK, with its original state, and says why", () => {
    const { state } = pickedUp();
    const { state: afterDrop, request } = dropped(state, "completed");
    expect(columnOf(afterDrop.board, "a")).toBe("completed"); // shown immediately

    const refused = moveRefused(
      afterDrop,
      request!.sequence,
      "A summary is required to complete this item.",
    );

    expect(columnOf(refused.board, "a")).toBe("backlog");
    expect(refused.board.backlog.entries[0]!.item.state).toBe("on_deck");
    expect(refused.board.backlog.entries[0]!.column).toBe("backlog");
    expect(refused.refusal).toBe("A summary is required to complete this item.");
    expect(refused.pendingItemId).toBeNull();
  });

  it("never leaves the card in two columns, nor in none", () => {
    // Both halves of "does not revert properly": a duplicate, and a card
    // that vanishes off the board altogether.
    const { state } = pickedUp();
    const { state: afterDrop, request } = dropped(state, "completed");
    const refused = moveRefused(afterDrop, request!.sequence, "nope");

    const appearances = (["backlog", "in_progress", "waiting", "completed"] as const).flatMap(
      (column) => refused.board[column].entries.filter((e) => e.item.id === "a"),
    );
    expect(appearances).toHaveLength(1);
    expect(appearances[0]!.column).toBe("backlog");
  });

  it("always carries a message — a silent revert is the bug", () => {
    const { state } = pickedUp();
    const { state: afterDrop, request } = dropped(state, "completed");
    const refused = moveRefused(afterDrop, request!.sequence, "anything");
    expect(refused.refusal).not.toBeNull();
    expect(refused.refusal!.trim()).not.toBe("");
  });
});

describe("two moves in quick succession", () => {
  it("ignores a refusal for a move that has since been superseded", () => {
    // The ordering bug: the first request's refusal lands after the card
    // has already been dragged somewhere else. Reverting to the entry
    // captured at the FIRST drop would undo the second move too.
    const { state } = pickedUp();
    const { state: firstDrop, request: first } = dropped(state, "in_progress");

    const secondPickUp = dragStarted(firstDrop, "a");
    const { state: secondDrop } = dropped(secondPickUp, "completed");
    expect(columnOf(secondDrop.board, "a")).toBe("completed");

    // The FIRST move's refusal now arrives, late.
    const after = moveRefused(secondDrop, first!.sequence, "too late");

    expect(after).toBe(secondDrop);
    expect(columnOf(after.board, "a")).toBe("completed");
    expect(after.refusal).toBeNull();
  });

  it("ignores a success for a move that has since been superseded", () => {
    const { state } = pickedUp();
    const { state: firstDrop, request: first } = dropped(state, "in_progress");
    const { state: secondDrop } = dropped(dragStarted(firstDrop, "a"), "completed");

    const after = moveSettled(secondDrop, first!.sequence, {
      item: item({ id: "a", state: "executing" }),
      column: "in_progress",
    });

    expect(after).toBe(secondDrop);
    expect(columnOf(after.board, "a")).toBe("completed");
  });

  it("recognises the newest move as current", () => {
    const { state } = pickedUp();
    const { state: afterDrop, request } = dropped(state, "in_progress");
    expect(isStale(afterDrop, request!.sequence)).toBe(false);
    expect(isStale(afterDrop, request!.sequence - 1)).toBe(true);
  });
});

describe("boardReplaced", () => {
  it("swaps the data without losing the interaction state", () => {
    const { state } = pickedUp();
    const replaced = boardReplaced(state, boardWith({ waiting: [entry("waiting", { id: "b" })] }));
    expect(columnOf(replaced.board, "b")).toBe("waiting");
    expect(replaced.draggingItemId).toBe("a");
  });
});
