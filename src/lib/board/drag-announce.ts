// What a screen reader is told during a drag — T6-A and T6-B.
//
// A pointer drag is invisible to a screen reader: the card moves, and
// nothing is said. `BoardView` already announces a *refusal* through a
// `role="alert"`, which covers the failure path; this covers the successful
// one, and it is what makes T6-B's keyboard move usable rather than merely
// possible. Moving an item by keyboard while being told nothing about where
// it is would be a gesture performed blind.
//
// Plain functions returning plain strings, so every sentence is provable
// without a DOM or a screen reader — the components only place them in a
// live region.
import { columnTitle } from "./view";
import { acceptsDrop } from "./drag";
import type { BoardColumnId } from "./types";

/**
 * The card has been picked up.
 *
 * Names the column it started in, because the first thing a reader who
 * cannot see the board needs is where they are moving *from* — the
 * subsequent messages are all relative to it.
 */
export function pickedUpMessage(title: string, from: BoardColumnId): string {
  return `Picked up ${title}, in ${columnTitle(from)}. Use the arrow keys to choose a column, space or enter to drop, escape to cancel.`;
}

/**
 * The card is now over `column`.
 *
 * **A column that cannot take the card says so here**, rather than staying
 * silent and refusing at the drop. Waiting is the case (`TARGET_STATE`):
 * silence would read as "this is fine", and the reader would only discover
 * otherwise by pressing space and having nothing happen.
 */
export function movedOverMessage(title: string, column: BoardColumnId): string {
  if (!acceptsDrop(column)) {
    return `${columnTitle(column)} cannot accept ${title}. Items are paused or blocked from the item itself, where the reason can be given.`;
  }
  return `${title} is over ${columnTitle(column)}. Press space or enter to drop it here.`;
}

/** The card was dropped and the move has been issued. */
export function droppedMessage(title: string, column: BoardColumnId): string {
  return `Dropped ${title} in ${columnTitle(column)}.`;
}

/**
 * The drag was abandoned — escape, or a drop somewhere that is not a
 * column.
 *
 * Says the card was returned, because "cancelled" alone leaves open whether
 * anything happened to it.
 */
export function cancelledMessage(title: string, from: BoardColumnId | null): string {
  if (from === null) return `Cancelled. ${title} was not moved.`;
  return `Cancelled. ${title} is back in ${columnTitle(from)}.`;
}
