// The toast's public surface.
//
// `UndoToastHost` and `useUndo` are what other pieces need — the host to
// mount once, the hook to offer an action from anywhere. `UndoToast` is
// exported for its own test and for anyone rendering the affordance
// outside the host; ordinary callers should not need it.
export { UndoToastHost, useUndo, type UndoApi } from "./UndoToastHost";
export { UndoToast, type UndoToastProps } from "./UndoToast";
