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
  /**
   * The one-line BLUF (MILESTONES.md #107) — what this work *is*, shown on
   * the card without expanding. Null on an item nobody has written one for,
   * which the card renders as nothing rather than as an empty line.
   */
  readonly headline: string | null;
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

/**
 * The four liveness values, as the API sends them (SCHEMA.md §2).
 *
 * All four are distinct and none is a synonym for another: `running` is a
 * session still working, `stalled` one that has stopped reporting but may
 * come back, `dead` one known to be gone, and `superseded` one a takeover
 * deliberately replaced. A presence dot that mapped `superseded` onto `dead`
 * would report a normal handover as a failure, so the vocabulary is carried
 * through to the UI intact rather than collapsed on the way.
 */
export type Liveness = "running" | "stalled" | "dead" | "superseded";

/** The roles an assignment can hold, as the API sends them (SCHEMA.md §2). */
export type AssignmentRole =
  "orchestrator" | "builder" | "reviewer" | "visual_reviewer" | "scout" | "custom";

export type HolderType = "person" | "agent";

/**
 * Who holds an item, as a **card** shows it — the slim shape `GET
 * /api/board` returns per entry.
 *
 * Seven scalars, and no `machine`/`branch`/`worktree`/`model`/`session`:
 * those are on the detail response, which returns one item rather than a
 * page of them. A card that wanted them would be asking the board read to
 * carry seven more columns per card.
 */
export interface BoardAssignment {
  readonly holderId: string;
  readonly holderType: HolderType;
  /** Already resolved server-side — a person's display name, or an agent's crew name. Safe to render directly. */
  readonly displayName: string;
  readonly role: AssignmentRole;
  /** The free-text role name, set iff `role` is `custom`. */
  readonly roleCustom: string | null;
  readonly liveness: Liveness;
  /** ISO 8601 — what a "last active 40m ago" label is computed from. */
  readonly lastActive: string;
}

/** One entry in a column, as `GET /api/board` returns it. */
export interface BoardEntry {
  readonly item: BoardItem;
  readonly column: BoardColumnId;
  /**
   * Who holds this item — live assignments only, in claim order.
   *
   * **Empty means nobody holds it**, and the API always sends the key, so a
   * card can render presence from this alone without a second call. An array
   * rather than one holder because an item can be held by an orchestrator
   * and a builder and two reviewers at once (SCHEMA.md §2).
   */
  readonly assignments: readonly BoardAssignment[];
}

/**
 * One column as the API returns it — a page of entries, plus the count of
 * everything in the column (MILESTONES.md #109, #123).
 *
 * `total` is the number the heading renders, and it is emphatically **not**
 * `entries.length`. The two differ whenever the column is paginated, and
 * they differ most on exactly the columns where the count matters: a
 * withheld column has no entries and a real total, and rendering the length
 * there is #123's "completed reads 0 while 175 items are completed".
 */
export interface BoardSection {
  readonly entries: readonly BoardEntry[];
  /** Every item in this column, not just the ones on this page. */
  readonly total: number;
  /** Pass back to page this column further; null when there is no more. */
  readonly nextCursor: string | null;
  /** True when this column was not fetched — `entries` is empty by omission, not by absence. */
  readonly withheld: boolean;
}

/** The whole board: every column, always present, possibly empty or withheld. */
export type Board = Readonly<Record<BoardColumnId, BoardSection>>;
