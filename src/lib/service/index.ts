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
  INTERNAL_KINDS,
  SERVICE_ERROR_CODES,
  SERVICE_FAULTS,
  ServiceError,
  classifyCause,
  faultFor,
  isServiceError,
  toServiceError,
  type InternalKind,
  type Rejection,
  type ServiceErrorCode,
  type ServiceErrorOptions,
  type ServiceFault,
} from "./errors";

// The context every log line about a refusal carries, so the five places
// that write one cannot drift about what a failure is called.
export { faultContext } from "./fault-context";

// A read that will not fit refuses rather than overflowing the caller it was
// read in (MILESTONES.md #115). Exported so an adapter can name the ceiling
// and a test can assert against it rather than restating the number.
export {
  MAX_RESPONSE_CHARS,
  RESPONSE_TOO_LARGE_GUARD,
  enforceResponseSize,
  responseSize,
  responseTooLargeMessage,
} from "./response-size";

export {
  defineOperation,
  type AnyOperation,
  type Operation,
  type OperationContract,
  type OperationKind,
  type OperationRule,
  type ParsesInput,
} from "./operation";

// Tool documentation on demand (MILESTONES.md #111): the operation, and the
// schema walk that derives its field list from the schema a call is actually
// rejected by.
export {
  describeTool,
  type DescribeToolInput,
  type ToolContract,
} from "./operations/describe-tool";
export { describeFields, type FieldDescriptor } from "./describe/fields";

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
  type ShapeFinding,
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
export type { SearchInput, SearchOutput, SearchMatch } from "./operations/search";
export type { GetSettingsInput, GetSettingsOutput } from "./operations/get-settings";
export type { GetSettingInput } from "./operations/get-setting";
export type { PatchSettingsInput, PatchSettingsOutput } from "./operations/patch-settings";
export type { PutSettingInput } from "./operations/put-setting";
export type { DeleteSettingInput } from "./operations/delete-setting";
export type { RenderedSetting } from "./operations/settings-shared";
export type { ClaimOperationInput } from "./operations/claim";
export type { ReleaseOperationInput } from "./operations/release";
// Reclamation (MILESTONES.md #99). `sweep` gives the liveness ladder a
// caller; `takeover` displaces a holder the ladder is not going to release.
export type { SweepOperationInput, SweepOperationOutput } from "./operations/sweep";
export type { TakeoverOperationInput } from "./operations/takeover";
export type { HeartbeatOperationInput } from "./operations/heartbeat";
export type { CheckpointOperationInput } from "./operations/checkpoint";
export type { NoteOperationInput } from "./operations/note";
export type { LoopAddInput, LoopAdded, LoopCloseInput } from "./operations/open-loops";
export type {
  RecordArtifactInput,
  RecordedArtifact,
  RequestReviewInput,
} from "./operations/record-artifact";
export type {
  OrientationInput,
  OrientationOutput,
  OrientationCheckpoint,
  OpenLoopChild,
  OpenLoopNotDone,
} from "./operations/orientation";
export type { MyWorkInput, MyWorkOutput, MyWorkEntry } from "./operations/my-work";
export type { GetCrewNameInput } from "./operations/get-crew-name";

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

// The hook decision (MILESTONES.md #125). The hook script reports an event
// and renders the answer; this operation is the only party that decides
// anything, because every rule worth having is conditional on state a
// script cannot see.
export {
  hookDecision,
  HOOK_DECISIONS,
  type HookDecision,
  type HookDecisionOperationInput,
  type HookDecisionOperationOutput,
} from "./operations/hook-decision";

// Telemetry ingest (MILESTONES.md #50). The record shape and the caps live
// in `@/lib/telemetry/contract` rather than here or in the operation: the
// hook's spool (#88) imports the same module, so there is one definition
// both halves speak and no way for them to disagree.
export {
  recordToolCalls,
  MAX_BATCH_SIZE,
  type RecordToolCallsInput,
  type RecordToolCallsOutput,
  type RunTouch,
} from "./operations/record-tool-calls";

// Session shape (MILESTONES.md #54): the read side of the rows above. The
// judgement is in `@/lib/telemetry/shape`, which is pure and knows nothing
// about a database — this exports the operation that feeds it rows.
export {
  getSessionShape,
  DEFAULT_SHAPE_WINDOW,
  MAX_SHAPE_WINDOW,
  type GetSessionShapeInput,
  type GetSessionShapeOutput,
} from "./operations/get-session-shape";

// Cost aggregation (MILESTONES.md #53). The totals are recomputed from the
// stored token counts at the configured rates rather than summed from the
// stored `cost` column — see the operation's header for why a summed total
// corresponds to no price table that ever existed.
export {
  getCosts,
  fold,
  COST_GROUPINGS,
  DEFAULT_COST_GROUPS,
  MAX_COST_GROUPS,
  type CostGroup,
  type CostGrouping,
  type GetCostsInput,
  type GetCostsOutput,
} from "./operations/get-costs";

// The fleet-wide timeline (T19) — the ledger read backwards and filtered.
export {
  getActivity,
  SLIM_ACTIVITY_COLUMNS,
  FULL_ACTIVITY_COLUMNS,
  type ActivityEvent,
  type ActivityEventFull,
  type GetActivityInput,
  type GetActivityOutput,
} from "./operations/get-activity";

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
// Ownership as the reads return it (MILESTONES.md M10 T3). The two shapes
// live in one module so the board's slim form and the detail view's full
// form cannot drift on the fields they share.
export type { BoardAssignment, ItemDetailAssignment } from "./items/assignment-view";
export type {
  GetItemDetailInput,
  ItemDetailOutput,
  ItemDetailArtifact,
  ItemDetailHistoryEntry,
  ItemDetailSubtaskNode,
  ItemDetailSummary,
} from "./operations/get-item-detail";
export type { ListPeopleInput, ListPeopleOutput, PersonRecord } from "./operations/list-people";
export {
  BOARD_COLUMNS,
  STATES_BY_COLUMN,
  columnForProject,
  columnForState,
  type BoardColumn,
} from "./board/columns";
