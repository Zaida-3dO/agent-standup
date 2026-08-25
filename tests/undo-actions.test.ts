// The undo derivation — T18's fourth piece.
//
// This is the file that has to be able to tell a correct inverse from a
// plausible-looking wrong one. The failure mode being guarded against is
// specific: an inverse that swaps the wrong pair of fields still produces a
// well-formed `UndoStep` with the right item id and two real states, and a
// test that only checked "a step was produced for item a" would pass on it
// while the undo moved items to the state they had just left.
//
// So the assertions below are on `to` and `expectedFrom` **individually and
// asymmetrically** — `from` and `to` are always different values in the
// fixtures, so transposing them fails — and there is an explicit test that
// the two are not equal to each other.
import { describe, expect, it } from "vitest";
import {
  UNDO_WINDOW_MS,
  canUndo,
  inverseOf,
  isWithinWindow,
  remainingMs,
  type UndoStep,
  type UndoTransitionStep,
  type UndoableAction,
} from "@/lib/undo";

/**
 * Narrows a step to the transition arm, failing the test if it is not one.
 *
 * Needed because `UndoStep` became a discriminated union when archive gained
 * a real inverse: a restore step carries no `to` and no `expectedFrom`, so
 * the assertions below cannot reach those fields without first establishing
 * which kind they have.
 *
 * It **strengthens** the assertions rather than working around the type. The
 * checks below were already asserting the right things; each one now also
 * asserts that the step is a transition at all, so an `inverseOf` that
 * started returning a restore step for a state change — which would type-check
 * and would produce a step with the right item id — fails here instead of
 * silently satisfying an `itemId` assertion.
 */
function asTransition(step: UndoStep): UndoTransitionStep {
  expect(step.kind).toBe("transition");
  if (step.kind !== "transition") throw new Error("expected a transition step");
  return step;
}

/** A move with `from` and `to` deliberately distinct, so a transposition is visible. */
const aMove = { itemId: "item-1", from: "executing", to: "in_review" } as const;

const aStateChange: UndoableAction = {
  kind: "state-change",
  at: 1_000,
  move: aMove,
  itemTitle: "Wire the thing",
};

describe("inverseOf — state change", () => {
  it("sends the item back to where it came from", () => {
    const plan = inverseOf(aStateChange);
    expect(plan.available).toBe(true);
    if (!plan.available) return;
    expect(plan.steps).toHaveLength(1);
    // The whole correctness claim, asserted as two separate facts rather
    // than one object match: `to` must be the ORIGINAL `from`.
    expect(asTransition(plan.steps[0]!).to).toBe("executing");
    // ...and the precondition must be where the action LEFT it.
    expect(asTransition(plan.steps[0]!).expectedFrom).toBe("in_review");
    expect(plan.steps[0]!.itemId).toBe("item-1");
  });

  it("does not confuse the two ends of the move", () => {
    // Guards the transposition directly: if `inverseOf` swapped these, the
    // step would still be well-formed and the assertions above would be
    // the only thing catching it. This states the property itself.
    const plan = inverseOf(aStateChange);
    if (!plan.available) throw new Error("expected an available plan");
    const step = asTransition(plan.steps[0]!);
    expect(step.to).not.toBe(step.expectedFrom);
    expect(step.to).toBe(aMove.from);
    expect(step.expectedFrom).toBe(aMove.to);
  });

  it("refuses a move that changed nothing", () => {
    // A drop onto the column an item already occupies. Undoing it would
    // write a second identical state-change event, making history narrate
    // a move nobody made.
    const plan = inverseOf({
      ...aStateChange,
      move: { itemId: "item-1", from: "executing", to: "executing" },
    });
    expect(plan.available).toBe(false);
    if (plan.available) return;
    expect(plan.reason).toBe("That did not change anything.");
  });
});

describe("inverseOf — bulk", () => {
  const aBulk: UndoableAction = {
    kind: "bulk",
    at: 1_000,
    to: "in_review",
    moves: [
      { itemId: "item-1", from: "executing", to: "in_review" },
      { itemId: "item-2", from: "on_deck", to: "in_review" },
      { itemId: "item-3", from: "planning", to: "in_review" },
    ],
  };

  it("gives every item its OWN origin state back", () => {
    // The property that matters most for bulk: a selection spans columns,
    // so a single remembered `from` would be right for at most one item.
    // Asserting the whole mapping catches an implementation that reused
    // the first move's `from` for all of them.
    const plan = inverseOf(aBulk);
    if (!plan.available) throw new Error("expected an available plan");
    expect(plan.steps.map((step) => [step.itemId, asTransition(step).to])).toEqual([
      ["item-1", "executing"],
      ["item-2", "on_deck"],
      ["item-3", "planning"],
    ]);
  });

  it("preconditions every step on the state the bulk drove them to", () => {
    const plan = inverseOf(aBulk);
    if (!plan.available) throw new Error("expected an available plan");
    expect(plan.steps.map((step) => asTransition(step).expectedFrom)).toEqual([
      "in_review",
      "in_review",
      "in_review",
    ]);
  });

  it("skips the items the bulk did not actually move", () => {
    const plan = inverseOf({
      ...aBulk,
      moves: [
        { itemId: "item-1", from: "executing", to: "in_review" },
        // Already there — the bulk changed nothing for this one.
        { itemId: "item-2", from: "in_review", to: "in_review" },
      ],
    });
    if (!plan.available) throw new Error("expected an available plan");
    expect(plan.steps.map((step) => step.itemId)).toEqual(["item-1"]);
  });

  it("is unavailable when the bulk moved nothing at all", () => {
    const plan = inverseOf({
      ...aBulk,
      moves: [{ itemId: "item-2", from: "in_review", to: "in_review" }],
    });
    expect(plan.available).toBe(false);
  });
});

