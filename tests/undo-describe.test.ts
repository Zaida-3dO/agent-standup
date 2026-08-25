// How an undoable action reads to a person — T18.
//
// Prose, but load-bearing prose: this is the whole content of the toast,
// and the mistakes it can make (a raw `in_review`, "1 items") are the ones
// a person sees on the most common paths.
import { describe, expect, it } from "vitest";
import { describeAction, itemCount, stateLabel, type UndoableAction } from "@/lib/undo";

describe("stateLabel", () => {
  it("turns a state id into something sayable", () => {
    expect(stateLabel("in_review")).toBe("in review");
    expect(stateLabel("plan_review")).toBe("plan review");
  });

  it("separates every underscore, not just the first", () => {
    // A non-global replace passes on every real two-word state, so the
    // property needs a fixture with two separators to be tested at all.
    expect(stateLabel("a_b_c")).toBe("a b c");
  });

  it("leaves a single-word state alone", () => {
    expect(stateLabel("executing")).toBe("executing");
  });
});

describe("itemCount", () => {
  it("agrees with its noun", () => {
    // The singular is the path a bulk feature is most often first tried
    // on, and "1 items" is what a plain template literal produces.
    expect(itemCount(1)).toBe("1 item");
    expect(itemCount(3)).toBe("3 items");
    expect(itemCount(0)).toBe("0 items");
  });
});

describe("describeAction", () => {
  it("names the item and where it went, for a state change", () => {
    const action: UndoableAction = {
      kind: "state-change",
      at: 0,
      move: { itemId: "item-1", from: "executing", to: "in_review" },
      itemTitle: "Wire the thing",
    };
    // Reports where it went (`to`), not where it came from — the opposite
    // would be a plausible-looking sentence describing the wrong end.
    expect(describeAction(action)).toBe("Moved “Wire the thing” to in review.");
  });

  it("counts the items and names the target, for a bulk move", () => {
    const action: UndoableAction = {
      kind: "bulk",
      at: 0,
      to: "merged",
      moves: [
        { itemId: "a", from: "executing", to: "merged" },
        { itemId: "b", from: "on_deck", to: "merged" },
      ],
    };
    expect(describeAction(action)).toBe("Moved 2 items to merged.");
  });

  it("names the item, for an archive", () => {
    const action: UndoableAction = {
      kind: "archive",
      at: 0,
      itemId: "item-1",
      itemTitle: "A duplicate",
    };
    expect(describeAction(action)).toBe("Archived “A duplicate”.");
  });
});
