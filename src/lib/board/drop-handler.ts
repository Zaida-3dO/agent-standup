// The glue between the drag reducer and React — MILESTONES.md #73.
//
// **This module exists because the glue is where the bug was.** The
// reducers in `drag-state.ts` and the request in `move.ts` were each
// thoroughly tested, and the single line joining them to React was not —
// which is exactly where a defect lived: reading the request out of a
// `setState` updater, on the assumption that React evaluates updaters
// eagerly. It does not, except when no update is already pending on the
// fiber, and on the board there always is one (the mount-time load alone
// leaves a lane). So the request came back `null` and no transition was
// ever sent: the card moved and the move quietly vanished — the precise
// failure this row exists to prevent, arrived at from the other side.
//
// Extracting it here makes that seam a plain function with its
// dependencies injected, so a test can drive a whole drop — optimistic
// move, request issued, result applied — with no DOM and no renderer, and
// assert the thing that actually broke: **that a request was sent at all.**
import type { BoardColumnId } from "./types";
import { dropped, moveRefused, moveSettled, type DragState } from "./drag-state";
import type { MoveResult } from "./move";

/** Everything the drop needs from its host, so none of it is reached for globally. */
export interface DropDeps {
  /**
   * The latest state, read **synchronously**. Never a `setState` updater's
   * argument — see this module's header for why that is the whole point.
   */
  readonly read: () => DragState;
  /** Applies a new state. Also expected to keep whatever `read` returns in step. */
  readonly write: (next: DragState) => void;
  /** Schedules a state update against the newest state — the async results use this. */
  readonly update: (fn: (current: DragState) => DragState) => void;
  /** Asks the server to move the item. */
  readonly move: (itemId: string, column: BoardColumnId) => Promise<MoveResult>;
}

/**
 * Handle a card dropped on a column.
 *
 * Returns the promise for the request it issued, or `null` when the drop
 * was not a move. The promise is returned rather than swallowed so a test
 * can await the settle/revert without timing games; the component ignores
 * it deliberately.
 */
export function handleDrop(deps: DropDeps, column: BoardColumnId): Promise<void> | null {
  const outcome = dropped(deps.read(), column);
  // Written before the request is issued: the optimistic move is what
  // "showing immediately" means, and it must be in place even if the
  // request throws on its very first tick.
  deps.write(outcome.state);
  if (outcome.request === null) return null;

  const { itemId, column: target, sequence } = outcome.request;
  return deps.move(itemId, target).then((result) => {
    deps.update((current) =>
      result.ok
        ? moveSettled(current, sequence, result.entry)
        : moveRefused(current, sequence, result.message),
    );
  });
}
