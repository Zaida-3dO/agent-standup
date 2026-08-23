// Registers every hand-written guard into `guardRegistry`
// (`state-machine/guard.ts`). See docs/plans/MILESTONES.md #16-#19, #21-#22.
//
// Every hand-written guard lives directly under this directory — one home,
// not two — so a new contributor never has to guess where a guard belongs,
// and `tests/guards-registration.test.ts`'s canonicalisation sweep (which
// reads this directory from source) sees every guard in the repository, not
// a subset of them.
//
// Written out rather than assembled by scanning the directory at runtime —
// same reasoning as `registry.ts`'s operation list: a glob would make
// "every guard is registered" true by construction and untestable, and it
// does not survive bundling. `tests/guards-registration.test.ts` reads this
// directory from source and asserts every guard file it finds is registered
// here, which is the test-side half of the same guarantee `registry.ts`
// gets from `tests/service-registry.test.ts`.
//
// Importing this module is what actually populates `guardRegistry` — a
// guard file alone only *defines* its `Guard` object, it does not register
// itself as a side effect of being imported for its type. `live.ts`, the
// composition root, imports this module once, for its side effect, before
// the first transition.
import { guardRegistry } from "../state-machine/guard";
import { blockedRequiredFieldsGuard, pausedRequiredFieldsGuard } from "./blocked-paused";
import { deferralFollowUpGuard } from "./deferral";
import { evidenceAtTipGuard } from "./evidence-at-tip";
import { hierarchyGuard } from "./hierarchy";
import {
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresAuthorisationGuard,
  mergeRequiresCommitGuard,
  mergeRequiresLinkedFollowUpGuard,
  mergeRequiresVisualReviewGuard,
} from "./merge";
import { planApprovalGuard } from "./plan-approval";
import { reviewRequestedGuard } from "./review-requested";
import { summaryRequiredGuard } from "./summaries";

/** Every hand-written guard, in the order it registers. */
export const ALL_GUARDS = [
  blockedRequiredFieldsGuard,
  pausedRequiredFieldsGuard,
  reviewRequestedGuard,
  planApprovalGuard,
  evidenceAtTipGuard,
  hierarchyGuard,
  mergeRequiresCommitGuard,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresVisualReviewGuard,
  mergeRequiresAuthorisationGuard,
  mergeRequiresLinkedFollowUpGuard,
  summaryRequiredGuard,
  deferralFollowUpGuard,
] as const;

for (const guard of ALL_GUARDS) {
  if (!guardRegistry.has(guard.id)) {
    guardRegistry.register(guard);
  }
}

export {
  blockedRequiredFieldsGuard,
  pausedRequiredFieldsGuard,
  BLOCKED_PAUSED_GUARDS,
} from "./blocked-paused";
export {
  currentTipCommitSha,
  hasApproval,
  latestApprovalAtTip,
  tipCommitLineage,
} from "./artifact-tip";
export {
  MERGE_OVERRIDE_KIND,
  MIN_REASON_LENGTH,
  mergeOverrideSatisfies,
  type MergeOverrideOutcome,
} from "./merge-override";
export {
  HISTORICAL_VERIFICATION_KIND,
  historicalVerificationSatisfies,
  type HistoricalVerificationOutcome,
} from "./historical-verification";
export {
  HISTORICAL_VERIFICATION_ENABLED_VALUE,
  HISTORICAL_VERIFICATION_ENV_VAR,
  historicalVerificationStartupWarning,
  isHistoricalVerificationEnabled,
} from "./historical-verification-enabled";
export { evidenceAtTipGuard } from "./evidence-at-tip";
export { hierarchyGuard } from "./hierarchy";
export {
  MERGE_GUARDS,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresAuthorisationGuard,
  mergeRequiresCommitGuard,
  mergeRequiresLinkedFollowUpGuard,
  mergeRequiresVisualReviewGuard,
} from "./merge";
export {
  approvingArtifactAtCurrentRoundAndTip,
  currentReviewRound,
  hasApprovingArtifactAtCurrentRound,
  hasApprovingArtifactAtCurrentRoundAndTip,
} from "./merge-review-round";
export { planApprovalGuard } from "./plan-approval";
export { reviewRequestedGuard } from "./review-requested";
export { SUMMARY_REQUIRED_GUARD_ID, findSimilarityIssues, summaryRequiredGuard } from "./summaries";
export {
  DEFERRAL_FOLLOW_UP_GUARD_ID,
  DEFERRAL_REASONS_REQUIRING_ITEM,
  deferralFollowUpGuard,
  findNotDoneProofIssues,
  type NotDoneProofIssue,
} from "./deferral";
