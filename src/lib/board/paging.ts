// Appending a page to a column — the pure half of the "show more" control.
//
// `get_board` has returned `total`, `nextCursor` and `withheld` per column
// since MILESTONES.md #109, and nothing consumed any of it: the board issued
// one read per column and rendered whatever came back, so a 146-item backlog
// showed its first page with no way to reach the rest and no statement that
// there was a rest. This module is the consumer.
//
// A plain function over plain data rather than logic inside the component,
// for the reason every other `lib/board/*` module gives: the harness runs
// `environment: "node"` with no DOM, so a merge rule expressed here is
// directly testable and the same rule expressed inside a `setState` updater
// is not.
import type { Board, BoardColumnId, BoardSection } from "./types";

/**
 * One column with a further page appended.
 *
 * Three things this gets right that a naive spread does not:
 *
 *   - **The page is appended.** "Show more" adds to what the reader is
 *     looking at, so every row already on screen stays on screen and the
 *     control accumulates rather than swapping one page for another.
 *   - **The cursor and the withheld flag come from the NEW page.** They
 *     describe the read that just happened, which is what makes the next
 *     press fetch the next page rather than re-requesting this one.
 *   - **`total` comes from the new page too**, because it is a fresh count
 *     from the server and the column may genuinely have grown since the first
 *     read. Deriving it from the accumulated length instead is #123's defect
 *     re-introduced at the merge step: after appending, `entries.length` and
 *     `total` are close enough to look right and still wrong.
 *
 * **Entries already present are not added twice.** Keyset pagination does not
 * overlap pages, so in the normal case this de-duplication removes nothing —
 * it is here because the abnormal cases are real: a double-fired control, or
 * an item created above the cursor between two reads. Rendering one item
 * twice under two identical React keys is a defect that outlives whatever
 * caused it.
 */
export function appendPage(current: BoardSection, page: BoardSection): BoardSection {
  const seen = new Set(current.entries.map((entry) => entry.item.id));
  const added = page.entries.filter((entry) => !seen.has(entry.item.id));
  return {
    entries: [...current.entries, ...added],
    total: page.total,
    nextCursor: page.nextCursor,
    withheld: page.withheld,
  };
}

/** The board with one column's further page appended — the whole state update "show more" makes. */
export function boardWithPage(board: Board, column: BoardColumnId, page: BoardSection): Board {
  return { ...board, [column]: appendPage(board[column], page) };
}

/**
 * Whether a column has more to fetch.
 *
 * The cursor alone, not `entries.length < total`. The two disagree, and the
 * cursor is the one that is right: a board page carries the column's projects
 * *unpaged* alongside its paged tasks, so a first page of a 146-item backlog
 * can return 41 rows against a 25-row limit. A length comparison would then
 * keep offering "show more" after the last page had been fetched, and the
 * press would return nothing.
 */
export function hasMore(section: BoardSection): boolean {
  return section.nextCursor !== null;
}
