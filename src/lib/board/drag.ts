// Dragging a card between columns — MILESTONES.md #73, "with the move
// showing immediately".
//
// Everything here is a plain function over plain data, for the same reason
// `view.ts` is: this repo's harness runs `environment: "node"` with no DOM,
// so the optimistic move, the revert, and every refusal message are only
// directly testable as functions. The components are thin wiring over
// these, and the container holds the state they transform.
//
// **A column is not a state.** Four columns cover twelve states (SCHEMA.md
// §1.1), so a drop has to choose *which* state in the target column to move
// to — see `TARGET_STATE` below for which, and why the others are
// deliberately unreachable by drag.
import {
  BOARD_COLUMNS,
  type Board,
  type BoardColumnId,
  type BoardEntry,
  type BoardSection,
} from "./types";

/**
 * The state a drop on each column moves an item to, or `null` for a column
 * that cannot be a drop target at all.
 *
 * A drag carries no information beyond "this card, that column", so the
 * only reachable states are the ones whose guards require no accompanying
 * field:
 *
 *   - **`backlog` → `on_deck`.** `someday` is the other option and means
 *     something weaker; a card dragged *into* the backlog is being queued,
 *     not shelved indefinitely.
 *   - **`in_progress` → `executing`.** The other three (`planning`,
 *     `plan_review`, `in_review`) are points in a review cycle that a drag
 *     cannot express; "start working on it" is what dropping here means.
 *   - **`waiting` → nothing. Waiting is not a drop target**, and this is
 *     the one genuinely forced choice here. *Both* of its states require
 *     fields: `blocked` needs a `blocked_reason` and a `blocked_on_type`,
 *     and `paused` needs a `pause_reason` **and** a `resume_condition`
 *     (`guards/blocked-paused.ts`). There is no third state to fall back
 *     on, so every possible drop on this column would be refused —
 *     and the alternative, inventing placeholder text to satisfy the
 *     guards, would write meaningless prose into the field whose entire
 *     purpose is to say why the work stopped. A column that always refuses
 *     is worse than one that does not accept drops, because it teaches
 *     that the interface is unreliable rather than that the move needs
 *     more information. Pausing and blocking are done through the item,
 *     where the reason can be given.
 *   - **`completed` → `merged`.** The other three are outcomes rather than
 *     completions. This move *is* offered even though a guard will often
 *     refuse it, and the difference from Waiting is the reason: it is
 *     refused for a fact about the item (it has no summary yet), not for a
 *     fact about the gesture. An item that is ready to merge merges;
 *     handling the refusal for one that is not is exactly this row's job.
 *
 * The unreachable states are reached through the item's own controls. This
 * is the deliberate limit of what a gesture carrying no information can
 * mean.
 */
export const TARGET_STATE: Readonly<Record<BoardColumnId, string | null>> = {
  backlog: "on_deck",
  in_progress: "executing",
  waiting: null,
  completed: "merged",
};

/** Whether a column accepts drops at all — see `TARGET_STATE` for why Waiting does not. */
export function acceptsDrop(column: BoardColumnId): boolean {
  return TARGET_STATE[column] !== null;
}

/**
 * Whether a card can be dragged at all.
 *
 * **A project cannot.** Its column is derived from its children and it has
 * no state of its own to transition — the service refuses outright with
 * `ProjectHasNoStateError`, and DECISIONS.md §13c is explicit that the
 * answer is to move the children instead. Offering the gesture and then
 * always refusing it would teach the wrong model of the data, so the card
 * is not draggable in the first place.
 *
 * The revert path still handles a project refusal anyway (see
 * `refusalMessage`), because "not offered in the UI" and "cannot happen"
 * are different claims, and only the server can make the second one.
 */
export function isDraggable(entry: BoardEntry): boolean {
  return entry.item.kind !== "project";
}

/**
 * Whether dropping `entry` on `column` is a move at all.
 *
 * Three things make it not one: the card cannot be dragged (a project), the
 * column does not accept drops (Waiting — see `TARGET_STATE`), or the card
 * is already there. The last is a no-op rather than a transition — issuing
 * it would write a state-change event recording that nothing happened, and
 * would show a flicker for a move that did not occur.
 */
export function isMove(entry: BoardEntry, column: BoardColumnId): boolean {
  return isDraggable(entry) && acceptsDrop(column) && entry.column !== column;
}

/**
 * The board as it looks with `itemId` moved to `column` — the optimistic
 * update, which is what "the move showing immediately" means.
 *
 * The entry's own `column` is updated along with its position, because the
 * client reads `entry.column` everywhere (the convention #37's review
 * established) — moving the object between arrays without updating the
 * field would leave a card rendered in one column and describing itself as
 * being in another, and the Waiting tone would be read from the stale one.
 *
 * The item's `state` is set to the target column's state for the same
 * reason: a card's tone and its state chip are read from it, so leaving it
 * stale would show a card in Waiting still labelled `executing`. This is
 * the client's *guess*, and it is deliberately provisional: `reconcile`
 * settles the board on the server's answer, which is the truth.
 *
 * Returns the board unchanged when the move is not one.
 */
