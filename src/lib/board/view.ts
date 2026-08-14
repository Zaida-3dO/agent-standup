// The board's display derivations — MILESTONES.md #37: "the four columns,
// amber/red split in Waiting, needs-you badge".
//
// Every decision the board makes about how something *looks* lives here, as
// plain functions over plain data, so this repo's DOM-free harness
// (`vitest.config.ts`: `environment: "node"`) can exercise it directly
// rather than only through a rendered component — the same split
// `src/lib/profile/state.ts` and `resolve.ts` already follow. The
// components under `src/components/board/` are the thin presentational
// layer over these.
//
// **This module derives nothing the API already derived.** Which column an
// item is in is the server's answer (`get_board` groups by
// `columnForState`/`columnForProject`, and a project's column is a
// recursive walk over its subtree that a client cannot reproduce from the
// board response alone). The client reads `entry.column` and never
// recomputes it. What is genuinely client-side is everything below: how a
// column is titled, which tone a Waiting card carries, and who the
// needs-you badge is counting for.
import { BOARD_COLUMNS, type Board, type BoardColumnId, type BoardEntry } from "./types";

export { BOARD_COLUMNS };
export type { BoardColumnId };

/** A column's heading, in board order. */
const COLUMN_TITLES: Readonly<Record<BoardColumnId, string>> = {
  backlog: "Backlog",
  in_progress: "In progress",
  waiting: "Waiting",
  completed: "Completed",
};

export function columnTitle(column: BoardColumnId): string {
  return COLUMN_TITLES[column];
}

/**
 * The colour a Waiting card carries — SCHEMA.md §1.1: "**`paused` and
 * `blocked` share a column** …, distinguished by **colour** — amber for
 * paused, red for blocked. The states stay separate in the data; only the
 * display groups them."
 *
 * `null` means "no tone" and is the honest answer for everything that is
 * not one of those two states, including:
 *
 *   - any card outside the Waiting column — a card in In progress is not
 *     amber-or-red, it is untoned, and
 *   - a **project** sitting in Waiting, whose own `state` is a creation
 *     leftover rather than a fact about it (`get-board.ts`: a project's
 *     stored state "is a leftover default, not a fact about a project").
 *     Reading it would paint a project amber because it was created
 *     `on_deck`… except `on_deck` is not amber either, so the bug would be
 *     subtler: a project derived into Waiting by a `paused` child would
 *     take its tone from its own stale row, not from the child that put it
 *     there. Returning `null` says "this card's colour is not something its
 *     own state can answer", which is exactly true.
 */
export type WaitingTone = "amber" | "red";

export function waitingTone(entry: BoardEntry): WaitingTone | null {
  if (entry.column !== "waiting") return null;
  if (entry.item.kind === "project") return null;
  if (entry.item.state === "paused") return "amber";
  if (entry.item.state === "blocked") return "red";
  return null;
}

/**
 * Whether a card is something the given person must act on.
 *
 * SCHEMA.md §1.1's warning is the whole reason this exists: "narrowing
 * `blocked` was meant to make its column a trustworthy *'what needs me'*
 * list readable by height. Sharing a column loses that, so the needs-you
 * count wants a badge or filter of its own — otherwise the distinction
 * survives in the data and disappears where you'd actually use it."
 *
 * The rule, deliberately narrow: an item needs you when it is **`blocked`**,
 * blocked **on a person**, and that person is **you**. Three conditions,
 * each of which excludes a real case that would otherwise inflate the count
 * into uselessness:
 *
 *   - **`paused` never counts.** Paused means nobody is on it and the
 *     system re-checks a condition (SCHEMA.md §1.1) — there is no one to
 *     act. Counting it would put the amber half of the column into a badge
 *     whose entire purpose is to rescue the red half's meaning.
 *   - **`blocked` on an external process or a time never counts.** Waiting
 *     on someone else's deploy or on a date is not a thing you can do
 *     anything about; a badge that includes it stops being a to-do list.
 *   - **Blocked on a *different* person never counts.** It is on their
 *     badge, not yours.
 *
 * With no active profile (`personId` null) nothing needs you — not
 * "everything blocked on anyone", which would show a stranger's queue as
 * though it were yours.
 */
export function needsYou(entry: BoardEntry, personId: string | null): boolean {
  if (personId === null) return false;
  if (entry.item.kind === "project") return false;
  if (entry.item.state !== "blocked") return false;
  if (entry.item.blockedOnType !== "person") return false;
  return entry.item.blockedOnPersonId === personId;
}

/**
 * How many cards on the whole board need this person — the badge's number.
 *
 * Counted across **every** column, not just Waiting. `needsYou` already
 * requires `state === "blocked"`, and the server puts every blocked task in
 * Waiting, so in practice the two are the same set today. Scanning the
 * whole board anyway means the badge cannot silently under-count if an item
 * is ever blocked from somewhere else, and it costs one pass over data
 * already in memory.
 */
export function needsYouCount(board: Board, personId: string | null): number {
  let count = 0;
  for (const column of BOARD_COLUMNS) {
    for (const entry of board[column]) {
      if (needsYou(entry, personId)) count++;
    }
  }
  return count;
}

/** Every entry on the board that needs this person, in board-column order. */
export function needsYouEntries(board: Board, personId: string | null): BoardEntry[] {
  const entries: BoardEntry[] = [];
  for (const column of BOARD_COLUMNS) {
    for (const entry of board[column]) {
      if (needsYou(entry, personId)) entries.push(entry);
    }
  }
  return entries;
}

/**
 * The Waiting column's own amber/red tally, for the sub-heading that keeps
 * the split legible at a glance even before you read the cards.
 *
 * Anything in Waiting that is neither (a project, or a state that should
 * not be in this column at all) is counted as `other` rather than dropped —
 * a card that exists but appears in no tally is a card that silently goes
 * missing from the count under the heading listing it.
 */
export interface WaitingSplit {
  readonly amber: number;
  readonly red: number;
  readonly other: number;
}

export function waitingSplit(board: Board): WaitingSplit {
  let amber = 0;
  let red = 0;
  let other = 0;
  for (const entry of board.waiting) {
    const tone = waitingTone(entry);
    if (tone === "amber") amber++;
    else if (tone === "red") red++;
    else other++;
  }
  return { amber, red, other };
}

/** An empty board — every column present and empty. Used as the initial render state and by tests. */
export function emptyBoard(): Board {
  return { backlog: [], in_progress: [], waiting: [], completed: [] };
}
