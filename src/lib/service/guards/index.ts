// Registers every hand-written guard into `guardRegistry`
// (`state-machine/guard.ts`). See docs/plans/MILESTONES.md #16-#19, #21.
//
// Written out rather than assembled by scanning the directory at runtime —
// same reasoning as `registry.ts`'s operation list: a glob would make
// "every guard is registered" true by construction and untestable, and it
// does not survive bundling. `tests/guards-registration.test.ts` reads this
// directory from source and asserts every guard file it finds is registered
// here, which is the test-side half of the same guarantee `registry.ts`
// gets from `tests/service-registry.test.ts`.
//
// Importing this module is what actually populates `guardRegistry` — a
// guard file alone only *defines* its `Guard` object, it does not register
// itself as a side effect of being imported for its type. Whatever wires the
// running service (a later row, once `live.ts` or an adapter needs guards to
// actually run) imports this module once, for its side effect, before the
// first transition.
import { guardRegistry } from "../state-machine/guard";
import { hierarchyGuard } from "./hierarchy";

/** Every hand-written guard, in the order it registers. */
export const ALL_GUARDS = [hierarchyGuard] as const;

for (const guard of ALL_GUARDS) {
  if (!guardRegistry.has(guard.id)) {
    guardRegistry.register(guard);
  }
}

export { hierarchyGuard } from "./hierarchy";
