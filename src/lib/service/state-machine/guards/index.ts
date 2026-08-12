// Row #17's guards, and the registration side effect that puts them into
// the shared `guardRegistry` (guard.ts) — the same registry rows #16, #18,
// #19 and #21 register into (`service/index.ts`'s own comment: "Rows #16-#19
// and #21 import `guardRegistry` from here to register their guards").
//
// Individual guard modules (`review-requested.ts`, `plan-approval.ts`,
// `evidence-at-tip.ts`) export their `Guard` objects with no side effect of
// their own — a test can import one guard and run it standalone, and #18 can
// import `artifact-tip.ts`'s helpers directly, without either pulling in
// registration. This module is the one place that actually calls
// `guardRegistry.register`, and it is imported for that side effect from
// `service/live.ts`, the composition root every adapter ultimately runs
// through — so registration happens once, on process start, not per call.
import { guardRegistry } from "../guard";
import { evidenceAtTipGuard } from "./evidence-at-tip";
import { planApprovalGuard } from "./plan-approval";
import { reviewRequestedGuard } from "./review-requested";

export { evidenceAtTipGuard } from "./evidence-at-tip";
export { planApprovalGuard } from "./plan-approval";
export { reviewRequestedGuard } from "./review-requested";
export { currentTipCommitSha, hasApproval, latestApprovalAtTip } from "./artifact-tip";

const ARTIFACT_GUARDS = [reviewRequestedGuard, planApprovalGuard, evidenceAtTipGuard];

let registered = false;

/**
 * Registers row #17's guards into `guardRegistry`, exactly once per
 * process.
 *
 * Idempotent on purpose: `guardRegistry.register` throws on a duplicate id
 * (guard.ts — "Throws on a duplicate id rather than silently overwriting"),
 * and Next.js module evaluation is not guaranteed to run a module's top
 * level exactly once per process (route module caching, hot reload in dev).
 * A bare call at module scope would then throw on the *second* evaluation
 * even though nothing about the guards themselves is wrong — the guard
 * `id`s are still unique, only the import happened twice. The flag makes
 * "already registered" a no-op instead of a startup crash.
 */
export function registerArtifactGuards(registry = guardRegistry): void {
  if (registered && registry === guardRegistry) {
    return;
  }
  for (const guard of ARTIFACT_GUARDS) {
    if (!registry.has(guard.id)) {
      registry.register(guard);
    }
  }
  if (registry === guardRegistry) {
    registered = true;
  }
}

registerArtifactGuards();
