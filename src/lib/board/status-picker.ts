// Picking a status instead of dragging — MILESTONES.md #76, the half that
// makes the board usable on a phone: "a list with a status picker instead
// of drag".
//
// **Why a picker rather than a touch-friendly drag.** Drag is a desktop
// gesture. On a phone it competes with the scroll it is nested inside — a
// long press to disambiguate makes every move slow, and a card dragged
// out of a bounded, scrolling column has nowhere visible to go. The row's
// framing is "a different flow, not a squeezed desktop", so the mobile
// equivalent of "put this card in that column" is to say which status it
// should have, directly.
//
// **The legality model is `drag.ts`'s, not a second one.** `TARGET_STATE`
// already answers the only question a picker asks: which statuses can be
// reached by a gesture that carries no accompanying field? A picker that
// offered `blocked` would be offering a move the server must refuse,
// because `blocked` needs a `blocked_reason` and a `blocked_on_type`
// (`guards/blocked-paused.ts`) that no picker collects. Deriving the
// options from `TARGET_STATE` means a column that becomes reachable —
// or stops being — changes both surfaces at once, and neither can drift
// into offering something the other refuses.
//
// Everything here is a plain function over plain data, the same as
// `drag.ts` and `view.ts`: the harness runs `environment: "node"` with no
// DOM, so the options list, the refusals and the labels are only directly
// provable as functions.
import { BOARD_COLUMNS, type BoardColumnId, type BoardEntry } from "./types";
import { TARGET_STATE, acceptsDrop, isDraggable, isMove } from "./drag";
import { stateLabel } from "@/lib/undo/describe";

/**
 * One choice offered by the picker.
 *
 * `column` rather than a bare state because the move is still "into that
 * column" — `requestMove` takes a column and looks the state up itself, so
 * carrying the column keeps one translation rather than two that can
 * disagree.
 */
export interface StatusChoice {
  readonly column: BoardColumnId;
  /** The state this choice moves the item to — `TARGET_STATE[column]`, never null. */
  readonly state: string;
  /** How the choice reads to a person: "In progress", not "in_progress". */
  readonly label: string;
  /** True when the item is already here — shown as the current value, not offered as a move. */
  readonly current: boolean;
}

/**
 * The reader-facing name of each column.
 *
 * Written out rather than derived from the column id, because the derived
 * forms are wrong in both directions: `in_progress` still carries an
 * underscore, and `completed` as a *destination* means "merge this", which
 * is a different word from the column's heading.
 * Stated once here so the picker and any future surface agree.
 */
const COLUMN_LABELS: Readonly<Record<BoardColumnId, string>> = {
  backlog: "Backlog",
  in_progress: "In progress",
  waiting: "Waiting",
  completed: "Completed",
};

/** How a column reads to a person. */
export function columnLabel(column: BoardColumnId): string {
  return COLUMN_LABELS[column];
}

/**
 * The statuses this item can be moved to, in board order.
 *
 * **Waiting is absent, and that is `TARGET_STATE`'s decision rather than
 * this module's.** Both of its states require fields a picker does not
 * collect, so every option it could offer would be refused — and an option
 * that always fails teaches that the interface is unreliable. Pausing and
 * blocking are done from the item, where the reason can be given.
 *
 * **A project gets no choices at all.** Its column is derived from its
 * children and it has no state of its own to transition
 * (DECISIONS.md §13c) — the same reason `isDraggable` refuses it a drag.
 * Returning an empty list lets the caller render the current status as
 * plain text instead of a control, rather than showing a picker whose
 * every option is refused.
 *
 * The item's CURRENT column is included, marked `current: true`, so the
 * control can show what the status is now as the selected option. It is
 * not a move — `isStatusMove` refuses it — but a picker that omitted the
 * present value would have nothing to display as selected.
 */
export function statusChoices(entry: BoardEntry): readonly StatusChoice[] {
  if (!isDraggable(entry)) return [];

  const choices: StatusChoice[] = [];
  for (const column of BOARD_COLUMNS) {
    const state = TARGET_STATE[column];
    // `acceptsDrop` and a null `state` are the same fact read two ways;
    // both are checked so this cannot produce a choice with an undefined
    // state if a column is ever added to `TARGET_STATE` as null.
    if (!acceptsDrop(column) || state === null) continue;
    choices.push({
      column,
      state,
      label: columnLabel(column),
      current: entry.column === column,
    });
  }
  return choices;
}

/**
 * Whether choosing `column` for `entry` is a move worth sending.
 *
 * Delegates to `drag.ts`'s `isMove` — the picker and the drag must agree
 * on what counts as a move, and the case that matters is choosing the
 * status an item already has. That is a no-op, not a transition: sending
 * it would write a state-change event recording that nothing happened.
 */
export function isStatusMove(entry: BoardEntry, column: BoardColumnId): boolean {
  return isMove(entry, column);
}

/**
 * The accessible name for the picker on a given row.
 *
 * Names the item, not just the control: a phone screen-reader user moving
 * down a list of forty rows hears "Status" forty times otherwise, with no
 * way to tell which row is focused.
 */
export function statusPickerLabel(title: string): string {
  return `Status for ${title}`;
}

/**
 * How the item's present status reads when there is no picker to show —
 * a project, whose status is derived rather than set.
 *
 * Uses the state vocabulary rather than the column name because a
 * project's row is showing a fact about the item, and `stateLabel` is the
 * repo's one way of turning a stored state into a phrase.
 */
export function readOnlyStatusLabel(state: string): string {
  return stateLabel(state);
}
