// Barrel for the command-line surface MILESTONES.md #39 delivers. See
// `run.ts` for the entry point, `contract.ts` for the shape this surface
// keeps unchanged, and `client.ts` for how it reaches the items API.
export { run, DEPRECATION_WARNING, type RunOptions } from "./run";
export {
  SHIM_STATUSES,
  isShimStatus,
  toShimTask,
  type ShimStatus,
  type ShimTask,
} from "./contract";
export type { FetchLike } from "./client";