describe("inverseOf — archive", () => {
  // Archive had no inverse when this file was written: nothing in the
  // service cleared `archivedAt`, so the honest plan was an unavailable one
  // and the toast showed no button. `restore_item` closed that gap, and
  // these assert the inverse it now has.
  const anArchive: UndoableAction = {
    kind: "archive",
    at: 1_000,
    itemId: "item-1",
    itemTitle: "A duplicate",
  };

  it("is available, and restores the item", () => {
    const plan = inverseOf(anArchive);
    expect(plan.available).toBe(true);
    if (!plan.available) return;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.itemId).toBe("item-1");
  });

  it("is a restore, NOT a transition", () => {
    // The distinction this test exists for. A restore puts the row back in
    // whatever state it already held, so an implementation that modelled it
    // as a transition would have to invent a target state and would MOVE an
    // item the person only wanted un-hidden. Asserting the discriminant
    // catches that directly; asserting only `itemId` above would not.
    const plan = inverseOf(anArchive);
    if (!plan.available) throw new Error("expected an available plan");
    const step = plan.steps[0]!;
    expect(step.kind).toBe("restore");
    // And it carries no state fields at all — a restore has nothing for an
    // `expectedFrom` to guard, so their absence is part of the claim.
    expect(step).not.toHaveProperty("to");
    expect(step).not.toHaveProperty("expectedFrom");
  });
});

describe("the window", () => {
  it("is the ten seconds the row asks for", () => {
    // Stated as a literal, deliberately. Every other assertion in this
    // file is written relative to `UNDO_WINDOW_MS`, which makes them
    // correct about the *behaviour* and blind to the constant itself —
    // changing it to thirty seconds keeps them all green. This is the one
    // test that pins the number, because "~10s" is the row's requirement
    // and a window silently widened to half a minute is a different
    // feature: the premise an undo rests on (the item is still where you
    // left it) decays with every second it stays offered.
    expect(UNDO_WINDOW_MS).toBe(10_000);
  });

  it("is open before it elapses and shut on the tick it does", () => {
    // The boundary asserted from both sides at once — a test that only
    // checked a mid-window moment would pass on `<=` as readily as `<`.
    expect(isWithinWindow(aStateChange, 1_000 + UNDO_WINDOW_MS - 1)).toBe(true);
    expect(isWithinWindow(aStateChange, 1_000 + UNDO_WINDOW_MS)).toBe(false);
  });

  it("counts down and floors at zero", () => {
    expect(remainingMs(aStateChange, 1_000)).toBe(UNDO_WINDOW_MS);
    expect(remainingMs(aStateChange, 1_000 + 4_000)).toBe(UNDO_WINDOW_MS - 4_000);
    // Past the end it is zero, not negative — the caller renders it
    // without re-checking the sign.
    expect(remainingMs(aStateChange, 1_000 + UNDO_WINDOW_MS + 5_000)).toBe(0);
  });

  it("treats a backwards clock as still open rather than instantly expired", () => {
    expect(isWithinWindow(aStateChange, 0)).toBe(true);
  });
});

describe("canUndo", () => {
  it("requires BOTH a live window and an available inverse", () => {
    // Each condition is falsified on its own, so an implementation that
    // checked only one of them fails here. This is the test that stops a
    // button being shown when pressing it cannot work.
    const inWindow = 1_000;
    const expired = 1_000 + UNDO_WINDOW_MS;
    // A no-op move, which is the remaining action with no inverse now that
    // archive has one. It has to be an action `inverseOf` genuinely refuses,
    // or the "no inverse" half of this test asserts nothing — an archive
    // here would now be available and would make the third expectation pass
    // for the wrong reason.
    const noOp: UndoableAction = {
      kind: "state-change",
      at: 1_000,
      move: { itemId: "item-1", from: "executing", to: "executing" },
      itemTitle: "Went nowhere",
    };

    expect(canUndo(aStateChange, inWindow)).toBe(true);
    // Window shut, inverse fine.
    expect(canUndo(aStateChange, expired)).toBe(false);
    // Window open, no inverse.
    expect(canUndo(noOp, inWindow)).toBe(false);
    // Neither.
    expect(canUndo(noOp, expired)).toBe(false);
  });
});
