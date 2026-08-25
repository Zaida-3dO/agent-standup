// The palette's selection movement and its own key handling —
// `@/lib/palette/state`.
//
// This is the behaviour `cmdk` would have owned. It is kept as pure
// functions precisely so it can be tested directly: a keyboard-only person
// depends on it more than on anything else in the piece, and a rendered
// third-party component in a DOM-free harness could not be exercised at all.
import { describe, expect, it } from "vitest";
import {
  FIRST_INDEX,
  decidePaletteKey,
  movedSelection,
  selectedCommand,
} from "@/lib/palette/state";
import type { Command } from "@/lib/palette/commands";

const commands: readonly Command[] = [
  { id: "a", label: "A", group: "Actions", intent: { kind: "create" } },
  { id: "b", label: "B", group: "Actions", intent: { kind: "help" } },
  { id: "c", label: "C", group: "Actions", intent: { kind: "navigate", href: "/x" } },
];

describe("movedSelection", () => {
  it("steps forward and backward within the list", () => {
    expect(movedSelection(3, 0, 1)).toBe(1);
    expect(movedSelection(3, 2, -1)).toBe(1);
  });

  it("wraps past the end to the start", () => {
    // Stopping at the end means a person holding the down key silently
    // stops making progress and has to work out why.
    expect(movedSelection(3, 2, 1)).toBe(0);
  });

  it("wraps before the start to the end", () => {
    // The direction a naive `%` gets wrong: -1 % 3 is -1 in JavaScript, so
    // an implementation without the double-modulo would return a negative
    // index and select nothing at all.
    expect(movedSelection(3, 0, -1)).toBe(2);
  });

  it("pins an empty list at zero rather than producing NaN", () => {
    // `x % 0` is NaN. An index of NaN reads as `undefined` from the array,
    // which `selectedCommand` handles — but NaN would also survive into
    // `aria-activedescendant` and every later arithmetic.
    expect(movedSelection(0, 0, 1)).toBe(0);
    expect(movedSelection(0, 5, -1)).toBe(0);
    expect(Number.isNaN(movedSelection(0, 0, 1))).toBe(false);
  });

  it("is bounded for a delta larger than the list", () => {
    const moved = movedSelection(3, 0, 7);
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(moved).toBeLessThan(3);
  });
});

describe("selectedCommand", () => {
  it("returns the command at the index", () => {
    expect(selectedCommand(commands, 1)?.id).toBe("b");
  });

  it("returns null rather than throwing for an out-of-range index", () => {
    // Enter against an empty result set is an ordinary thing a person does
    // after typing a query that matches nothing.
    expect(selectedCommand(commands, 9)).toBeNull();
    expect(selectedCommand([], 0)).toBeNull();
  });
});

describe("FIRST_INDEX", () => {
  it("is the top of the list, which is where a re-filter resets to", () => {
    // Keeping the previous index across a re-filter would leave the highlight on
    // whatever unrelated command is now third, and the next Enter would run
    // a command the person never looked at.
    expect(FIRST_INDEX).toBe(0);
  });
});

describe("decidePaletteKey", () => {
  it("moves on the arrow keys", () => {
    expect(decidePaletteKey({ key: "ArrowDown" })).toEqual({ kind: "move", delta: 1 });
    expect(decidePaletteKey({ key: "ArrowUp" })).toEqual({ kind: "move", delta: -1 });
  });

  it("moves on Ctrl+n and Ctrl+p, for a person who lives in a terminal", () => {
    expect(decidePaletteKey({ key: "n", ctrlKey: true })).toEqual({ kind: "move", delta: 1 });
    expect(decidePaletteKey({ key: "p", ctrlKey: true })).toEqual({ kind: "move", delta: -1 });
  });

  it("runs on Enter and closes on Escape", () => {
    expect(decidePaletteKey({ key: "Enter" })).toEqual({ kind: "run" });
    expect(decidePaletteKey({ key: "Escape" })).toEqual({ kind: "close" });
  });

  it("passes bare letters through, so the query box stays typeable", () => {
    // `j`, `k`, `n` and `p` are all letters someone will type into a search
    // box. Claiming them here would make "jk" unsearchable.
    for (const key of ["j", "k", "n", "p", "a"]) {
      expect(decidePaletteKey({ key })).toEqual({ kind: "pass" });
    }
  });

  it("passes Tab through, because trapping belongs to every overlay", () => {
    // The palette does not claim Tab: the shared trap handler does. A
    // `close` or `move` here would break the focus cycle.
    expect(decidePaletteKey({ key: "Tab" })).toEqual({ kind: "pass" });
  });
});
