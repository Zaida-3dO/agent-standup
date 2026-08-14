// The board's derived-column vocabulary. See docs/plans/SCHEMA.md §1.1
// ("four columns: eleven values, four columns") and MILESTONES.md #36.
//
// Columns are **derived at read time, never stored, never transitioned**
// (SCHEMA.md §1.1: "Columns are derived at read time"). This module is the
// one place that mapping lives, so `get_board` and anything else that ever
// needs "which column is this state in" read the same table rather than
// each growing its own copy that can silently drift from SCHEMA.md.
import { ITEM_STATES, type ItemStateValue } from "../state-machine/states";

/**
 * The four board columns, in board order. `waiting` deliberately holds both
 * `paused` and `blocked` — SCHEMA.md §1.1: "paused and blocked share a
 * column, distinguished by colour". That split (amber vs red) is a row #37
 * (board UI) concern; this layer keeps the two states distinguishable in
 * `items.state` on every returned record; it only merges them into one
 * bucket.
 */
export const BOARD_COLUMNS = ["backlog", "in_progress", "waiting", "completed"] as const;

export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/**
 * Every `ItemStateValue` to its column, written out rather than computed
 * from a pattern — the same reasoning `states.ts` gives for spelling out
 * `ITEM_STATES` literally: a test asserting "every state maps to exactly
 * one column" needs a table it did not get from the same place the mapping
 * itself is read from, or the test would be circular.
 */
const STATE_TO_COLUMN: Readonly<Record<ItemStateValue, BoardColumn>> = {
  someday: "backlog",
  on_deck: "backlog",
  planning: "in_progress",
  plan_review: "in_progress",
  executing: "in_progress",
  in_review: "in_progress",
  paused: "waiting",
  blocked: "waiting",
  merged: "completed",
  research_done: "completed",
  wont_do: "completed",
  cancelled: "completed",
};

/** Every state that maps to a given column — the inverse of `STATE_TO_COLUMN`, built once. */
export const STATES_BY_COLUMN: Readonly<Record<BoardColumn, readonly ItemStateValue[]>> =
  Object.freeze({
    backlog: ITEM_STATES.filter((state) => STATE_TO_COLUMN[state] === "backlog"),
    in_progress: ITEM_STATES.filter((state) => STATE_TO_COLUMN[state] === "in_progress"),
    waiting: ITEM_STATES.filter((state) => STATE_TO_COLUMN[state] === "waiting"),
    completed: ITEM_STATES.filter((state) => STATE_TO_COLUMN[state] === "completed"),
  });

/** The column a task or subtask's own state maps to. Not meaningful for a project — see `columnForProject`. */
export function columnForState(state: ItemStateValue): BoardColumn {
  return STATE_TO_COLUMN[state];
}

/**
 * The states an item does not come back from — MILESTONES.md #103's
 * "terminal states", which reads want excluded by default.
 *
 * **Derived from the column table above rather than written out a fifth
 * time.** `merged`, `research_done`, `wont_do` and `cancelled` are exactly
 * the states that map to `completed`, and that is not a coincidence to be
 * restated: the board's completed column and "work that is finished" are
 * the same idea reached from two directions. Spelling the four out again
 * here would create a second list that a future state addition could
 * update one of and not the other — the silent-drift failure `columns.ts`
 * already exists to prevent for the mapping itself.
 *
 * Note this is the one place in this module that deliberately does *not*
 * follow `states.ts`'s "write the list out so the test isn't circular"
 * reasoning. The circularity that argument guards against is a test
 * reading its expectations from the implementation; here the *test* names
 * the four states literally (`tests/board-columns.test.ts`), so the
 * assertion still comes from outside.
 */
export const TERMINAL_STATES: readonly ItemStateValue[] = STATES_BY_COLUMN.completed;

/** Whether a state is terminal — finished work, excluded from reads unless asked for. */
export function isTerminalState(state: ItemStateValue): boolean {
  return STATE_TO_COLUMN[state] === "completed";
}

/**
 * A ranking over columns used only to pick the single "most active" column
 * when a project has children spread across several — `in_progress` beats
 * `waiting` beats `blocked-ish` etc. See `columnForProject`'s header for why
 * this exists and what it means.
 */
const COLUMN_RANK: Readonly<Record<BoardColumn, number>> = {
  in_progress: 0,
  waiting: 1,
  backlog: 2,
  completed: 3,
};

/**
 * Derives a project's column from its children — DECISIONS.md §13c:
 * "Projects do not carry state — it is derived from their children" and
 * "A project's column is computed on read, so guards never run against a
 * project's own state." `items.state` is never read for a project here,
 * even though the column happens to be non-null on the row (every item
 * gets `on_deck` at creation, per `create_item` — see items-operations
 * tests) — that stored value is a leftover default, not a fact about a
 * project, and reading it would silently reintroduce the second source of
 * truth §13c exists to rule out.
 *
 * The rule: **the most active column among a project's descendants wins**,
 * ranked `in_progress > waiting > backlog > completed`. A project with any
 * child still being worked belongs where the work is, not off to one side
 * — that is what "derived from children" has to mean for a single-valued
 * column, given a project can have children in several states at once.
 * `completed` only wins when every descendant is completed (or there are
 * none), because a project only reads as "done" once nothing under it is
 * still live — the same requirement §5a's own tree rule enforces for
 * actually *finishing* an item ("an item cannot complete while any child is
 * actionable").
 *
 * A project with **no descendants at all** reads as `backlog` — there is
 * nothing to derive yet, and `backlog` is the state every item starts life
 * in (`on_deck`), so an empty project reads the same way a freshly created
 * task would.
 */
export function columnForProject(descendantStates: readonly ItemStateValue[]): BoardColumn {
  if (descendantStates.length === 0) return "backlog";
  let best: BoardColumn = "completed";
  for (const state of descendantStates) {
    const column = columnForState(state);
    if (COLUMN_RANK[column] < COLUMN_RANK[best]) {
      best = column;
    }
  }
  return best;
}
