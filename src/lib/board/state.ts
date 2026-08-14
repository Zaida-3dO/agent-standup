// The board's load lifecycle — the pure half of `Board.tsx`, split out for
// the same reason `src/lib/profile/state.ts` is: this repo's harness runs
// `environment: "node"` with no DOM, so the fetch shaping and the
// loading/error/loaded branching are only directly testable as plain
// functions. The client component is thin wiring over these.
import type { Board } from "./types";
import { emptyBoard } from "./view";

export type BoardLoadState =
  { status: "loading" } | { status: "error"; message: string } | { status: "loaded"; board: Board };

/**
 * The board from `GET /api/board`. Throws a message fit to show directly —
 * never a raw `Response` or a JSON-parse error, matching `fetchPeople`.
 *
 * **Missing columns are filled in, not trusted.** The server always returns
 * all four (`get_board` builds the record literally), but a component that
 * indexes `board.waiting` on a response missing it would crash on
 * `undefined.map`. Merging over `emptyBoard()` makes a partial response
 * render as empty columns instead of a blank page.
 */
export async function fetchBoard(fetchImpl: typeof fetch = fetch): Promise<Board> {
  const response = await fetchImpl("/api/board");
  if (!response.ok) {
    throw new Error(`Could not load the board (GET /api/board returned ${response.status}).`);
  }
  const body = (await response.json()) as { board?: Partial<Board> };
  return { ...emptyBoard(), ...(body.board ?? {}) };
}

/** Turns a caught value into the message the error state shows — never a raw, possibly-unhelpful object. */
export function boardErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the board.";
}
