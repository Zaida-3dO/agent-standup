// The drop seam's conflict branch — T17, part 2.
//
// **The behaviour under test is the one that differs from every other
// refusal.** An ordinary refusal means the move did not happen, so the card
// goes back where it was. A 409 means the item genuinely *did* move — by
// someone else — so putting the card back where this client last saw it would
// be a second wrong answer delivered confidently. These assert that the two
// paths really are different, because a conflict quietly falling through to
// `moveRefused` would look correct in every screenshot and be wrong in the
// one case the row is about.
import { describe, expect, it, vi } from "vitest";
import { conflictEntry, handleDrop, type DropDeps } from "@/lib/board/drop-handler";
import { dragStarted, initialDragState, type DragState } from "@/lib/board/drag-state";
import type { MoveResult } from "@/lib/board/move";
import type { Board, BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";
import { boardOf } from "./helpers/board-sections";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "a",
    title: "An item",
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
  return { item: item(overrides), column, assignments: [], trust: null, subtasks: null };
}

function columnOf(board: Board, itemId: string): BoardColumnId | null {
  for (const column of ["backlog", "in_progress", "waiting", "completed"] as const) {
    if (board[column].entries.some((candidate) => candidate.item.id === itemId)) return column;
  }
  return null;
}

/**
 * The same deferring host `board-drop-handler.test.ts` uses — see its header
 * for why `update` must defer rather than run inline.
 */
function host(
  initial: DragState,
  result: MoveResult,
  describeConflict?: DropDeps["describeConflict"],
) {
  let current = initial;
  const queued: ((current: DragState) => DragState)[] = [];
  const flush = () => {
    while (queued.length > 0) {
      const next = queued.shift();
      if (next !== undefined) current = next(current);
    }
  };
  const deps: DropDeps = {
    read: () => current,
    write: (next) => {
      current = next;
    },
    update: (fn) => {
      queued.push(fn);
    },
    move: vi.fn(() => Promise.resolve(result)),
    ...(describeConflict === undefined ? {} : { describeConflict }),
  };
  return { deps, flush, state: () => current };
}

/** A board with one card in Backlog, picked up ready to drop on In Progress. */
function pickedUp(): DragState {
  const board: Board = boardOf({ backlog: [entry("backlog")] });
  return dragStarted(initialDragState(board), "a");
}

const CONFLICT: MoveResult = {
  ok: false,
  message: "Someone else changed this item first. The board has been updated.",
  conflict: { currentState: "in_review", expectedFrom: "on_deck" },
};

describe("a refused move that was a conflict", () => {
  it("settles the card on the state the server reported, rather than reverting it", async () => {
    // The card was dragged Backlog to In Progress; the server says it is
    // actually in `in_review`, which is also In Progress. Reverting to
    // Backlog would show a position that is wrong.
    const h = host(pickedUp(), CONFLICT);
    await handleDrop(h.deps, "in_progress");
    h.flush();

    expect(columnOf(h.state().board, "a")).toBe("in_progress");
    const settled = h
      .state()
      .board.in_progress.entries.find((candidate) => candidate.item.id === "a");
    expect(settled?.item.state).toBe("in_review");
  });

  it("moves the card to the column the server's state belongs to", async () => {
    // `merged` is Completed — a different column from the one dropped on, so
    // this cannot pass by accident from the optimistic move being left alone.
    const h = host(pickedUp(), {
      ...CONFLICT,
      conflict: { currentState: "merged", expectedFrom: "on_deck" },
    });
    await handleDrop(h.deps, "in_progress");
    h.flush();

    expect(columnOf(h.state().board, "a")).toBe("completed");
  });

  it("shows the sentence the host built, naming who moved it", async () => {
    const describeConflict = vi.fn(() => "bunmi-4c7 moved this to in review 12s ago.");
    const h = host(pickedUp(), CONFLICT, describeConflict);
    await handleDrop(h.deps, "in_progress");
    h.flush();

    expect(describeConflict).toHaveBeenCalledWith(
      { currentState: "in_review", expectedFrom: "on_deck" },
      "a",
    );
    expect(h.state().refusal).toBe("bunmi-4c7 moved this to in review 12s ago.");
  });

  it("falls back to the server's message when no live feed can attribute it", async () => {
    const h = host(pickedUp(), CONFLICT);
    await handleDrop(h.deps, "in_progress");
    h.flush();

    expect(h.state().refusal).toBe(CONFLICT.message);
  });

  it("clears the pending marks like any other settled move", async () => {
    const h = host(pickedUp(), CONFLICT);
    await handleDrop(h.deps, "in_progress");
    h.flush();

    expect(h.state().pendingItemId).toBeNull();
    expect(h.state().pendingOriginal).toBeNull();
  });

  it("offers no undo — the move was not this person's to undo", async () => {
    const offerUndo = vi.fn();
    const h = host(pickedUp(), CONFLICT);
    await handleDrop({ ...h.deps, offerUndo }, "in_progress");
    h.flush();

    expect(offerUndo).not.toHaveBeenCalled();
  });
});

