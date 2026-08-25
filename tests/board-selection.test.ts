// The selection model — T6-E's first half.
//
// These cover `src/lib/board/selection.ts` as pure functions, which is the
// layer where the *rules* live: what a shift-click means, what survives a
// reload, what cannot be selected at all. The wiring of those rules into
// React is a different question and a different failure mode, and it is
// covered by `tests/board-bulk-wiring.test.ts`, which mounts the real
// component. Neither file substitutes for the other — that is the lesson
// `board-react-wiring.test.ts` was written to record.
import { describe, expect, it } from "vitest";
import {
  emptySelection,
  isEmpty,
  isSelectable,
  isSelected,
  rangeFrom,
  reconcile,
  selectAll,
  selectableIds,
  selectedEntries,
  selectionSize,
  toggle,
} from "@/lib/board/selection";
import type { BoardEntry } from "@/lib/board/types";

/** A board entry with only the fields these tests read. */
function entry(id: string, overrides: Partial<BoardEntry["item"]> = {}): BoardEntry {
  return {
    item: {
      id,
      title: `Item ${id}`,
      headline: null,
      kind: "task",
      state: "on_deck",
      priority: "P1",
      area: "web",
      repo: null,
      blockedOnPersonId: null,
      blockedOnType: null,
      blockedReason: null,
      pauseReason: null,
      ...overrides,
    },
    column: "backlog",
    assignments: [],
    trust: null,
    subtasks: null,
  };
}

const ORDER = ["a", "b", "c", "d", "e"];

describe("toggle", () => {
  it("adds a row that was not selected", () => {
    const next = toggle(emptySelection(), "b");
    expect(isSelected(next, "b")).toBe(true);
    expect(selectionSize(next)).toBe(1);
  });

  it("removes a row that was", () => {
    const next = toggle(toggle(emptySelection(), "b"), "b");
    expect(isSelected(next, "b")).toBe(false);
    expect(isEmpty(next)).toBe(true);
  });

  it("moves the anchor even when the click DESELECTS", () => {
    // The anchor is "where the reader last put their attention", not "the
    // last thing selected" — so a shift-click after an unticking measures
    // from the row just unticked. An implementation that only moved the
    // anchor on selection would measure the next range from a row the
    // reader's cursor has left.
    const selected = toggle(emptySelection(), "b");
    const deselected = toggle(selected, "b");
    expect(deselected.anchor).toBe("b");
  });

  it("leaves the other selected rows alone", () => {
    // Toggle, not replace: the checkboxes are the primary affordance and a
    // box that cleared the others would be a radio button.
    const next = toggle(toggle(emptySelection(), "a"), "c");
    expect([...next.ids].sort()).toEqual(["a", "c"]);
  });
});

describe("rangeFrom", () => {
  it("selects everything between the anchor and the clicked row", () => {
    const anchored = toggle(emptySelection(), "b");
    const ranged = rangeFrom(anchored, "d", ORDER);
    expect([...ranged.ids].sort()).toEqual(["b", "c", "d"]);
  });

  it("works upwards as well as downwards", () => {
    // The gesture is symmetric to the reader, so min/max rather than an
    // assumption about which index is larger. An implementation that
    // iterated anchor→clicked without ordering them would select nothing
    // here.
    const anchored = toggle(emptySelection(), "d");
    const ranged = rangeFrom(anchored, "b", ORDER);
    expect([...ranged.ids].sort()).toEqual(["b", "c", "d"]);
  });

  it("ADDS the range rather than assigning the selection", () => {
    // A reader builds a selection out of several ranges. An assignment
    // would discard everything picked before, and they would only find out
    // by counting the bar.
    const withA = toggle(emptySelection(), "a");
    const anchored = toggle(withA, "c");
    const ranged = rangeFrom(anchored, "d", ORDER);
    expect([...ranged.ids].sort()).toEqual(["a", "c", "d"]);
  });

  it("keeps the anchor where it was, so the range stays adjustable", () => {
    // Clicking further down after a shift-click grows the SAME range rather
    // than starting a new one. If the anchor moved to the clicked row, the
    // second shift-click below would select only d–e instead of b–e.
    const anchored = toggle(emptySelection(), "b");
    const first = rangeFrom(anchored, "d", ORDER);
    expect(first.anchor).toBe("b");
    const second = rangeFrom(first, "e", ORDER);
    expect([...second.ids].sort()).toEqual(["b", "c", "d", "e"]);
  });

  it("falls back to a plain toggle when there is no anchor yet", () => {
    const ranged = rangeFrom(emptySelection(), "c", ORDER);
    expect([...ranged.ids]).toEqual(["c"]);
    expect(ranged.anchor).toBe("c");
  });

  it("falls back to a plain toggle when the anchor has left the list", () => {
    // The anchored row was filtered away or paged out. There is no range to
    // measure, and computing one from `indexOf === -1` would select from
    // the top of the list — the specific wrong answer this guards.
    const anchored = toggle(emptySelection(), "z");
    const ranged = rangeFrom(anchored, "d", ORDER);
    expect([...ranged.ids].sort()).toEqual(["d", "z"]);
  });

  it("selects just the one row when the anchor IS the clicked row", () => {
    const anchored = toggle(emptySelection(), "c");
    const ranged = rangeFrom(anchored, "c", ORDER);
    expect([...ranged.ids]).toEqual(["c"]);
  });
});

