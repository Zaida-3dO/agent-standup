// The shared region-state components, re-exported as one import site.
//
// Four other surfaces need these, and the reason to have one entry point is
// the same reason the components exist: the states are only useful if they
// are the SAME states everywhere. A caller reaching for the empty state and
// finding the error state beside it is a caller who renders both, rather
// than one who renders an empty region on a failed read.
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { ErrorState, type ErrorStateProps } from "./ErrorState";
export { LoadingState, type LoadingStateProps } from "./LoadingState";
export { emptinessOf, type EmptyKind, type EmptinessInput } from "@/lib/states/empty";
