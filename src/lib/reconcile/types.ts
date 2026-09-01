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
  /** Null when nobody has written one, same as `ItemSummaryRecord`. */
  readonly headline: string | null;
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

// ── Cross-row citations (citations.ts) ──────────────────────────────────
//
// A second, independent signal from the one above, over a different source.
// `shipped-rows.ts` reads a forge's merged pull requests; this reads the
// artifacts this product already stores. They are kept apart rather than
// merged into one shape because their evidence is genuinely different — a
// pull request has a number and a url, an artifact has a kind and a sha —
// and collapsing both into a lowest-common-denominator record would lose
// the field that makes each one worth reading.

/** The slice of a board row the citation matcher needs. */
export interface CitableItem {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly headline: string | null;
  /** Null when the row has no repo set, which is common and not an error. */
  readonly repo: string | null;
  readonly priority: string | null;
  /** ISO 8601 of the row's last write, for judging how long it has sat. */
  readonly updatedAt: string | null;
}

/** The slice of an `Artifact` row the citation matcher reads. */
export interface CitedArtifact {
  readonly id: string;
  /** The row this artifact was recorded AGAINST — never the row it cites. */
  readonly itemId: string;
  readonly kind: string;
  readonly body: string | null;
  readonly ref: string | null;
  readonly commitSha: string | null;
  readonly createdAt: string | null;
  /** Denormalised for the report, so a reader need not look the row up. */
  readonly itemTitle?: string | null;
  readonly itemState?: string | null;
}

export interface CitationInput {
  readonly items: readonly CitableItem[];
  readonly artifacts: readonly CitedArtifact[];
}

/** One citing artifact, flattened for the report. */
export interface CitationEvidence {
  readonly artifactId: string;
  /** The row whose artifact carried the citation. */
  readonly citedBy: string;
  readonly citedByTitle: string | null;
  readonly citedByState: string | null;
  readonly kind: string;
  readonly commitSha: string | null;
  readonly ref: string | null;
  readonly createdAt: string | null;
}

export type CitationConfidence = "high" | "medium";
export type CitationReason = "cited-by-another-rows-artifact";

export interface CitationCandidate {
  readonly item: CitableItem;
  readonly confidence: CitationConfidence;
  readonly reason: CitationReason;
  /** Every artifact from another row that cited this one, newest first. */
  readonly evidence: readonly CitationEvidence[];
}
