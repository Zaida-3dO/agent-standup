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

// The `blocked`/`paused` required-fields guards (MILESTONES.md #16,
// SCHEMA.md §16) live under `src/lib/service/guards/` with every other
// hand-written guard — re-exported here too, since
// `tests/state-machine-guards-blocked-paused.test.ts` and other established
// callers already import them from this module.
export {
  blockedRequiredFieldsGuard,
  pausedRequiredFieldsGuard,
  BLOCKED_PAUSED_GUARDS,
} from "../guards/blocked-paused";
