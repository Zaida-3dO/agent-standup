// The state machine. See docs/plans/MILESTONES.md #15, SCHEMA.md §16.
export { ITEM_STATES, allStatePairs, isItemState, type ItemStateValue } from "./states";

export {
  GuardRegistry,
  guardOk,
  guardRegistry,
  guardRejected,
  runGuards,
  type Guard,
  type GuardInput,
  type GuardResult,
  type GuardableItem,
} from "./guard";

export {
  ProjectHasNoStateError,
  applyTransition,
  loadItemForTransition,
  rehearseTransition,
  type AppliedTransition,
  type TransitionOutcome,
  type TransitionRequest,
} from "./transition";

// Row #16's guards — required fields for `blocked`/`paused`. See
// docs/plans/MILESTONES.md #16, SCHEMA.md §16.
export {
  blockedRequiredFieldsGuard,
  pausedRequiredFieldsGuard,
  BLOCKED_PAUSED_GUARDS,
} from "./guards/blocked-paused";
export { registerBlockedPausedGuards } from "./guards/register";
