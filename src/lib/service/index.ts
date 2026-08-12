// The service layer: the only way into the rules. See docs/plans/SCHEMA.md §22.
//
// Adapters import from here and from nowhere deeper. `live.ts` is
// deliberately *not* re-exported: it is the composition root and reaching
// the database client happens there, so an adapter that wants the running
// service imports it by name and a reviewer sees that in the diff.
export {
  ConflictError,
  ForbiddenError,
  GuardRejectedError,
  InternalError,
  InvalidInputError,
  NotFoundError,
  NotImplementedError,
  SERVICE_ERROR_CODES,
  ServiceError,
  isServiceError,
  toServiceError,
  type Rejection,
  type ServiceErrorCode,
  type ServiceErrorOptions,
} from "./errors";

export {
  defineOperation,
  type AnyOperation,
  type Operation,
  type OperationKind,
  type ParsesInput,
} from "./operation";

export type { Caller, ServiceContext, TransactionHandle } from "./context";

export {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  describeOperations,
  getOperation,
  isOperationName,
  listOperations,
  operationsOfKind,
  type OperationInput,
  type OperationName,
  type OperationOutput,
  type OperationRegistry,
} from "./registry";

export {
  ServiceRuntime,
  prismaTransactionRunner,
  type CallOptions,
  type ServiceRuntimeOptions,
  type TransactionCapableClient,
} from "./runtime";

export type { OperationDescriptor, ServiceInfo, ServiceInfoInput } from "./operations/service-info";

// Hand-written guards (MILESTONES.md #16-#19, #21-#22). Importing
// `ALL_GUARDS` from here is what registers them into `guardRegistry` — see
// `guards/index.ts`'s header for why that is a deliberate side effect of the
// import rather than a separate wiring step.
export {
  ALL_GUARDS,
  BLOCKED_PAUSED_GUARDS,
  DEFERRAL_FOLLOW_UP_GUARD_ID,
  DEFERRAL_REASONS_REQUIRING_ITEM,
  SUMMARY_REQUIRED_GUARD_ID,
  blockedRequiredFieldsGuard,
  currentTipCommitSha,
  deferralFollowUpGuard,
  evidenceAtTipGuard,
  findSimilarityIssues,
  hasApproval,
  hierarchyGuard,
  latestApprovalAtTip,
  pausedRequiredFieldsGuard,
  planApprovalGuard,
  reviewRequestedGuard,
  summaryRequiredGuard,
  MERGE_GUARDS,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresAuthorisationGuard,
  mergeRequiresCommitGuard,
  mergeRequiresVisualReviewGuard,
  currentReviewRound,
  hasApprovingArtifactAtCurrentRound,
  hasApprovingArtifactAtCurrentRoundAndTip,
} from "./guards";

// The state machine (MILESTONES.md #15). Rows #16-#19 and #21 import
// `guardRegistry` from here to register their guards; row #27 imports
// `rehearseTransition`/`applyTransition` to build the routed operation.
export {
  ITEM_STATES,
  GuardRegistry,
  ProjectHasNoStateError,
  allStatePairs,
  applyTransition,
  guardOk,
  guardRegistry,
  guardRejected,
  isItemState,
  loadItemForTransition,
  rehearseTransition,
  runGuards,
  type AppliedTransition,
  type Guard,
  type GuardInput,
  type GuardResult,
  type GuardableItem,
  type ItemStateValue,
  type TransitionOutcome,
  type TransitionRequest,
} from "./state-machine";

export type { ItemRecord } from "./items/row";
export type { CreateItemInput } from "./operations/create-item";
export type { GetItemInput } from "./operations/get-item";
export type { UpdateItemInput } from "./operations/update-item";
export type { ListItemsInput, ListItemsOutput } from "./operations/list-items";
export type { GetSettingsInput, GetSettingsOutput } from "./operations/get-settings";
export type { GetSettingInput } from "./operations/get-setting";
export type { PatchSettingsInput, PatchSettingsOutput } from "./operations/patch-settings";
export type { PutSettingInput } from "./operations/put-setting";
export type { DeleteSettingInput } from "./operations/delete-setting";
export type { RenderedSetting } from "./operations/settings-shared";
export type { ClaimOperationInput } from "./operations/claim";
export type { ReleaseOperationInput } from "./operations/release";
export type { HeartbeatOperationInput } from "./operations/heartbeat";
export type { CheckpointOperationInput } from "./operations/checkpoint";
export type { NoteOperationInput } from "./operations/note";
export type {
  OrientationInput,
  OrientationOutput,
  OrientationCheckpoint,
  OpenLoopChild,
  OpenLoopNotDone,
} from "./operations/orientation";
export type { MyWorkInput, MyWorkOutput, MyWorkEntry } from "./operations/my-work";

// Transition and complete (MILESTONES.md #27): the service calls and their
// routes, over row #15's state machine. `RehearsalRollback` is exported so
// the HTTP route (the only intended catcher) can recognise it without a
// second copy of the class living outside the service layer.
export {
  transitionItem,
  type AppliedTransitionOutcome,
  type TransitionItemInput,
  type TransitionItemResult,
} from "./operations/transition-item";
export {
  completeItem,
  type CompleteItemInput,
  type CompleteItemResult,
} from "./operations/complete-item";
export { RehearsalRollback, isRehearsalRollback } from "./operations/rehearsal-rollback";

// Summaries (MILESTONES.md #21): the static validators row #27's
// transition-and-complete operation will call directly. The guard itself
// (`summaryRequiredGuard`, `SUMMARY_REQUIRED_GUARD_ID`,
// `findSimilarityIssues`) is exported above, from `./guards` — it lives
// there now so `tests/guards-registration.test.ts` covers it like every
// other hand-written guard.
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
} from "./summaries";

export type { GetBoardInput, BoardOutput, BoardEntry } from "./operations/get-board";
export type { ListPeopleInput, ListPeopleOutput, PersonRecord } from "./operations/list-people";
export {
  BOARD_COLUMNS,
  STATES_BY_COLUMN,
  columnForProject,
  columnForState,
  type BoardColumn,
} from "./board/columns";
