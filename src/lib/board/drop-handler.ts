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
//
// **How far that guard reaches, precisely (#128).** The extraction moved the
// logic somewhere testable; it did not move the *wiring*. `handleDrop`'s
// caller in `Board.tsx` still has to supply a `read` that is synchronous, and
// nothing in this file can check that it does — restoring the original defect
// in the component leaves every test here passing, because the injected `read`
// in those tests is synchronous by construction. So the seam's tests prove
// this module is correct given a well-behaved host, and say nothing about
// whether the host behaves.
//
// That remaining layer is covered by `tests/board-react-wiring.test.ts`, the
// one file in the suite that mounts real React under jsdom and asserts a
// transition request actually reaches the network. Both layers are load-
// bearing: this one because it is where the logic can be exercised
// exhaustively, that one because it is where the defect actually lived.
import type { BoardColumnId, BoardEntry } from "./types";
import {
  dropped,
  isStale,
  moveConflicted,
  moveRefused,
  moveSettled,
  type DragState,
} from "./drag-state";
import { findEntry } from "./drag";
import type { MoveResult } from "./move";
import type { UndoableAction } from "@/lib/undo";
import { isItemState } from "@/lib/service/state-machine";
import { columnForState } from "@/lib/service/board/columns";
import type { ConflictDetails } from "@/lib/live/conflict";

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
  /**
   * Asks the server to move the item.
   *
   * `expectedFrom` is the precondition that turns a lost race into a 409
   * instead of a silent overwrite. It is **the server's last reported state
   * for this item**, read off the pre-move entry rather than derived from the
   * column the card was dragged out of: a guard that landed the item
   * somewhere unrequested makes those two disagree, and the column-derived
   * guess would then name a state the item was never in — which is the one
   * thing a conflict message must not do, since the whole value of the 409
   * arm is that it reports where the item *actually* is.
   *
   * Passed as `undefined` when there is no pre-move entry to read it from,
   * which is the honest value: the server treats an absent precondition as
   * "move it from wherever it sits". `dropped` returns a request only when it
   * also captured a `pendingOriginal`, so a real drop never takes that path.
   */
  readonly move: (
    itemId: string,
    column: BoardColumnId,
    expectedFrom?: string,
  ) => Promise<MoveResult>;
  /**
   * Offers the completed move back to the person, so they can undo it.
   *
   * **Called only after the server accepted**, and with the states the
   * server reported rather than the ones the drop guessed — an optimistic
   * move that was later refused must not leave an undo button that would
   * write a state the item was never in. That is why this is invoked from
   * inside the `result.ok` branch and not beside `deps.write` above.
   *
   * Optional so the seam's existing tests, and any host with no toast
   * mounted, keep working unchanged.
   */
  readonly offerUndo?: (action: UndoableAction) => void;
  /**
   * Turns a conflict into the sentence shown to the person — "Bunmi moved
   * this to In Review 12s ago" (T17).
   *
   * Injected rather than built here because the only thing that can name the
   * other actor is the live feed's recently-read events, which live in the
   * component. Optional: with no live feed mounted the fallback is
   * `result.message`, which is the 409 branch of `refusalMessage` and still
   * says the item was changed by someone else.
   */
  readonly describeConflict?: (conflict: ConflictDetails, itemId: string) => string;
}

/**
 * The entry the board should settle a conflicted card on: the card as it is,
 * relabelled with the state the server says it is actually in.
 *
 * **Built from the pre-move entry, not invented.** Everything a card draws
 * besides its state — title, kind, priority, area, assignments, the trust
 * mark, the subtask rollup — is unchanged by someone else's transition, and
 * the pre-move entry is the newest copy of all of it this client holds.
 * Only `state` and the column derived from it are known to have moved, so
 * only those are replaced. The alternative, blanking the rest, would make
 * another person's move look like data loss.
 *
 * Returns `null` when the state is not one this build recognises — the same
 * `isItemState` narrowing `drop-handler` already applies to an undo, and for
 * the same reason: a state that is not in the vocabulary has no column, and
 * guessing one would put the card in an arbitrary place. The caller leaves
 * the card alone in that case and lets the live refetch settle it.
 */
export function conflictEntry(
  state: DragState,
  itemId: string,
  currentState: string,
): BoardEntry | null {
  if (!isItemState(currentState)) return null;
  // The pre-move entry when there is one — it is the copy that has not been
  // overwritten by the optimistic guess — and otherwise whatever is on the
  // board under that id.
  const base =
    state.pendingOriginal?.item.id === itemId
      ? state.pendingOriginal
      : findEntry(state.board, itemId);
  if (base === null) return null;
  return {
    ...base,
    column: columnForState(currentState),
    item: { ...base.item, state: currentState },
  };
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
  // The entry as it was BEFORE the optimistic move, captured by `dropped`.
  // Read here, off the outcome, because `deps.read()` after the write would
  // already show the moved card and the `from` would be the state the item
  // was moved *to*, making the undo a no-op that looks like it worked.
  const original = outcome.state.pendingOriginal;

  // **Read off the pre-move entry, not off the column.** `original` is the
  // entry as the last board read reported it, captured by `dropped` before
  // the optimistic move overwrote the card — so its `state` is the server's
  // own word for where this item is, which is exactly what the precondition
  // has to compare against. Deriving it from the source column instead would
  // reconstruct the UI's belief, and a guard that moved the item elsewhere
  // would make the resulting 409 name a state that never existed.
  return deps.move(itemId, target, original?.item.state).then((result) => {
    // **The conflict branch reconciles; every other refusal reverts.** The
    // difference is not cosmetic: a conflict means the item really did move,
    // so putting the card back where this client last saw it would be a
    // second wrong answer delivered confidently. See `moveConflicted`.
    //
    // The message is built here rather than in `move.ts` because naming the
    // other actor needs the live feed, which only the host has.
    const conflict = !result.ok ? result.conflict : undefined;
    deps.update((current) => {
      if (result.ok) return moveSettled(current, sequence, result.entry);
      if (conflict === undefined) return moveRefused(current, sequence, result.message);
      const message =
        deps.describeConflict === undefined
          ? result.message
          : deps.describeConflict(conflict, itemId);
      return moveConflicted(
        current,
        sequence,
        message,
        conflictEntry(current, itemId, conflict.currentState),
      );
    });

    // **Offered only on success, and only when this move is still the
    // newest.** Two drags of the same card in quick succession can have the
    // first request answer after the second was applied: `moveSettled`
    // already refuses to write that stale answer to the board, and this
    // offers nothing for it either. Without the staleness check the toast
    // would show the *older* move's undo, whose `expectedFrom` does not
    // match the item any more — so the button would be refused on press,
    // having told the person it was available.
    //
    // Read through `deps.read()` after the update, which is the newest
    // sequence by the same contract `read` carries above.
    if (!result.ok || deps.offerUndo === undefined) return;
    if (isStale(deps.read(), sequence)) return;
    if (original === null) return;
    const from = original.item.state;
    const to = result.entry.item.state;
    // **Narrowed, not cast.** A board item's `state` is typed `string`
    // because it arrives over the wire, while an undo's `ItemMove` needs a
    // real state value — it becomes the `to` and the `expectedFrom` of a
    // transition request. `isItemState` is the same guard `get-board.ts`
    // uses on the way in; a cast here would let an unrecognised string
    // through and produce an undo that the server refuses on press, after
    // the person had already been told it was available.
    if (!isItemState(from) || !isItemState(to)) return;

    deps.offerUndo({
      kind: "state-change",
      at: Date.now(),
      move: { itemId, from, to },
      itemTitle: original.item.title,
    });
  });
}
