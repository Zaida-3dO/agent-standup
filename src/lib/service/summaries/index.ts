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

export {
  SUMMARY_REQUIRED_GUARD_ID,
  findSimilarityIssues,
  registerSummaryGuard,
  summaryRequiredGuard,
} from "./guard";
