// The shape the item-detail view renders — MILESTONES.md #72, over the
// `GET /api/items/{id}/detail` response.
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// the same reason `@/lib/board/types.ts` mirrors `GET /api/board` by hand:
// the front end reaches the service layer only through the adapter's JSON,
// never its modules. Importing the operation's output type here would
// couple every component to how that operation happens to be typed and —
// worse — put a module that transitively imports the database client's
// types onto the client bundle's import graph, which is exactly what
// `npm run check:db-imports` exists to prevent by accident.
//
// Only the fields the view actually renders are modelled; extra keys the
// response carries are ignored rather than fought with.
import type { BoardColumnId, ItemState } from "@/lib/board/types";

export type { BoardColumnId, ItemState };

/** One node of the subtask tree, flat with a depth — see the operation's own note on why flat. */
export interface DetailSubtask {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly kind: "project" | "task" | "subtask";
  readonly state: string;
  readonly priority: string;
  /** Distance from the root item; 1 for a direct child. */
  readonly depth: number;
  /**
   * The column this node's state maps to — `null` for a project, whose own
   * state is a creation leftover (DECISIONS.md §13c). The server decides
   * this; the client never recomputes it.
   */
  readonly column: BoardColumnId | null;
}

/** One artifact against the item — a review, a plan, a commit, a screenshot (SCHEMA.md §6a). */
export interface DetailArtifact {
  readonly id: string;
  readonly kind: string;
  readonly verdict: string | null;
  readonly reviewRound: number;
  readonly commitSha: string | null;
  readonly ref: string | null;
  readonly body: string | null;
  readonly findings: unknown;
  readonly createdAt: string;
}

/** One history entry — an event, with its id already stringified by the server. */
export interface DetailHistoryEntry {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly body: string | null;
  readonly payload: unknown;
}

/** The summary the item was completed with (SCHEMA.md §5a). */
export interface DetailSummary {
  readonly shipped: unknown;
  readonly notDone: unknown;
  readonly userFacing: boolean;
  readonly whatToTest: unknown;
  readonly howVerified: string | null;
  readonly watchFor: unknown;
  readonly finalState: unknown;
  readonly createdAt: string;
}

/** The subset of the item itself the detail header renders. */
export interface DetailItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly body: string;
  readonly kind: "project" | "task" | "subtask";
  readonly state: string;
  readonly priority: string;
  readonly area: string;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly blockedReason: string | null;
  readonly pauseReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/** The whole detail payload, as `GET /api/items/{id}/detail` returns it. */
export interface ItemDetail {
  readonly item: DetailItem;
  /** The item's board column — derived server-side from the subtree for a project. */
  readonly column: BoardColumnId;
  readonly subtasks: readonly DetailSubtask[];
  readonly artifacts: readonly DetailArtifact[];
  readonly history: readonly DetailHistoryEntry[];
  readonly historyTruncated: boolean;
  readonly summary: DetailSummary | null;
}
