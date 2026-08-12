// Installs this row's guards into the shared registry. See guard.ts's own
// header for why a class instance rather than a module-level array: the
// production singleton (`guardRegistry`, exported from `../guard`) is what a
// real transition runs against by default, so it has to actually hold these
// two guards before `applyTransition`/`rehearseTransition` are called for
// real. `live.ts` — the composition root, the one module guaranteed to load
// before any adapter can reach the service layer — imports this for its
// side effect.
//
// A function rather than importing-for-side-effect at module scope: a test
// building its own scratch `GuardRegistry` (the pattern every existing
// state-machine test uses) can call `registerBlockedPausedGuards(reg)` to
// install exactly these two guards into its own registry, without also
// mutating the shared singleton — and the shared singleton itself is
// populated by the one call in `live.ts` passing no argument.
import { guardRegistry, type GuardRegistry } from "../guard";
import { BLOCKED_PAUSED_GUARDS } from "./blocked-paused";

export function registerBlockedPausedGuards(registry: GuardRegistry = guardRegistry): void {
  for (const guard of BLOCKED_PAUSED_GUARDS) {
    if (!registry.has(guard.id)) {
      registry.register(guard);
    }
  }
}
