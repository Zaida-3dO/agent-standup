// The board's load lifecycle — the pure half of `Board.tsx`, split out for
// the same reason `src/lib/profile/state.ts` is: this repo's harness runs
// `environment: "node"` with no DOM, so the fetch shaping and the
// loading/error/loaded branching are only directly testable as plain
// functions. The client component is thin wiring over these.
import { BOARD_COLUMNS, type Board, type BoardColumnId, type BoardSection } from "./types";
import { emptyBoard, emptySection } from "./view";

export type BoardLoadState =
  { status: "loading" } | { status: "error"; message: string } | { status: "loaded"; board: Board };

/**
 * One column of the board from `GET /api/board?column=…`. Throws a message
 * fit to show directly — never a raw `Response` or a JSON-parse error,
 * matching `fetchPeople`.
 *
 * **A column at a time, not a board at a time** (MILESTONES.md #109). The
 * front end asks for one paginated section per column, so a column that is
 * sixty-eight items long and one that is three cost the same first paint,
 * and paging one column never re-fetches the others.
 *
 * **Missing sections are filled in, not trusted.** The server always
 * returns all four keys (`get_board` builds the record literally), but a
 * component that indexes `board.waiting.entries` on a response missing it
 * would crash on `undefined.entries`. Merging over `emptySection()` makes a
 * partial response render as an empty column instead of a blank page.
 */
export async function fetchBoardColumn(
  column: BoardColumnId,
  options: { readonly cursor?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<BoardSection> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = new URLSearchParams({ column });
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const response = await fetchImpl(`/api/board?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Could not load the board (GET /api/board returned ${response.status}).`);
  }
  const body = (await response.json()) as { board?: { columns?: Partial<Board> } };
  return { ...emptySection(), ...(body.board?.columns?.[column] ?? {}) };
}

/**
 * The whole board, as four column reads issued together.
 *
 * Every column is requested explicitly rather than relying on the default
 * open-work slice, because this is the board *view* — its whole job is to
 * show all four columns, including the two a default read withholds. The
 * requests go out in parallel: they are independent, and serialising them
 * would make the first paint wait on the slowest column for no benefit.
 */
export async function fetchBoard(fetchImpl: typeof fetch = fetch): Promise<Board> {
  const sections = await Promise.all(
    BOARD_COLUMNS.map((column) => fetchBoardColumn(column, { fetchImpl })),
  );
  const board = emptyBoard();
  return BOARD_COLUMNS.reduce<Board>(
    (acc, column, index) => ({ ...acc, [column]: sections[index] ?? emptySection() }),
    board,
  );
}

/** Turns a caught value into the message the error state shows — never a raw, possibly-unhelpful object. */
export function boardErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the board.";
}
