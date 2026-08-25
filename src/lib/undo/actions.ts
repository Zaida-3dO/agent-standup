// What an undoable action *is*, and what undoing one would take — T18's
// fourth piece.
//
// ── Why undo is honest here, and not a compensating hack ────────────────
//
// The row makes a claim worth checking before building on it: "the state
// machine permits **any state to any state**, so an undo is a real inverse
// operation rather than a compensating hack". It is true — see
// `src/lib/service/state-machine/states.ts`, whose `allStatePairs()` exists
// precisely so a test can sweep the whole grid, and whose guard refuses on
// *preconditions* rather than on the shape of the pair. So undoing a move
// from `executing` to `in_review` is not a special "rollback" verb the
// server has to learn: it is a transition to `executing`, indistinguishable
// from any other, recorded in history as the real event it is.
//
// That matters for what this module does NOT do. There is no undo log on
// the server, no soft-delete of a transition, no "revert" endpoint. An undo
// is derived entirely on the client from what the action recorded about
// itself, and sent through the same `transition_item` every other move
// uses. This file is that derivation, and nothing else.
//
// ── Pure by requirement, not by preference ──────────────────────────────
//
// No hooks, no fetch, no clock read. Everything here is a plain function
// over plain data, because this repo's harness runs `environment: "node"`
// with no DOM (`vitest.config.ts`) and the whole `src/components/` tree is
// kept hook-free so components can be called as functions
// (`tests/helpers/react-element.ts`). The derivation is the part most worth
// testing directly — a wrong inverse silently moves an item somewhere
// nobody asked for — so it is kept where a test can call it with no
// scaffolding at all. The clock is passed in (`nowMs`) rather than read,
// for the same reason: expiry is the other thing worth testing, and a
// module that read `Date.now()` itself could only be tested by waiting.
import type { ItemStateValue } from "@/lib/service/state-machine";

/**
 * How long an undo stays offered, in milliseconds.
 *
 * The row says "~10s window". Ten seconds is long enough to notice a
 * mistaken drop and reach for the button, and short enough that the
 * premise the undo rests on — that the item is still where the action left
 * it — is usually still true. It is not a guarantee of that premise;
 * nothing client-side could be. `expectedFrom` is what makes the racy case
 * safe (see `undo-request.ts`), and the short window is what makes it rare.
 */
export const UNDO_WINDOW_MS = 10_000;

/**
 * One item's move, as it actually happened.
 *
 * **`from` is the state the server reported, not the state the UI believed.**
 * That distinction is the entire reason this type carries it rather than
 * the caller re-deriving it: a transition's response says where the item
 * came from (`outcome.from`), and a guard is free to land an item somewhere
 * other than the column that was asked for. Undoing to a remembered guess
 * would then move the item to a state it was never in.
 */
export interface ItemMove {
  readonly itemId: string;
  readonly from: ItemStateValue;
  readonly to: ItemStateValue;
}

/**
 * An action a person took that can be offered back to them.
 *
 * Three kinds, matching the row's "a state change, a bulk operation and an
 * archive". They are one union rather than three parallel paths because
 * everything downstream — the window, the toast, the expiry — treats them
 * identically, and only `inverseOf` cares which is which.
 *
 * `at` is when the action happened, in epoch milliseconds. Stored on the
 * action rather than tracked beside it so that "is this still undoable"
 * is a question about the action itself, answerable by a pure function.
 */
export type UndoableAction =
  | {
      readonly kind: "state-change";
      readonly at: number;
      /** What the person did, for the toast to describe. */
      readonly move: ItemMove;
      /** The item's title, so the toast can name it rather than show an id. */
      readonly itemTitle: string;
    }
  | {
      readonly kind: "bulk";
      readonly at: number;
      /**
       * Every item the bulk operation moved, each with its OWN `from`.
       *
       * Per-item rather than one shared `from` for the whole batch: a bulk
       * move selects items across columns and drives them to one target,
       * so the items genuinely came from different states and a single
       * remembered `from` would be wrong for all but one of them. This is
       * the shape T6-E's bulk actions should record.
       */
      readonly moves: readonly ItemMove[];
      /** The state they were all driven to — what the toast reports. */
      readonly to: ItemStateValue;
    }
  | {
      readonly kind: "archive";
      readonly at: number;
      readonly itemId: string;
      readonly itemTitle: string;
    };

/**
 * A single transition an undo needs to perform.
 *
 * `expectedFrom` is the state the item must still be in for this undo to be
 * safe, which is the state the original action moved it *to*. `to` is where
 * it goes back to, which is where the action moved it *from*. The inversion
 * is exactly that swap — see `inverseOf`.
 */
