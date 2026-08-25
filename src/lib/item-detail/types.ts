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
import type {
  AssignmentRole,
  BoardAssignment,
  BoardColumnId,
  HolderType,
  ItemState,
  Liveness,
} from "@/lib/board/types";

export type { AssignmentRole, BoardColumnId, HolderType, ItemState, Liveness };

/**
 * Who holds — or held — this item, in full: everything the ownership block
 * answers *"where is this work actually happening"* with.
 *
 * Extends the board's slim shape rather than restating it, so the two
 * cannot drift on the fields they share. The added columns are the ones a
 * card has no room for and a detail view exists to show.
 */
export interface DetailAssignment extends BoardAssignment {
  readonly id: string;
  readonly machine: string;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly pid: number | null;
  readonly claimedAt: string;
  /** Null while the holder still has it; the moment ownership ended otherwise. */
  readonly releasedAt: string | null;
}

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
  /**
   * The item this review's findings were deferred into. Set only for
   * `lgtm_with_followups` — the verdict that merges on the promise that the
   * outstanding work is filed as its own item — and null for every other.
   * The Reviews tab links it, so the promise is checkable rather than
   * merely stated.
   */
  readonly followUpItemId: string | null;
  /** `person` or `agent` — who produced this artifact. Needed to say "verified by a person" vs "by an agent" on a `historical_verification` (MILESTONES.md #131). */
  readonly createdByType: string;
  /**
   * *Which* person or agent produced it. Null where the column carries no
   * holder id.
   *
   * `createdByType` says a person checked; this says which one, and for a
   * badge whose whole job is "can I trust this state" that is most of the
   * value — an anonymous check is barely distinguishable from no check,
   * because nobody can be asked what they found.
   */
  readonly createdById: string | null;
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
  /**
   * The event's stored one-line BLUF, where it has one. Null on the event
   * types that do not carry one — which is most of them, so a reader must
   * treat its absence as ordinary rather than as a missing field.
   */
  readonly headline: string | null;
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
  /**
   * The one-line BLUF (MILESTONES.md #107) — the header's primary line
   * where one exists (see `@/lib/item-headline-display`), and one of the
   * four fields M10 T10's inline edit offers. Absent from earlier
   * detail-view reads (this response has always carried the item's
   * `headline`; only the client-side type omitted it), so
   * `fetchItemDetail` defaults a missing value to `null` the same way it
   * does every other optional field.
   */
  readonly headline: string | null;
  readonly body: string;
  readonly kind: "project" | "task" | "subtask";
  readonly state: string;
  readonly priority: string;
  readonly area: string;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly blockedReason: string | null;
  /**
   * What KIND of thing this is blocked on — and the reason this is modelled
   * separately from `blockedReason` rather than left to the prose.
   *
   * The three values are three different situations with three different
   * readers. `person` is somebody's to unblock and belongs in their queue;
   * `external_process` is nobody's to unblock and only ever resolves when
   * something outside answers; `time` resolves on its own at `unblockAt`
   * and needs no action from anybody at all. Collapsing them into one
   * "blocked" treatment puts the item that needs a decision in the same
   * bucket as the one that is merely waiting for a clock, which makes a
   * blocked list unreadable in exactly the case it matters.
   *
   * Null when the item is not blocked, and — legitimately — when it is
   * blocked but nobody recorded which kind.
   */
  readonly blockedOnType: "person" | "external_process" | "time" | null;
  /** Who must act, set iff `blockedOnType` is `person`. */
  readonly blockedOnPersonId: string | null;
  /** ISO 8601 — when a `time` block lifts. Null for the other two kinds. */
  readonly unblockAt: string | null;
  readonly pauseReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  /**
   * `person` | `source` | `auto` — whether this row's `state` was ever
   * written by this product's own state machine, or arrived by copy from an
   * external store (MILESTONES.md #131). See `@/lib/board/types`'
   * `TrustInfo` for what a `source` origin means for the trust marker.
   */
  readonly originType: "person" | "source" | "auto";
  /**
   * ISO 8601 — when this row was archived, or null while it is live.
   *
   * **This is what decides whether the page offers Archive or Restore**, so
   * it has to be readable here rather than inferred. It was absent from this
   * type for the same reason `headline` above was: `get_item_detail` returns
   * the whole `ItemRecord` and `fetchItemDetail` passes `detail.item` through
   * wholesale, so the field has always been on the wire and only the
   * client-side type omitted it. Widening the type is the entire change.
   *
   * An archived item is still reachable at `/items/{id}` by design —
   * `get_item` and `get_item_detail` apply no archived filter, precisely so a
   * stale link lands somewhere real (see `delete_item`'s header). This page is
   * therefore the one place a person can be standing on an archived row, which
   * makes it the only place a Restore control belongs.
   */
  readonly archivedAt: string | null;
  /** Why it was archived, as given by whoever archived it. Null while live. */
  readonly archivedReason: string | null;
  /**
   * The surviving row this one was archived in favour of, when one was named.
   *
   * Shown beside the archived notice so a reader who arrived by a stale link
   * is sent somewhere live rather than left on a dead end — which is the whole
   * reason `delete_item` records the pointer. It also survives a restore:
   * `restore_item` deliberately does not clear it, because the judgement that
   * this work was taken up elsewhere was still made.
   */
  readonly supersededById: string | null;
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
  /** Who holds it now — live assignments, newest claim first. Empty when nobody does. */
  readonly assignments: readonly DetailAssignment[];
  /**
   * Who held it before — released assignments, most recent first.
   *
   * This is the ownership history, and it is what makes *"who was on this
   * before it stalled"* answerable: nothing else in the payload records a
   * holder that has let go.
   */
  readonly previousHolders: readonly DetailAssignment[];
}
