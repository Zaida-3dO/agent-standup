// The seam between the drag reducer and React — MILESTONES.md #73.
//
// **This file exists because a review found a defect here and no test could
// have caught it.** The reducers and the request were each covered
// thoroughly; the single line of glue joining them to React was not, and
// that is where the bug lived: the request was read out of a `setState`
// updater, on the assumption React evaluates updaters eagerly. It does so
// only when no update is already pending on the fiber — and on the board
// there always is one — so the request came back `null`, no transition was
// ever sent, and the card moved optimistically with nothing to settle or
// revert it. A move that shows and then quietly disappears: precisely the
// failure this row exists to prevent.
//
// So the first assertion below is the blunt one that would have caught it:
// **a drop issues a request.**
import { describe, expect, it, vi } from "vitest";
import { handleDrop, type DropDeps } from "@/lib/board/drop-handler";
import { dragStarted, initialDragState, type DragState } from "@/lib/board/drag-state";
import type { MoveResult } from "@/lib/board/move";
import type { Board, BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";
import { boardOf } from "./helpers/board-sections";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "a",
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
  // These fixtures are about drag, tone and tallies; ownership is proved
  // against real data in the operation's own suites. An empty list is what
  // the API sends for an item nobody holds, so it is the honest default.
  return { item: item(overrides), column, assignments: [], trust: null, subtasks: null };
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

function columnOf(board: Board, itemId: string): BoardColumnId | null {
  for (const column of ["backlog", "in_progress", "waiting", "completed"] as const) {
    if (board[column].entries.some((e) => e.item.id === itemId)) return column;
  }
  return null;
}

/**
 * A host that stores state the way the component does — a synchronously
 * readable copy advanced on every write.
 *
 * **`update` DEFERS its updater, and that is the whole point of this
 * harness.** React evaluates a `setState` updater eagerly only when no
 * update is already pending on the fiber; otherwise it runs at render, well
 * after the event handler has returned. A test host that ran the updater
 * inline would model only the lucky fast path — and would therefore pass
 * against the very defect this file exists to catch, which is exactly what
 * an earlier draft of this harness did. Deferring by default is the
 * pessimistic, and realistic, choice: anything that depends on an updater
 * having already run is a bug here, and shows up as one.
 *
 * `flush` applies the queued updaters, standing in for React's render.
 */
function host(initial: DragState, result?: MoveResult) {
  let current = initial;
  const queued: ((current: DragState) => DragState)[] = [];
  const moves: { itemId: string; column: BoardColumnId }[] = [];
  const flush = () => {
    while (queued.length > 0) {
      current = queued.shift()!(current);
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
    move: vi.fn((itemId: string, column: BoardColumnId): Promise<MoveResult> => {
      moves.push({ itemId, column });
      return Promise.resolve(
        result ?? {
          ok: true,
          entry: { item: item({ state: "executing" }), column, assignments: [], trust: null, subtasks: null },
        },
      );
    }),
  };
  return {
    deps,
    moves,
    flush,
    state: () => {
      flush();
      return current;
    },
  };
}

/** A state holding one draggable card in the backlog, already picked up. */
function pickedUp(): DragState {
  return dragStarted(
    initialDragState(boardWith({ backlog: [entry("backlog", { id: "a" })] })),
    "a",
  );
}

describe("handleDrop — a drop actually reaches the server", () => {
  it("ISSUES A REQUEST on a real move", async () => {
    // The regression test for the review finding. If the request is ever
    // read from somewhere that is not synchronously available again, this
    // is the assertion that fails.
    const h = host(pickedUp());
    const pending = handleDrop(h.deps, "in_progress");

    expect(pending).not.toBeNull();
    expect(h.moves).toEqual([{ itemId: "a", column: "in_progress" }]);
    await pending;
  });

  it("issues the request even when EVERY state updater is deferred indefinitely", async () => {
    // The harshest version of the review's finding: this host never runs a
    // queued updater at all. Anything that reads its decision out of one
    // gets nothing, so the request would never be sent. The request must
    // still go out, because the decision is made against synchronously
    // readable state rather than an updater's argument.
    let stored = pickedUp();
    const moves: string[] = [];
    const deps: DropDeps = {
      read: () => stored,
      write: (next) => {
        stored = next;
      },
      update: () => {
        /* dropped on the floor — the pathological case */
      },
      move: (itemId, column) => {
        moves.push(`${itemId}->${column}`);
        return Promise.resolve({
          ok: true,
          entry: { item: item({ state: "executing" }), column, assignments: [], trust: null, subtasks: null },
        });
      },
    };

    await handleDrop(deps, "in_progress");
    expect(moves).toEqual(["a->in_progress"]);
  });

  it("applies the optimistic move BEFORE the request resolves", () => {
    const h = host(pickedUp());
    handleDrop(h.deps, "in_progress");
    // Not awaited: the card is already there.
    expect(columnOf(h.state().board, "a")).toBe("in_progress");
    expect(h.state().pendingItemId).toBe("a");
  });

  it("settles on the server's answer once it arrives", async () => {
    const h = host(pickedUp(), {
      ok: true,
      entry: {
        item: item({ id: "a", state: "blocked" }),
        column: "waiting",
        assignments: [],
        trust: null,
        subtasks: null,
      },
    });
    await handleDrop(h.deps, "in_progress");

    expect(columnOf(h.state().board, "a")).toBe("waiting");
    expect(h.state().pendingItemId).toBeNull();
    expect(h.state().refusal).toBeNull();
  });

  it("reverts and explains when the server refuses", async () => {
    const h = host(pickedUp(), { ok: false, message: "A summary is required." });
    await handleDrop(h.deps, "completed");

    expect(columnOf(h.state().board, "a")).toBe("backlog");
    expect(h.state().board.backlog.entries[0]!.item.state).toBe("on_deck");
    expect(h.state().refusal).toBe("A summary is required.");
    expect(h.state().pendingItemId).toBeNull();
  });

  it("makes NO request, and returns null, for a drop that is not a move", () => {
    const h = host(pickedUp());
    // Same column the card is already in.
    expect(handleDrop(h.deps, "backlog")).toBeNull();
    expect(h.moves).toEqual([]);
  });

  it("makes NO request for a column that accepts no drops", () => {
    const h = host(pickedUp());
    expect(handleDrop(h.deps, "waiting")).toBeNull();
    expect(h.moves).toEqual([]);
  });

  it("makes NO request when nothing is being dragged", () => {
    const h = host(initialDragState(boardWith({ backlog: [entry("backlog", { id: "a" })] })));
    expect(handleDrop(h.deps, "in_progress")).toBeNull();
    expect(h.moves).toEqual([]);
  });

  it("makes NO request for a project, which has no state to transition", () => {
    const state = dragStarted(
      initialDragState(boardWith({ waiting: [entry("waiting", { id: "p", kind: "project" })] })),
      "p",
    );
    const h = host(state);
    expect(handleDrop(h.deps, "in_progress")).toBeNull();
    expect(h.moves).toEqual([]);
  });

  it("gives two drops in the same tick different sequence numbers", async () => {
    // Both drops read the newest state, so the second supersedes the first
    // rather than colliding with it — which is what makes the staleness
    // check in `drag-state` meaningful at all.
    const h = host(pickedUp());
    const first = handleDrop(h.deps, "in_progress");
    h.deps.write(dragStarted(h.state(), "a"));
    const second = handleDrop(h.deps, "completed");

    expect(h.moves).toEqual([
      { itemId: "a", column: "in_progress" },
      { itemId: "a", column: "completed" },
    ]);
    await Promise.all([first, second]);
    // The later drop wins; the earlier answer is stale and ignored.
    expect(columnOf(h.state().board, "a")).toBe("completed");
  });
});
