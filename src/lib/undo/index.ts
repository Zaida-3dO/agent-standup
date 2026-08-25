// The undo module's public surface — T18's fourth piece.
//
// Deliberately a barrel: T6-E (bulk actions) and the command palette are
// the callers this is being landed ahead of, and both should import from
// `@/lib/undo` rather than reaching into a file whose name may change.
export {
  UNDO_WINDOW_MS,
  canUndo,
  inverseOf,
  isWithinWindow,
  remainingMs,
  type ItemMove,
  type UndoPlan,
  type UndoStep,
  type UndoableAction,
} from "./actions";
export { describeAction, itemCount, stateLabel } from "./describe";
export { runUndo, staleMessage, type UndoOutcome } from "./request";
export {
  actionOffered,
  dismissed,
  idleToast,
  ticked,
  undoPressed,
  undoSettled,
  type UndoToastState,
} from "./state";