describe("a refused move that was NOT a conflict", () => {
  it("still reverts, exactly as it did before this branch existed", async () => {
    // The guard this row must not break: an ordinary refusal means the move
    // did not happen and the card belongs where it was.
    const h = host(pickedUp(), { ok: false, message: "That move was refused." });
    await handleDrop(h.deps, "in_progress");
    h.flush();

    expect(columnOf(h.state().board, "a")).toBe("backlog");
    expect(h.state().board.backlog.entries[0]?.item.state).toBe("on_deck");
    expect(h.state().refusal).toBe("That move was refused.");
  });

  it("reverts a 409 whose details could not be read", async () => {
    // `move.ts` leaves `conflict` absent when it could not parse the details,
    // and an unparsed conflict must take the safe path rather than guessing a
    // state.
    const h = host(pickedUp(), {
      ok: false,
      message: "Someone else changed this item first. The board has been updated.",
    });
    await handleDrop(h.deps, "in_progress");
    h.flush();

    expect(columnOf(h.state().board, "a")).toBe("backlog");
  });
});

describe("conflictEntry", () => {
  it("keeps everything the other person's move did not touch", () => {
    // Blanking assignments or the rollup would make a teammate's move look
    // like data loss.
    const base: BoardEntry = {
      item: item({ title: "Real title", priority: "P0" }),
      column: "backlog",
      assignments: [
        {
          holderId: "bunmi",
          holderType: "agent",
          displayName: "Bunmi",
          role: "builder",
          roleCustom: null,
          liveness: "running",
          lastActive: "2026-08-25T12:00:00.000Z",
        },
      ],
      trust: null,
      subtasks: { total: 3, done: 1 },
    };
    const state = initialDragState(boardOf({ backlog: [base] }));

    const settled = conflictEntry(state, "a", "in_review");
    expect(settled?.item.title).toBe("Real title");
    expect(settled?.item.priority).toBe("P0");
    expect(settled?.assignments).toHaveLength(1);
    expect(settled?.subtasks).toEqual({ total: 3, done: 1 });
    // Only these two are known to have moved.
    expect(settled?.item.state).toBe("in_review");
    expect(settled?.column).toBe("in_progress");
  });

  it("returns null for a state this build does not recognise", () => {
    // A state with no column would otherwise be guessed into an arbitrary one.
    const state = initialDragState(boardOf({ backlog: [entry("backlog")] }));
    expect(conflictEntry(state, "a", "not_a_real_state")).toBeNull();
  });

  it("returns null for an item this board does not hold", () => {
    const state = initialDragState(boardOf({ backlog: [entry("backlog")] }));
    expect(conflictEntry(state, "missing", "in_review")).toBeNull();
  });

  it("prefers the pre-move entry over the optimistically-moved one", () => {
    // The pre-move copy is the one that has not been overwritten by the
    // client's guess at a state.
    const original = entry("backlog", { title: "Before the drag" });
    const state: DragState = {
      ...initialDragState(boardOf({ in_progress: [entry("in_progress", { state: "executing" })] })),
      pendingOriginal: original,
    };
    expect(conflictEntry(state, "a", "in_review")?.item.title).toBe("Before the drag");
  });
});
