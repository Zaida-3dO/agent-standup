// Summaries: shape, caps, reject-don't-truncate, similarity check, jargon
// denylist. See docs/plans/MILESTONES.md #21, SCHEMA.md §5, §5a.
export {
  ALL_CAPS_PREFIXES,
  HOW_VERIFIED_CHAR_CAP,
  JARGON_TERMS,
  NOT_DONE_MAX,
  NOT_DONE_MIN,
  NOT_DONE_REASONS,
  NOT_DONE_TEXT_CHAR_CAP,
  SHIPPED_CHAR_CAP,
  SHIPPED_MAX,
  SHIPPED_MIN,
  SIMILARITY_REJECT_AT,
  WATCH_FOR_CHAR_CAP,
  WATCH_FOR_MAX,
  WHAT_TO_TEST_MAX,
  WHAT_TO_TEST_MIN,
  WHAT_TO_TEST_TEXT_CHAR_CAP,
  findJargonHits,
  isTooSimilar,
  jaccardSimilarity,
  validateSummaryShape,
  type NotDoneEntry,
  type NotDoneReason,
  type SummaryCandidate,
  type SummaryValidationIssue,
  type WhatToTestEntry,
} from "./validate";

// The guard itself now lives at `../guards/summaries.ts`, alongside every
// other hand-written guard (MILESTONES.md #16-#19), so it is covered by
// `tests/guards-registration.test.ts`'s canonicalisation sweep — a guard
// declared outside `src/lib/service/guards/` is invisible to that test.
// Re-exported here too so `@/lib/service/summaries` stays the one place to
// import everything this row delivers, shape and guard alike.
export {
  SUMMARY_REQUIRED_GUARD_ID,
  findSimilarityIssues,
  summaryRequiredGuard,
} from "../guards/summaries";
