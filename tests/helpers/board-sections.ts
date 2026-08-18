// Builds the client's `BoardSection` shape from a bare list of entries.
//
// The board's columns each carry a page *and* a counted total
// (MILESTONES.md #109, #123), but most board tests are about something else
// entirely — a tone, a badge, a drag — and only need "these entries are in
// this column". Writing the other three fields out at every fixture site
// would bury each file's actual subject in boilerplate.
//
// **The default `total` is the entry count, and that is a fixture
// convenience, not the production rule.** In a real response `total` is
// counted server-side and routinely differs from the page length; that
// difference is the whole of #123 and is asserted directly, against real
// data, in `tests/board-pagination.test.ts`. Fixtures here pass an explicit
// `total` whenever the difference is the thing under test.
import type { BoardColumnId, BoardEntry, BoardSection } from "@/lib/board/types";
import { emptyBoard } from "@/lib/board/view";
import type { Board } from "@/lib/board/types";

export function section(
  entries: readonly BoardEntry[],
  overrides: Partial<BoardSection> = {},
): BoardSection {
  return {
    entries,
    total: entries.length,
    nextCursor: null,
    withheld: false,
    ...overrides,
  };
}

/** A board whose named columns hold the given entries, and whose others are empty. */
export function boardOf(columns: Partial<Record<BoardColumnId, readonly BoardEntry[]>>): Board {
  const board = { ...emptyBoard() } as Record<BoardColumnId, BoardSection>;
  for (const [column, entries] of Object.entries(columns)) {
    if (entries) board[column as BoardColumnId] = section(entries);
  }
  return board;
}
