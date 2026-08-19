// The shape `/needs-you` renders — over `GET /api/items` (`list_items`),
// the same endpoint the rest of the front end already reaches the item
// store through.
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// the same reason `@/lib/board/types.ts` mirrors `GET /api/board` by hand
// — see that file's header. `ItemRecord` (the `full: true` shape) carries
// far more than an inbox row draws; only what is used is modelled here.

/** Why an item is in the inbox — the three kinds the task names, never merged into one label. */
export type NeedsYouReason = "blocked_on_you" | "needs_approval" | "plan_review";

/** One item on the inbox, with just what a row and its decide affordance need. */
export interface NeedsYouItem {
  readonly id: string;
  readonly title: string;
  readonly headline: string | null;
  readonly state: string;
  readonly reason: NeedsYouReason;
  /** The reader's own words for why it's waiting, when there is one — `blockedReason` on a blocked item. */
  readonly blockedReason: string | null;
  /** ISO 8601 — when the item last changed. What "how long it's waited" is computed from. */
  readonly updatedAt: string;
  readonly mergeAuthority: "pre_approved" | "needs_approval" | "agent_judgement";
}
