// The keyboard drag's step size and its announcer — the two drag-layer
// defects found in the T6 visual review.
//
// `@/lib/board/drag-keyboard` is a plain module over plain numbers for the
// reason `drag-visual.ts` gives, and that is what makes the step assertable
// here: this repo's harness runs `environment: "node"` with no DOM, so a
// coordinate rule reached only through a mounted `dnd-kit` sensor could not
// be tested at all.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Returning `columnWidth` from `horizontalStep` without adding the gap
//     fails "adds the gap", the off-by-one-gap that accumulates into a
//     missed column by the fourth press.
//   - Changing the fallback to the library's 25px fails "the degraded case
//     is still usable" — the defect itself, as a number.
//   - Making `nextColumn` wrap instead of clamp fails the clamp tests.
//   - Flipping `pressesToCross`'s `Math.ceil` to `Math.floor` fails "a step
//     that nearly crosses still needs a second press".
//   - Any handler in `silentAnnouncements` returning a string fails the
//     announcer test — that is the whole defect it exists to prevent.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  VERTICAL_STEP_PX,
  horizontalStep,
  nextColumn,
  pressesToCross,
} from "@/lib/board/drag-keyboard";
import { BOARD_COLUMNS, type BoardColumnId } from "@/lib/board/types";

describe("the horizontal step is a column, not a pixel nudge", () => {
  it("crosses a column in ONE press at a realistic column width", () => {
    // The defect, stated as the number the review measured: at the
    // library's default 25px step, a ~300px column took about twelve
    // presses. One press must now clear it.
    const columnWidth = 300;
    const step = horizontalStep(columnWidth, 16);
    expect(pressesToCross(columnWidth, step)).toBe(1);
    // The library's own 25px default, as the number being improved on.
    expect(pressesToCross(columnWidth, 25)).toBe(12);
  });

  it("adds the grid gap, so four presses do not fall a column short", () => {
    // The pitch from one column's left edge to the next is the column plus
    // the gap. Stepping by the width alone lands slightly short each time,
    // and the error accumulates across the board's four columns.
    expect(horizontalStep(300, 16)).toBe(316);
    expect(horizontalStep(300, 0)).toBe(300);
  });

  it("scales with the viewport rather than assuming one", () => {
    // A constant big enough to cross a column on a 1440px screen would
    // overshoot two of them on a 2560px one. The step is measured, so a
    // wider column simply gives a wider step.
    expect(horizontalStep(600, 16)).toBeGreaterThan(horizontalStep(300, 16));
    expect(pressesToCross(600, horizontalStep(600, 16))).toBe(1);
  });

  it("falls back to a usable step when nothing can be measured", () => {
    // Before first paint there is no collision rect. The degraded case has
    // to stay usable rather than silently reverting to the 25px defect.
    for (const unmeasurable of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(horizontalStep(unmeasurable, 16)).toBe(300);
    }
    expect(horizontalStep(Number.NaN, 16)).toBeGreaterThan(25);
  });

  it("keeps a fine vertical step, because up/down does not change column", () => {
    // Which column is under the card is a question about `x` alone, so
    // vertical movement stays aimable rather than jumping a column's worth.
    expect(VERTICAL_STEP_PX).toBe(25);
    expect(VERTICAL_STEP_PX).toBeLessThan(horizontalStep(300, 16));
  });
});

