// The board's load lifecycle — the pure half of `Board.tsx`, split out for
// the same reason `src/lib/profile/state.ts` is: this repo's harness runs
// `environment: "node"` with no DOM, so the fetch shaping and the
// loading/error/loaded branching are only directly testable as plain
// functions. The client component is thin wiring over these.
import {
  BOARD_COLUMNS,
  type Board,
  type BoardColumnId,
  type BoardEntry,
  type BoardSection,
} from "./types";
import { emptyBoard, emptySection } from "./view";
import { uiApiPath } from "@/lib/ui-proxy/path";
import { boardRequestParams, emptyBoardQuery, type BoardQuery } from "./filters";

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
  options: {
    readonly cursor?: string;
    readonly fetchImpl?: typeof fetch;
    /**
     * The reader's filters and ordering (MILESTONES.md #75). Absent means an
     * unnarrowed board in the default order — the shape every caller had
     * before filters were reachable, so an existing caller keeps working.
     *
     * **The same object the address bar encodes**, translated by
     * `boardRequestParams` rather than by a second mapping here: one
     * translation is what makes a pasted URL reproduce the board, because
     * there is no second one that could apply a filter to the request but
     * not to the address.
     */
    readonly query?: BoardQuery;
  } = {},
): Promise<BoardSection> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = boardRequestParams(options.query ?? emptyBoardQuery(), {
    column,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  // The browser reaches the API through the server-side proxy, which is what
  // keeps the credential off the client — `uiApiPath` decides that, and it is
  // orthogonal to how the query string is built.
  const response = await fetchImpl(uiApiPath(`/api/board?${query.toString()}`));
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
export async function fetchBoard(
  fetchImpl: typeof fetch = fetch,
  query: BoardQuery = emptyBoardQuery(),
): Promise<Board> {
  const sections = await Promise.all(
    BOARD_COLUMNS.map((column) => fetchBoardColumn(column, { fetchImpl, query })),
  );
  const board = emptyBoard();
  return BOARD_COLUMNS.reduce<Board>(
    (acc, column, index) => ({ ...acc, [column]: sections[index] ?? emptySection() }),
    board,
  );
}

/**
 * One card's subtasks, for the disclosure control that expands it in place.
 *
 * **Scoped with the filters the board already has, plus `project`.** The
 * board's `project` filter is "this row's whole subtree", which is exactly
 * the set a card is hiding, so this needs no new server surface at all — it
 * is the same read the board makes, narrowed to one branch of the tree.
 *
 * Two deliberate departures from the reader's own query:
 *
 *   - **`level` is widened to every level**, because the whole point of
 *     expanding a card is to see the levels the board's default removes.
 *
 *     **It is widened explicitly, and `undefined` will not do it.** An
 *     absent `level` does not mean "no narrowing" anywhere in this module:
 *     `boardRequestParams` deliberately writes the level into every request
 *     including the default (`get_board` itself defaults nothing, so
 *     omitting it would widen a board read to include projects), so
 *     `level: undefined` here emits `level=include:1` — the board's own
 *     default — and a level-2 subtask would be excluded by the very request
 *     asking for it. The control would return nothing, every time, while
 *     looking like it worked.
 *
 *     `exclude` with no levels is the form that means "narrow by nothing":
 *     it serialises to `exclude:`, which `parseLevelFilter` refuses as
 *     unparseable, so `GET /api/board` passes no level to the operation at
 *     all and every depth comes back. That is a documented round trip, not
 *     an accident of parsing — see `parseLevelFilter`'s header, and the
 *     route's own note that it "passes no level at all" for an absent one.
 *   - **`includeTerminal` is forced on.** A card's badge counts finished
 *     subtasks in its `done` figure, so a list that omitted them would show
 *     fewer rows than the badge promised — the count and the list have to
 *     describe the same set.
 *
 * The parent itself is filtered out of the result: `project` scoping returns
 * the named row alongside its descendants, and a card listing itself as its
 * own subtask would be nonsense.
 *
 * All four columns, because a subtask can be in any of them and the point is
 * to show what is under this card, not what is under it *and* in the column
 * the parent happens to sit in.
 */
export async function fetchSubtasks(
  parentId: string,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly query?: BoardQuery;
  } = {},
): Promise<readonly BoardEntry[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.query ?? emptyBoardQuery();
  const scoped: BoardQuery = {
    ...base,
    filters: {
      ...base.filters,
      project: parentId,
      // "Every level" — see the header. NOT `undefined`, which is this
      // module's word for "the board default", i.e. level 1 only.
      level: { mode: "exclude", levels: [] },
    },
  };

  const sections = await Promise.all(
    BOARD_COLUMNS.map(async (column) => {
      const params = boardRequestParams(scoped, { column });
      params.set("includeTerminal", "true");
      const response = await fetchImpl(uiApiPath(`/api/board?${params.toString()}`));
      if (!response.ok) {
        throw new Error(`Could not load subtasks (GET /api/board returned ${response.status}).`);
      }
      const body = (await response.json()) as { board?: { columns?: Partial<Board> } };
      return (body.board?.columns?.[column] ?? emptySection()).entries;
    }),
  );

  return sections.flat().filter((entry) => entry.item.id !== parentId);
}

/** Turns a caught value into the message the error state shows — never a raw, possibly-unhelpful object. */
export function boardErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the board.";
}
