// How an undoable action reads to a person.
//
// Kept out of the component for the same reason the derivation is: this is
// branching prose, it is the part a reader actually sees, and in a harness
// with no DOM a plain function returning a string is directly assertable
// while the same logic inlined in JSX is only reachable by walking an
// element tree.
//
// **The toast names the thing, not the operation.** "Moved 3 items to
// review" rather than "bulk transition succeeded": the person knows they
// pressed something, and what they need confirmed is *what it did*, in the
// words they would use for it.
import type { UndoableAction } from "./actions";

/** How a state value reads in a sentence — `in_review` is not a phrase. */
export function stateLabel(state: string): string {
  return state.replace(/_/g, " ");
}

/**
 * A count with its noun agreeing — "1 item", "3 items".
 *
 * Trivial, and worth having rather than inlining, because getting it wrong
 * produces "1 items" in front of a person on the one path (a single-item
 * selection) that a bulk feature is most often demonstrated with.
 */
export function itemCount(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

/**
 * The sentence the toast leads with.
 *
 * Past tense throughout: by the time this renders the write has already
 * been accepted, so the toast is a report, not a promise. Reporting it in
 * the present ("moving…") would make an undo button ambiguous about
 * whether it cancels something in flight or reverses something done.
 */
export function describeAction(action: UndoableAction): string {
  switch (action.kind) {
    case "state-change":
      return `Moved “${action.itemTitle}” to ${stateLabel(action.move.to)}.`;
    case "bulk":
      return `Moved ${itemCount(action.moves.length)} to ${stateLabel(action.to)}.`;
    case "archive":
      return `Archived “${action.itemTitle}”.`;
  }
}
