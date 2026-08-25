// The drag interaction's state machine — MILESTONES.md #73.
//
// A reducer over plain data rather than a handful of `useState` calls in
// the container, for the reason this repo splits every display decision out
// of its components: with `environment: "node"` and no DOM, a reducer can
// be driven through a whole drag — pick up, drop, optimistic move, server
// refusal, revert — as a sequence of function calls, and every intermediate
// board inspected. The same sequence expressed as `setState` calls inside
// an event handler is only reachable through a renderer this harness does
// not install.
//
// **The ordering guarantee this exists to provide.** A refusal arrives
// after the request that caused it, by which time the person may have
// dragged the same card again. Reverting blindly to the entry captured at
// the first drop would then undo the *second* move as well. So every move
// carries a sequence number, and a result is applied only if it is still
// the newest one — see `isStale`.
import type { Board, BoardColumnId, BoardEntry } from "./types";
import { applyOptimisticMove, findEntry, isMove, revertMove, reconcile } from "./drag";

export interface DragState {
  /** The board to render — optimistically moved, possibly ahead of the server. */
  readonly board: Board;
  /** The item being dragged right now, or `null`. */
  readonly draggingItemId: string | null;
  /** The column a dragged card is over, or `null`. */
  readonly overColumn: BoardColumnId | null;
  /** The item whose move is in flight, or `null`. */
  readonly pendingItemId: string | null;
  /** Why the last move was refused, or `null`. */
  readonly refusal: string | null;
  /**
   * The entry as it was before the in-flight move, kept so a refusal can put
   * it back exactly — including the `state` the optimistic move overwrote.
   */
  readonly pendingOriginal: BoardEntry | null;
  /** Increments on every move begun. A result naming an older number is stale — see `isStale`. */
  readonly sequence: number;
}

export function initialDragState(board: Board): DragState {
  return {
    board,
    draggingItemId: null,
    overColumn: null,
    pendingItemId: null,
    refusal: null,
    pendingOriginal: null,
    sequence: 0,
  };
}

/** The board changed underneath (a reload) — keep the interaction, replace the data. */
export function boardReplaced(state: DragState, board: Board): DragState {
  return { ...state, board };
}

export function dragStarted(state: DragState, itemId: string): DragState {
  return { ...state, draggingItemId: itemId, refusal: null };
}

export function dragEnded(state: DragState): DragState {
  return { ...state, draggingItemId: null, overColumn: null };
}

export function draggedOver(state: DragState, column: BoardColumnId): DragState {
  return { ...state, overColumn: column };
}

export function refusalDismissed(state: DragState): DragState {
  return { ...state, refusal: null };
}

/** What `dropped` reports back: the new state, and the move to send if there is one. */
export interface DropOutcome {
  readonly state: DragState;
  /**
   * The request to make, or `null` when the drop was not a move at all — a
   * card dropped on its own column, a project, or a drop with nothing being
   * dragged. `null` means "do not call the server", and issuing a request
   * anyway would write a state-change event recording that nothing happened.
   */
  readonly request: {
    readonly itemId: string;
    readonly column: BoardColumnId;
    readonly sequence: number;
  } | null;
}

/**
 * A card dropped on a column: move it in local state **immediately** — the
 * whole of "the move showing immediately" — and report the request the
 * caller should now make.
 *
 * The move is applied before the request is made, not after it succeeds.
 * That is the point of the row, and it is why every refusal path has to put
 * it back.
 */
export function dropped(state: DragState, column: BoardColumnId): DropOutcome {
  const itemId = state.draggingItemId;
  if (itemId === null) return { state: dragEnded(state), request: null };

  const original = findEntry(state.board, itemId);
  if (original === null || !isMove(original, column)) {
    return { state: dragEnded(state), request: null };
  }

  const sequence = state.sequence + 1;
  return {
    state: {
      ...state,
      board: applyOptimisticMove(state.board, itemId, column),
      draggingItemId: null,
      overColumn: null,
      pendingItemId: itemId,
      pendingOriginal: original,
      refusal: null,
      sequence,
    },
    request: { itemId, column, sequence },
  };
}

/**
 * Whether a result that arrived belongs to a move that has since been
 * superseded.
 *
 * Two moves of the same card in quick succession are the case that matters:
 * the first request's answer can land after the second has already been
 * applied optimistically. Acting on it — settling *or* reverting — would
 * clobber the newer move with an older answer, and reverting would put the
 * card somewhere the person has since dragged it away from.
 */
export function isStale(state: DragState, sequence: number): boolean {
  return sequence !== state.sequence;
}

/** The server accepted the move: settle on the entry it returned, which may differ from the guess. */
export function moveSettled(state: DragState, sequence: number, entry: BoardEntry): DragState {
  if (isStale(state, sequence)) return state;
  return {
    ...state,
    board: reconcile(state.board, entry),
    pendingItemId: null,
    pendingOriginal: null,
  };
}

/**
 * The server refused: put the card back exactly where it was, and say why.
 *
 * Both halves are required. A revert with no message is the failure this
 * row has to avoid — a card that visibly moves and springs back, which
 * reads as the interface being broken rather than as the server having an
 * opinion.
 */
export function moveRefused(state: DragState, sequence: number, message: string): DragState {
  if (isStale(state, sequence)) return state;
  const original = state.pendingOriginal;
  return {
    ...state,
    board: original === null ? state.board : revertMove(state.board, original),
    pendingItemId: null,
    pendingOriginal: null,
    refusal: message,
  };
}

/**
 * The server refused because **someone else moved the item first** — T17's
 * conflict case, and the one refusal that must not revert.
 *
 * **Why this is not `moveRefused` with a nicer sentence.** An ordinary
 * refusal means the move did not happen, so the card belongs exactly where it
 * was and `revertMove` puts it back. A conflict means the item *did* move —
 * by someone else, to a state this client did not ask for — so putting the
 * card back where this client last saw it would show a position that is also
 * wrong, and would show it confidently. The card is instead settled on the
 * state the server reported in the 409's `details.currentState`, which is the
 * newest fact anyone here has.
 *
 * **The column is recomputed from that state by the caller**, not guessed
 * here: the state-to-column mapping lives in the service layer and this
 * module cannot import it (`npm run check:db-imports`), so the caller passes
 * the settled entry. When it cannot build one — the item is not on this
 * board, or its new state maps to a column the board does not show — `entry`
 * is `null` and the card is simply left where the optimistic move put it,
 * with the message explaining why; the live feed's own refetch is what
 * corrects it a moment later. That is a brief inconsistency rather than a
 * confident wrong answer.
 *
 * Staleness is checked exactly as the other two results check it: a conflict
 * answering an older move must not clobber a newer one.
 */
export function moveConflicted(
  state: DragState,
  sequence: number,
  message: string,
  entry: BoardEntry | null,
): DragState {
  if (isStale(state, sequence)) return state;
  return {
    ...state,
    board: entry === null ? state.board : reconcile(state.board, entry),
    pendingItemId: null,
    pendingOriginal: null,
    refusal: message,
  };
}
