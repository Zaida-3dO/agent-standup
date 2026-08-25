// The list view's derivations — the pure half of `ListView.tsx`.
//
// Same split every other board module follows (`view.ts`, `state.ts`,
// `paging.ts`): the decisions live here as plain functions over plain data
// so this repo's DOM-free harness (`vitest.config.ts`: `environment:
// "node"`) can exercise them directly, and the component is thin wiring.
//
// **This module derives nothing new about the data.** Which column a row is
// in is still the server's answer, read off `entry.column` exactly as the
// kanban reads it; the order within a section is still the order the server
// returned, which is the order the `sort` parameter asked for. What is
// genuinely list-specific is only the flattening below — turning four
// independently-paged sections into one ordered sequence of rows, and
// keeping the section headings attached to it.

import {
  BOARD_COLUMNS,
  type Board,
  type BoardColumnId,
  type BoardEntry,
  type BoardSection,
} from "./types";
import { columnTitle } from "./view";

/**
 * One section of the list — a column's heading and its rows.
 *
 * The whole `BoardSection` is carried rather than just its entries, because
 * the heading needs the server's counted `total` (never `entries.length` —
 * MILESTONES.md #123) and the "show more" control needs `nextCursor` and
 * `withheld`. Dropping to a bare entry list here is exactly how a section
 * heading comes to read "8" while the column holds 68.
 */
export interface ListSection {
  readonly column: BoardColumnId;
  /** The heading, from the same `columnTitle` the kanban's headings use. */
  readonly title: string;
  readonly section: BoardSection;
}

/**
 * The board as a sequence of sections, in board order.
 *
 * **Every column is present, including the empty ones.** A section that
 * vanished when its column emptied would take its heading and its count
 * with it, and a reader scanning for "Completed" would find no answer to
 * whether it is empty or simply not drawn — the distinction #123 exists to
 * preserve. The component decides how to render an empty section; this
 * decides that there is one.
 */
export function listSections(board: Board): readonly ListSection[] {
  return BOARD_COLUMNS.map((column) => ({
    column,
    title: columnTitle(column),
    section: board[column],
  }));
}

/**
 * Every entry on the board in one flat sequence, in board-column order.
 *
 * This is the list's answer to "the same set as the kanban": it is the
 * concatenation of exactly the four sections the kanban draws, in the same
 * order, with nothing added and nothing dropped. A row that appears here
 * and not on the kanban — or the reverse — is a defect in this function,
 * which is why it is one line over `BOARD_COLUMNS` rather than a filter
 * that could disagree with the server's grouping.
 */
export function listEntries(board: Board): readonly BoardEntry[] {
  return BOARD_COLUMNS.flatMap((column) => board[column].entries);
}

/**
 * How many rows the list is actually showing.
 *
 * Deliberately the number of RENDERED rows rather than the sum of the
 * columns' totals: it is the number the "showing N of M" caption's first
 * half means, and the two differ on every paginated board. See
 * `listTotal` for the other half.
 */
export function listShown(board: Board): number {
  return BOARD_COLUMNS.reduce((sum, column) => sum + board[column].entries.length, 0);
}

/**
 * How many rows exist across the whole board, paged or not.
 *
 * The sum of the server's counted totals — the same `total` a column
 * heading renders. This is the "of M" in the caption, and it is what makes
 * a 68-item backlog legible as sixty-eight rather than as the eight that
 * happen to be on the first page.
 */
export function listTotal(board: Board): number {
  return BOARD_COLUMNS.reduce((sum, column) => sum + board[column].total, 0);
}

/**
 * Whether any column has more rows the reader has not been shown.
 *
 * True when a column has a cursor to page with, **or** when it was withheld
 * — a withheld column has no cursor and has never been read, so a check on
 * `nextCursor` alone would report "nothing more to show" about a column
 * holding 175 items. That is #123 reached from the list's side.
 */
export function hasMore(board: Board): boolean {
  return BOARD_COLUMNS.some(
    (column) => board[column].nextCursor !== null || board[column].withheld,
  );
}
