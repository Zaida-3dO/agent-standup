// The keyboard drag's step size — the pure half of `DragLayer.tsx`'s
// keyboard sensor.
//
// **Why this is a module and not a number inlined in the component.** The
// same reason `drag-visual.ts` gives: this repo's harness runs
// `environment: "node"` with no DOM, so a coordinate rule is only directly
// provable as a function over plain numbers. A `coordinateGetter` passed
// straight to `KeyboardSensor` would be reachable only by mounting
// `dnd-kit`, which nothing in this suite does.
//
// **The defect this fixes.** `DragLayer` registered `useSensor(
// KeyboardSensor)` with no `coordinateGetter`, so it used the library's
// default — a flat 25px per arrow press, in a layout whose columns are
// several hundred pixels wide. Crossing one column took about twelve
// presses, and crossing the board took about fifty. A keyboard path that
// technically works but costs twelve presses per column is one a keyboard
// user does not use.
//
// **A column-sized step, not a bigger pixel step.** The board is a grid of
// four equal columns (`Board.module.css`: `repeat(4, minmax(0, 1fr))`), so
// the unit a reader is actually moving in is "one column" — a horizontal
// press should land on the next column regardless of how wide the viewport
// has made it. That is why the step is derived from the measured column
// width rather than being a larger constant: a constant that crosses a
// column on a 1440px screen would overshoot two of them on a 2560px one.
import { BOARD_COLUMNS, type BoardColumnId } from "./types";

/**
 * The vertical step, in pixels, for an up/down press during a drag.
 *
 * Vertical movement does not change the drop target — the columns are side
 * by side, so which column is under the card is a question about `x` alone.
 * Up/down only scrolls the card within a column, so it keeps a modest step
 * that a reader can aim with. This is the library's default, restated here
 * so both axes are decided in one place rather than one being explicit and
 * the other being inherited silently.
 */
export const VERTICAL_STEP_PX = 25;

/**
 * How many arrow presses it takes to cross `distance` at a given step.
 *
 * Exists so the claim "a press crosses a column" is a number a test can
 * assert rather than a property of a stylesheet nobody measures. The
 * ceiling is deliberate: a step that covers 99% of a column still needs a
 * second press to actually leave it.
 */
export function pressesToCross(distance: number, step: number): number {
  if (step <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(distance / step);
}

/**
 * The horizontal step for a left/right press: one column plus the grid gap.
 *
 * Taking the width of the *dragged card's* column as the unit — every
 * column is `1fr` of the same grid, so they are equal by construction and
 * any one of them measures the pitch. The gap is added because the pitch
 * from one column's left edge to the next is the column plus the space
 * between them; stepping by the column width alone lands slightly short
 * each time and accumulates into a missed column by the fourth press.
 *
 * `fallback` is used when the layout cannot be measured — before first
 * paint, or in a test with no DOM. It is a whole column's worth at a
 * typical width rather than the library's 25px, so the degraded case is
 * still usable rather than silently reverting to the defect.
 */
export function horizontalStep(columnWidth: number, gap: number, fallback = 300): number {
  if (!Number.isFinite(columnWidth) || columnWidth <= 0) return fallback;
  return columnWidth + (Number.isFinite(gap) && gap > 0 ? gap : 0);
}

/**
 * The column a horizontal press should move to, or `null` when the press
 * would leave the board.
 *
 * Clamping rather than wrapping: at the last column, a right press does
 * nothing and the announcement stays put. Wrapping round to the first
 * column would move the card three columns in the direction opposite to
 * the one the reader pressed, which is the kind of surprise that is much
 * worse than a press that does nothing.
 */
export function nextColumn(from: BoardColumnId, direction: -1 | 1): BoardColumnId | null {
  const index = BOARD_COLUMNS.indexOf(from);
  if (index === -1) return null;
  const target = index + direction;
  if (target < 0 || target >= BOARD_COLUMNS.length) return null;
  return BOARD_COLUMNS[target] ?? null;
}
