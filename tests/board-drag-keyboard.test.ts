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
//   - Any handler in `SILENT_ANNOUNCEMENTS` returning a string fails the
//     announcer test — that is the whole defect it exists to prevent.
//   - Deleting any one key from `SILENT_ANNOUNCEMENTS` fails the coverage
//     test: an omitted handler falls back to the library's default for
//     that event, reintroducing the UUID for one announcement only.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SILENT_ANNOUNCEMENTS,
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

  it("ignores a gap that is not a usable number", () => {
    // Both halves of the guard matter independently: a non-finite gap
    // would make the whole step `NaN`, and a negative one would pull the
    // step back under a column's width. Either way the column width alone
    // is the answer, never a corrupted sum.
    for (const badGap of [Number.NaN, Number.POSITIVE_INFINITY, -16, 0]) {
      expect(horizontalStep(300, badGap)).toBe(300);
    }
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

  it("treats a negative step as impossible too, not as progress backwards", () => {
    // `step <= 0`, not `step < 0`: a negative step divides to a negative
    // count, and `Math.ceil` of that is a number a caller would read as
    // "fewer presses than zero" rather than as impossible.
    expect(pressesToCross(300, -25)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("a horizontal press moves one column, and stops at the ends", () => {
  it("steps to the adjacent column in each direction", () => {
    expect(nextColumn("backlog", 1)).toBe("in_progress");
    expect(nextColumn("in_progress", -1)).toBe("backlog");
  });

  it("refuses a column it does not recognise", () => {
    // `indexOf` returning -1 has to be its own answer: without that guard
    // the arithmetic below would happily index from -1 and return a
    // neighbour of a column that is not on the board.
    expect(nextColumn("not_a_column" as BoardColumnId, 1)).toBeNull();
    expect(nextColumn("not_a_column" as BoardColumnId, -1)).toBeNull();
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
// The silent announcements are asserted by IMPORTING them and calling
// them, not by reading the component's source. That matters for more than
// tidiness: a source-text assertion reads whatever file is on disk, and
// under a mutation run that is an INSTRUMENTED copy of the component —
// so the regex stops matching and the test fails for a reason that has
// nothing to do with the mutant. Calling the real object tests the
// behaviour and is indifferent to how the file is spelled.
//
// They live in `@/lib/board/drag-keyboard` for exactly this reason: the
// component is a `"use client"` file built on hooks that this DOM-free
// harness cannot import, and a plain object can be.
describe("the silent announcer says nothing at all", () => {
  it("returns undefined from every handler dnd-kit calls", () => {
    // `undefined` is the library's supported "say nothing": its `announce`
    // ignores a nullish value, so its own live region stays empty. Any
    // handler returning a string would fill that region instead — and
    // that region is `assertive`, so it would interrupt this board's
    // polite one mid-sentence.
    const active = { id: "4f8ac10b-58cc-4372-a567-0e02b2c3d479", data: { current: {} }, rect: {} };
    const over = { id: "in_progress", rect: {}, data: { current: {} }, disabled: false };
    const args = { active, over } as never;
    for (const [name, handler] of Object.entries(SILENT_ANNOUNCEMENTS)) {
      const spoken = (handler as (a: never) => string | undefined)(args);
      expect(spoken, `${name} must say nothing`).toBeUndefined();
    }
  });

  it("covers every announcement dnd-kit can make", () => {
    // A handler the library calls but this object omits falls back to the
    // library's default for THAT event — which is the UUID-reading,
    // interrupting behaviour, reintroduced for one event only. Deleting
    // any single key here fails this.
    expect(Object.keys(SILENT_ANNOUNCEMENTS).sort()).toEqual([
      "onDragCancel",
      "onDragEnd",
      "onDragMove",
      "onDragOver",
      "onDragStart",
    ]);
  });

  it("says nothing even when handed a real-looking id", () => {
    // The specific defect: the library's defaults interpolate `active.id`,
    // which on this board is a UUID. Nothing here may echo it back.
    const id = "4f8ac10b-58cc-4372-a567-0e02b2c3d479";
    const args = { active: { id }, over: { id: "waiting" } } as never;
    for (const handler of Object.values(SILENT_ANNOUNCEMENTS)) {
      const spoken = (handler as (a: never) => string | undefined)(args);
      expect(spoken ?? "").not.toContain(id);
    }
  });
});

// ── The component's wiring ────────────────────────────────────────────
//
// These claims are about how `DragLayer.tsx` hands the pieces above to
// `dnd-kit` — a fact about the file rather than about any value it
// exports, so they are read from its source text. This is deliberately
// the WEAKEST check in this file: it proves the wiring is spelled
// correctly, not that a screen reader hears the right thing or that a
// press moves a column. The handoff says so and asks a browser reviewer
// to confirm both directly.
//
// **The working file is read, not the committed blob**, so an uncommitted
// edit that broke the wiring still fails here. The one situation that
// makes the text unreadable is a mutation run: Stryker executes the suite
// against an INSTRUMENTED copy of every file in its mutate scope, and a
// substring assertion against rewritten source fails for reasons that
// have nothing to do with the mutant. That case is detected and skipped
// LOUDLY rather than quietly tolerated — the behavioural tests above are
// what carry the mutation gate, and they call real values.
const DRAG_LAYER_PATH = path.resolve(import.meta.dirname, "../src/components/board/DragLayer.tsx");
const DRAG_LAYER_RAW = readFileSync(DRAG_LAYER_PATH, "utf8");

/**
 * True when the source has been rewritten by Stryker's instrumenter.
 *
 * Its instrumentation injects a global mutant-selector (`__stryker__`)
 * and wraps every expression in a switch on it, so its presence is an
 * unambiguous marker and cannot appear in the real component.
 */
const INSTRUMENTED = DRAG_LAYER_RAW.includes("__stryker__");

// Comments stripped: the file documents the defect it fixes by quoting
// the broken expression (`announcements: undefined`), so a substring
// search over the raw text would find the defect in the very comment
// explaining that it is gone.
const DRAG_LAYER = DRAG_LAYER_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ 	]*\/\/.*$/gm, "");

describe.skipIf(INSTRUMENTED)("the component wires up one announcer and a stepping sensor", () => {
  it("does NOT pass `announcements: undefined`, which selects the defaults", () => {
    // `dnd-kit` destructures with a default
    // (`announcements = defaultAnnouncements`), so a property explicitly
    // set to `undefined` takes that default exactly as an absent one does
    // — the spelling that reads most like suppression turns them on.
    expect(DRAG_LAYER).not.toContain("announcements: undefined");
  });

  it("hands the library the silent announcer", () => {
    expect(DRAG_LAYER).toContain("announcements: SILENT_ANNOUNCEMENTS");
  });

  it("keeps the app's own region polite, and it is the only one that speaks", () => {
    // The app's region says the card's title and the column's name. It
    // must stay `polite`: these are a commentary on a gesture the reader
    // is making, so they must not interrupt.
    expect(DRAG_LAYER).toContain('aria-live="polite"');
    expect(DRAG_LAYER).not.toContain('aria-live="assertive"');
  });

  it("registers the keyboard sensor WITH a coordinate getter", () => {
    // A bare `useSensor(KeyboardSensor)` is the 25px-per-press defect.
    expect(DRAG_LAYER).toContain("useSensor(KeyboardSensor, { coordinateGetter:");
    expect(DRAG_LAYER).not.toMatch(/useSensor\(KeyboardSensor\)/);
  });
});