/**
 * The board with one entry removed from wherever it sits and placed in
 * `column` — the single relocation every optimistic move, revert and
 * reconcile is built from.
 *
 * **Each column's `total` moves with the card.** A count is the number
 * under the column heading (`BoardSection.total`), so a card that visibly
 * moves while the two headings keep their old numbers is #123's defect
 * reappearing one interaction later: the count and the cards disagree, and
 * the count is the half people trust. The totals are adjusted by exactly
 * the number of entries added or removed, so they stay correct against a
 * *paginated* column too — where the card that moved may be one of many the
 * page does not hold, and recomputing `total` from `entries.length` would
 * throw away everything off-page.
 */
function relocate(board: Board, itemId: string, column: BoardColumnId, entry: BoardEntry): Board {
  const next = {} as Record<BoardColumnId, BoardSection>;
  for (const id of BOARD_COLUMNS) {
    const section = board[id];
    const without = section.entries.filter((candidate) => candidate.item.id !== itemId);
    const removed = section.entries.length - without.length;
    const entries = id === column ? [...without, entry] : without;
    next[id] = {
      ...section,
      entries,
      total: section.total - removed + (id === column ? 1 : 0),
    };
  }
  return next;
}

export function applyOptimisticMove(board: Board, itemId: string, column: BoardColumnId): Board {
  const entry = findEntry(board, itemId);
  if (entry === null || !isMove(entry, column)) return board;
  const target = TARGET_STATE[column];
  // Unreachable given `isMove` above, which already refuses a column with
  // no target state — narrowed rather than asserted so a future column
  // added to `TARGET_STATE` as `null` cannot silently produce a card with
  // an undefined state.
  if (target === null) return board;

  const moved: BoardEntry = {
    ...entry,
    column,
    item: { ...entry.item, state: target },
  };

  return relocate(board, itemId, column, moved);
}

/**
 * The board with `entry` put back exactly as it was — the revert when the
 * server refuses.
 *
 * Takes the original entry rather than a column id, so the item's `state`
 * and every other field the optimistic move overwrote are restored too.
 * Reverting only the position would leave a card back in its old column
 * still carrying the state the drag guessed at, which is a subtler wrong
 * answer than not reverting at all — it looks correct.
 */
export function revertMove(board: Board, original: BoardEntry): Board {
  return relocate(board, original.item.id, original.column, original);
}

/**
 * The board with the item replaced by what the server actually returned.
 *
 * The optimistic move guessed a state from the target column; the server
 * decides. They agree in the ordinary case, but they do not have to — a
 * guard may move an item somewhere else entirely — so the settled board is
 * built from the server's item and the server's column, never from the
 * guess. Without this, a successful-but-different outcome would leave the
 * board showing the guess indefinitely, with nothing to correct it until
 * the next full reload.
 */
export function reconcile(board: Board, entry: BoardEntry): Board {
  return relocate(board, entry.item.id, entry.column, entry);
}

/** The entry for an item, wherever it sits, or `null` if the board does not hold it. */
export function findEntry(board: Board, itemId: string): BoardEntry | null {
  for (const column of BOARD_COLUMNS) {
    for (const entry of board[column].entries) {
      if (entry.item.id === itemId) return entry;
    }
  }
  return null;
}

/** A refusal, as the board reports it to the person who made the move. */
export interface DragRefusal {
  readonly itemId: string;
  readonly message: string;
}

/**
 * The message shown when a move is refused.
 *
 * **Every refusal says what happened and why**, because the failure this
 * row has to avoid is a card that visibly moves and then springs back with
 * no explanation — indistinguishable, to the person who dragged it, from
 * the interface being broken.
 *
 * The status codes are the HTTP adapter's own mapping
 * (`src/app/api/items/respond.ts`): 403 for a project, 422 for a guard
 * rejection, 404 for an item that has since gone. A message the server sent
 * is preferred over anything invented here, since a guard's own rejection
 * text names the field it wants; the fallbacks exist for the cases where
 * there is no body to read.
 */
export function refusalMessage(status: number, serverMessage: string | null): string {
  if (serverMessage !== null && serverMessage.trim() !== "") return serverMessage;
  if (status === 403) {
    return "That item's column is derived from its children, so it cannot be moved on its own. Move the children instead.";
  }
  if (status === 404) return "That item could not be found.";
  if (status === 422) return "That move was refused.";
  return `That move could not be saved (the server returned ${status}).`;
}

/** The message shown when the request never reached the server at all. */
export function networkRefusalMessage(): string {
  return "That move could not be saved — the server could not be reached.";
}
