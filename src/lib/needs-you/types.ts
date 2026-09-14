// The shape `/needs-you` renders — over `GET /api/needs-you`
// (`get_needs_you`), the purpose-built read that owns the admission rule.
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// the same reason `@/lib/board/types.ts` mirrors `GET /api/board` by hand
// — see that file's header. `ItemRecord` (the `full: true` shape) carries
// far more than an inbox row draws; only what is used is modelled here.

/**
 * Why an item is in the inbox — the four kinds the task names, never merged
 * into one label.
 *
 * The distinction is the whole design: each of these is waiting on a
 * *different act*, satisfied by a *different artifact*, and so earns a
 * different control. See `RESPONSE_KIND_BY_REASON` (`./respond.ts`) for the
 * mapping, and that module's header for why a single generic "reply" box
 * across all four would be the wrong answer.
 */
export type NeedsYouReason =
  "blocked_on_you" | "needs_approval" | "needs_visual_review" | "plan_review";

/** One item on the inbox, with just what a row and its response affordance need. */
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
  /** Whether someone still has to look at this. */
  readonly needsVisualReview: boolean;
  /**
   * The commit a decision on this item applies to, as the server derived it
   * — `null` when the item has recorded no commit at all.
   *
   * Carried rather than derived here: a `merge_approval` must name the sha
   * it approves, and `null` is what tells the screen it cannot offer that
   * control instead of firing a write the server will refuse. See the
   * server-side field's own doc in `get-needs-you.ts`.
   */
  readonly tipCommitSha: string | null;
}
