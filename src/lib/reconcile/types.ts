// Shapes shared between the pure matcher (shipped-rows.ts) and its two
// callers: the CLI script (scripts/reconcile-shipped-rows.mjs) and its
// tests. Deliberately minimal — only the fields the matcher reads, not the
// full `Item` or `gh pr list` record, so a schema change on either side
// only breaks this file if it touches a field actually used here.

/** The slice of a board row this module needs. */
export interface ReconcilableItem {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly priority: string;
}

/** The slice of `gh pr list --json ...` this module needs. */
export interface MergedPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly url: string;
  /** ISO 8601, or null if `gh` did not report one. */
  readonly mergedAt: string | null;
}

export interface ReconciliationInput {
  readonly items: readonly ReconcilableItem[];
  readonly mergedPullRequests: readonly MergedPullRequest[];
}

export type ReconciliationConfidence = "high";
export type ReconciliationReason = "id-in-merged-pr";

export interface ReconciliationCandidate {
  readonly item: ReconcilableItem;
  readonly confidence: ReconciliationConfidence;
  readonly reason: ReconciliationReason;
  /** Every merged PR that referenced this row's id, newest first. */
  readonly evidence: readonly MergedPullRequest[];
}