export interface UndoStep {
  readonly itemId: string;
  readonly to: ItemStateValue;
  readonly expectedFrom: ItemStateValue;
}

/**
 * What undoing an action would take.
 *
 * A discriminated union rather than `UndoStep[] | null`, because "this
 * cannot be undone" has a *reason* worth showing, and collapsing it to an
 * empty list would leave the toast unable to distinguish "nothing to do"
 * from "not offered". The reason is carried as prose the toast can render
 * directly.
 */
export type UndoPlan =
  | { readonly available: true; readonly steps: readonly UndoStep[] }
  | { readonly available: false; readonly reason: string };

/**
 * The inverse of `action` — the transitions that would put things back.
 *
 * **Why archive has no inverse, and why that is stated rather than hidden.**
 * Archiving is `delete_item`, which sets `archivedAt` and never clears it
 * (`src/lib/service/operations/delete-item.ts`: "archive, never delete").
 * There is no unarchive operation in the service layer — `update_item`'s
 * input schema is `.strict()` and does not accept `archivedAt`, so the
 * generic edit path cannot clear it either. Undo therefore genuinely
 * cannot reverse an archive, and the honest thing is to say so and show
 * no button, rather than offer one that would fail when pressed. That is
 * the same principle an expired window follows: a button that cannot do
 * anything is worse than no button, so the capability the server lacks is
 * stated rather than papered over.
 *
 * When a restore path lands, this becomes the one place that changes:
 * `archive` starts returning an available plan, and every caller — the
 * toast, the window check, the request runner — already handles it.
 */
export function inverseOf(action: UndoableAction): UndoPlan {
  switch (action.kind) {
    case "state-change": {
      const { move } = action;
      // A move that changed nothing is not undoable, and this is not
      // hypothetical: a drop onto the column an item is already in reports
      // a successful transition with `from === to`. Offering an undo for
      // it would show a button that does nothing observable, and pressing
      // it would write a second identical state-change event into the
      // item's history — making the record narrate a move nobody made.
      if (move.from === move.to) {
        return { available: false, reason: "That did not change anything." };
      }
      return {
        available: true,
        steps: [{ itemId: move.itemId, to: move.from, expectedFrom: move.to }],
      };
    }
    case "bulk": {
      // Same no-op exclusion as above, per item: a bulk move onto a column
      // some of the selection already occupied should undo the ones it
      // really moved and leave the rest alone.
      const steps = action.moves
        .filter((move) => move.from !== move.to)
        .map((move) => ({ itemId: move.itemId, to: move.from, expectedFrom: move.to }));
      if (steps.length === 0) {
        return { available: false, reason: "That did not change anything." };
      }
      return { available: true, steps };
    }
    case "archive":
      return {
        available: false,
        reason: "Archiving cannot be undone — the item is still readable by its id.",
      };
  }
}

/**
 * Whether `action` is still inside its window at `nowMs`.
 *
 * Exclusive at the far edge: an action exactly `UNDO_WINDOW_MS` old has
 * had its whole window and is expired. The boundary has to be decided
 * somewhere, and expiring on the tick keeps "the window is ten seconds"
 * literally true rather than ten-seconds-and-a-moment.
 *
 * An action dated in the future is treated as live rather than as an
 * error — a clock that has stepped backwards is not the person's fault,
 * and the failure mode of the alternative (an undo that vanishes
 * instantly) is worse than of this one (an undo offered slightly too
 * long, which `expectedFrom` still makes safe).
 */
export function isWithinWindow(action: UndoableAction, nowMs: number): boolean {
  return nowMs - action.at < UNDO_WINDOW_MS;
}

/**
 * How long is left on the window, in milliseconds, floored at zero.
 *
 * For a countdown in the affordance. Floored rather than allowed negative
 * so a caller can render it without re-checking the sign.
 */
export function remainingMs(action: UndoableAction, nowMs: number): number {
  const left = action.at + UNDO_WINDOW_MS - nowMs;
  return left > 0 ? left : 0;
}

/**
 * Whether the undo button should be shown at all.
 *
 * Both conditions, in one place, because they are the same question from
 * the person's side — "can I press this" — and splitting them across the
 * component would let one be checked without the other. The failure that
 * matters is showing a button whose press cannot work.
 */
export function canUndo(action: UndoableAction, nowMs: number): boolean {
  return isWithinWindow(action, nowMs) && inverseOf(action).available;
}