describe("pressesToCross", () => {
  it("a step that nearly crosses still needs a second press", () => {
    // `Math.ceil`, not `Math.floor`: covering 99% of a column has not left
    // it. Flipping the rounding is the single change this catches.
    expect(pressesToCross(300, 299)).toBe(2);
    expect(pressesToCross(300, 300)).toBe(1);
  });

  it("reports an impossible step rather than dividing by zero", () => {
    expect(pressesToCross(300, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("a horizontal press moves one column, and stops at the ends", () => {
  it("steps to the adjacent column in each direction", () => {
    expect(nextColumn("backlog", 1)).toBe("in_progress");
    expect(nextColumn("in_progress", -1)).toBe("backlog");
  });

  it("clamps at the ends rather than wrapping around", () => {
    // Wrapping would move the card three columns in the direction opposite
    // to the one the reader pressed — much worse than a press that does
    // nothing.
    expect(nextColumn(BOARD_COLUMNS[0]!, -1)).toBeNull();
    expect(nextColumn(BOARD_COLUMNS[BOARD_COLUMNS.length - 1]!, 1)).toBeNull();
  });

  it("walks the whole board in exactly one press per column", () => {
    // The end-to-end claim: crossing the board costs three presses, not
    // the fifty the default step cost.
    // Typed as the union rather than inferred from the first element,
    // which TypeScript narrows to that one literal.
    let column: BoardColumnId = BOARD_COLUMNS[0]!;
    let presses = 0;
    // **Bounded, not `while (true)`.** A `nextColumn` that wrapped instead
    // of clamping never returns `null`, so an unbounded walk would HANG
    // rather than fail — and a test that hangs on a mutation reports it as
    // a timeout somewhere else, or as nothing at all under a runner that
    // gives up quietly. The bound turns that same mutation into an
    // assertion failure on the next line.
    const limit = BOARD_COLUMNS.length * 2;
    while (presses < limit) {
      const next = nextColumn(column, 1);
      if (next === null) break;
      column = next;
      presses += 1;
    }
    expect(presses).toBeLessThan(limit);
    expect(presses).toBe(BOARD_COLUMNS.length - 1);
    expect(column).toBe(BOARD_COLUMNS[BOARD_COLUMNS.length - 1]);
  });
});

// ── The announcer ─────────────────────────────────────────────────────
//
// Read from the SOURCE TEXT rather than by mounting the component. The
// claim is about what is handed to `dnd-kit`'s `accessibility` prop, and
// the component is a client component full of hooks that this DOM-free
// harness cannot render. Asserting on the source is weaker than asserting
// on a rendered live region, and the handoff says so and asks a browser
// reviewer to confirm what a screen reader actually hears.
const DRAG_LAYER_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/board/DragLayer.tsx"),
  "utf8",
);

/**
 * The component's CODE, with comments removed.
 *
 * Necessary rather than tidy: that file documents the defect it fixes by
 * quoting the broken expression (`announcements: undefined`), so a
 * substring search over the raw text would find the defect in the very
 * comment explaining that it is gone — and the assertion below would fail
 * on a correct file. Stripping comments is what makes these assertions
 * about the code rather than about the prose around it.
 */
const DRAG_LAYER = DRAG_LAYER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^[ \t]*\/\/.*$/gm,
  "",
);

describe("there is exactly one announcer, and it is the polite one", () => {
  it("does NOT pass `announcements: undefined`, which selects the defaults", () => {
    // The defect. `dnd-kit` destructures with a default
    // (`announcements = defaultAnnouncements`), so a property explicitly
    // set to `undefined` takes that default exactly as an absent one does.
    // The previous code read as suppression and did the opposite.
    expect(DRAG_LAYER).not.toContain("announcements: undefined");
  });

  it("hands the library a silent announcer", () => {
    expect(DRAG_LAYER).toContain("announcements: silentAnnouncements");
  });

  it("every silent handler returns undefined and none builds a string", () => {
    const block = /const silentAnnouncements: Announcements = \{([\s\S]*?)\n\};/.exec(DRAG_LAYER);
    expect(block).not.toBeNull();
    const body = block![1]!;
    // The library's contract declares `string | undefined`, so returning
    // `undefined` is supported rather than a trick — and `announce`
    // ignores a nullish value, leaving its region empty.
    for (const handler of [
      "onDragStart",
      "onDragMove",
      "onDragOver",
      "onDragEnd",
      "onDragCancel",
    ]) {
      expect(body).toContain(`${handler}: () => undefined`);
    }
    // Nothing in there may interpolate an id. A handler that returned a
    // string would speak over the polite region again, which is the
    // interruption this fixes.
    expect(body).not.toContain("active.id");
    expect(body).not.toContain("`");
  });

  it("keeps the app's own region polite, and it is the only one that speaks", () => {
    // The app's region says the card's title and the column's name. It
    // must stay `polite`: these are a commentary on a gesture the reader is
    // making, so they must not interrupt.
    expect(DRAG_LAYER).toContain('aria-live="polite"');
    expect(DRAG_LAYER).not.toContain('aria-live="assertive"');
  });

  it("registers the keyboard sensor WITH a coordinate getter", () => {
    // A bare `useSensor(KeyboardSensor)` is the 25px defect. The getter is
    // what makes the sensor use the column-sized step proved above.
    expect(DRAG_LAYER).toContain("useSensor(KeyboardSensor, { coordinateGetter:");
    expect(DRAG_LAYER).not.toMatch(/useSensor\(KeyboardSensor\)/);
  });
});
