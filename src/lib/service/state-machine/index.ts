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