describe("selectAll", () => {
  it("selects every row given, and anchors at the first", () => {
    const all = selectAll(ORDER, true);
    expect([...all.ids].sort()).toEqual([...ORDER].sort());
    expect(all.anchor).toBe("a");
  });

  it("clears everything, anchor included", () => {
    const cleared = selectAll(ORDER, false);
    expect(isEmpty(cleared)).toBe(true);
    expect(cleared.anchor).toBeNull();
  });

  it("anchors at null for an empty list rather than at undefined", () => {
    // `order[0]` on an empty array is `undefined`, which would put a
    // non-null-but-meaningless anchor on the selection and make
    // `rangeFrom`'s `anchor === null` fallback fail to fire.
    const all = selectAll([], true);
    expect(all.anchor).toBeNull();
  });
});

describe("reconcile", () => {
  it("keeps the rows that are still shown", () => {
    // Selection survives a reload that still shows the row — the paging
    // case, which is exactly when a large selection is being built.
    const selected = selectAll(["a", "b", "c"], true);
    const next = reconcile(selected, ["a", "b", "c", "d"]);
    expect([...next.ids].sort()).toEqual(["a", "b", "c"]);
  });

  it("drops the rows that have gone", () => {
    // The dangerous direction: a selection retaining rows a filter removed
    // would be one click from moving items not in front of the reader.
    const selected = selectAll(["a", "b", "c"], true);
    const next = reconcile(selected, ["a", "c"]);
    expect([...next.ids].sort()).toEqual(["a", "c"]);
  });

  it("drops an anchor whose row has gone", () => {
    const anchored = toggle(emptySelection(), "b");
    const next = reconcile(anchored, ["a", "c"]);
    expect(next.anchor).toBeNull();
  });

  it("returns the SAME object when nothing changed", () => {
    // Not a micro-optimisation: this runs on every board load, and a fresh
    // object every time is a new identity in a dependency list — which is
    // how a reconcile-on-load becomes a render loop. The effect that calls
    // this compares by identity to decide whether to write.
    const selected = selectAll(["a", "b"], true);
    expect(reconcile(selected, ["a", "b", "c"])).toBe(selected);
  });
});

describe("isSelectable", () => {
  it("refuses a project", () => {
    // A project has no state of its own to transition (DECISIONS.md §13c);
    // the service refuses with `ProjectHasNoStateError`. A checkbox would
    // offer a gesture that could only ever be refused — and inside a batch,
    // where the refusal is a line in a report rather than something the
    // reader watches happen.
    expect(isSelectable(entry("p", { kind: "project" }))).toBe(false);
  });

  it("allows a task and a subtask", () => {
    expect(isSelectable(entry("t", { kind: "task" }))).toBe(true);
    expect(isSelectable(entry("s", { kind: "subtask" }))).toBe(true);
  });

  it("filters projects out of the selectable ids, keeping order", () => {
    const ids = selectableIds([entry("a"), entry("p", { kind: "project" }), entry("b")]);
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("selectedEntries", () => {
  it("resolves against the LOADED board, dropping ids whose rows have gone", () => {
    // The property that makes "selection holds ids" safe: whatever the
    // selection says, a bulk acts on the intersection with what is actually
    // loaded. An id with no row simply does not appear.
    const selection = selectAll(["a", "gone", "c"], true);
    const resolved = selectedEntries(selection, [entry("a"), entry("b"), entry("c")]);
    expect(resolved.map((e) => e.item.id)).toEqual(["a", "c"]);
  });

  it("returns them in board order, not click order", () => {
    // The partial-failure report reads down the list the way the reader's
    // eye does. Ordered by when each row was clicked, it would be
    // unscannable against the list it describes.
    const clickedCThenA = toggle(toggle(emptySelection(), "c"), "a");
    const resolved = selectedEntries(clickedCThenA, [entry("a"), entry("b"), entry("c")]);
    expect(resolved.map((e) => e.item.id)).toEqual(["a", "c"]);
  });
});
