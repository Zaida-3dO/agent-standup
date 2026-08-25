// The *visual* half of a pointer drag — MILESTONES.md T6-A.
//
// Every decision the drag overlay makes is a plain function over plain data
// here, for exactly the reason `drag.ts` and `drag-state.ts` are: this
// repo's harness runs `environment: "node"` with no DOM, so a transform
// string, a placeholder's position and a reduced-motion collapse are only
// directly provable as functions. The components that use these are thin
// wiring over them.
//
// **This module knows nothing about `dnd-kit`.** It takes numbers and
// booleans and returns numbers, strings and booleans, so the library could
// be replaced without rewriting a single one of these rules — and, more to
// the point, so the rules can be tested without mounting the library.
import { acceptsDrop } from "./drag";
import type { BoardColumnId } from "./types";

/**
 * The motion budget (from the row's brief): `75/150/250/400ms`, `ease-out`
 * on enter and `ease-in-out` on move.
 *
 * Exported as data rather than written into the stylesheet as literals so
 * the durations a test asserts on are the same ones the CSS variables are
 * generated from — a stylesheet literal and a test literal agreeing is a
 * coincidence that survives one of them changing.
 */
export const MOTION_MS = {
  /** A state flip that should read as instant — the placeholder appearing. */
  instant: 75,
  /** Enter/exit of a small element. */
  quick: 150,
  /** The drop settle. */
  settle: 250,
  /** The longest move the board makes. */
  slow: 400,
} as const;

/** The tilt, in degrees, a lifted card carries. Small on purpose — a big angle reads as broken, not lifted. */
export const DRAG_TILT_DEG = 2;

/** How much a lifted card grows. Enough to read as "above the board", not enough to misjudge where it lands. */
export const DRAG_LIFT_SCALE = 1.03;

/**
 * The `transform` for the card that follows the cursor.
 *
 * **Reduced motion keeps the translation and drops everything else.** This
 * is the one place the usual "collapse it all to opacity" rule has to be
 * read carefully: the translation is not decoration, it is the entire
 * information content of a drag — a card that does not follow the cursor is
 * the defect this row exists to fix. What `prefers-reduced-motion` asks to
 * remove is *gratuitous* motion, so the tilt and the scale go (they convey
 * nothing the position does not) and the following stays.
 */
export function dragTransform(x: number, y: number, reducedMotion: boolean): string {
  const translate = `translate3d(${x}px, ${y}px, 0)`;
  if (reducedMotion) return translate;
  return `${translate} rotate(${DRAG_TILT_DEG}deg) scale(${DRAG_LIFT_SCALE})`;
}

/**
 * Whether a column should register as a drop target for the pointer drag.
 *
 * Delegates to `acceptsDrop` rather than restating the rule, so Waiting
 * stays undroppable for the one reason `TARGET_STATE` gives (both its
 * states need fields a drag has not got) and the two transports cannot
 * drift apart about which columns accept a drop.
 */
export function isDropZone(column: BoardColumnId): boolean {
  return acceptsDrop(column);
}

/**
 * Where the drop placeholder should be shown, or `null` for nowhere.
 *
 * The placeholder is a promise that letting go here will do something, so
 * it appears only where a drop would actually be a move:
 *
 *   - nothing is being dragged → nowhere;
 *   - the pointer is over no column → nowhere;
 *   - the column refuses drops (Waiting) → nowhere, rather than a
 *     placeholder that lies;
 *   - the card is already in that column → nowhere, because dropping it
 *     back where it came from is a no-op (`isMove`'s third condition), and
 *     showing a landing site for a move that will not happen is the same
 *     wrong promise as highlighting Waiting.
 */
export function placeholderColumn(
  draggingItemId: string | null,
  overColumn: BoardColumnId | null,
  sourceColumn: BoardColumnId | null,
): BoardColumnId | null {
  if (draggingItemId === null) return null;
  if (overColumn === null) return null;
  if (!isDropZone(overColumn)) return null;
  if (sourceColumn === overColumn) return null;
  return overColumn;
}
