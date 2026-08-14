// The shape the board UI renders — MILESTONES.md #37, over the `GET /board`
// response #36 produces.
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// the same reason `@/lib/profile/types.ts` mirrors `GET /api/people` by
// hand: the front end reaches the service layer only through the adapter's
// JSON, never its modules. Importing `BoardOutput` here would couple every
// component to how the operation that produces it happens to be typed —
// and, worse, put a module that transitively imports the database client's
// types on the client bundle's import graph, which is exactly what
// `npm run check:db-imports` exists to keep from happening by accident.
//
// Only the fields the board actually renders are modelled. The API returns
// the whole `ItemRecord`; a card that needs another column later adds it
// here, and the extra keys the response already carries are ignored rather
// than fought with.

/** The four derived columns, in board order — SCHEMA.md §1.1. */
export const BOARD_COLUMNS = ["backlog", "in_progress", "waiting", "completed"] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number];

/** The eleven-value `state` vocabulary, as the API sends it (SCHEMA.md §1.1). */
export type ItemState =
  | "someday"
  | "on_deck"
  | "planning"
  | "plan_review"
  | "executing"
  | "in_review"
  | "paused"
  | "blocked"
  | "merged"
  | "research_done"
  | "wont_do"
  | "cancelled";

/** The subset of an item the board renders. */
export interface BoardItem {
  readonly id: string;
  readonly title: string;
  readonly kind: "project" | "task" | "subtask";
  /**
   * The item's own stored state. Present on a project too, where it is a
   * creation leftover and NOT the project's column — `get-board.ts` says so
   * outright, so the tone helpers below refuse to read it for a project.
   */
  readonly state: string;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly area: string;
  readonly repo: string | null;
  /** Who must act, when `state` is `blocked` and the blocker is a person. */
  readonly blockedOnPersonId: string | null;
  readonly blockedOnType: "person" | "external_process" | "time" | null;
  readonly blockedReason: string | null;
  readonly pauseReason: string | null;
}

/** One entry in a column, as `GET /api/board` returns it. */
export interface BoardEntry {
  readonly item: BoardItem;
  readonly column: BoardColumnId;
}

/** The whole board: every column, always present, possibly empty. */
export type Board = Readonly<Record<BoardColumnId, readonly BoardEntry[]>>;
