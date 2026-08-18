// Where a folded route sends its reader.
//
// A named constant rather than a string literal in the route file, so the
// destination is one thing a test can assert against the route map. A
// redirect whose target is not a real route is a 404 reachable only by
// following the redirect, so nothing surfaces it until a reader hits it —
// asserting the target against `NAV_ROUTES` surfaces it in CI instead.
import { NAV_ROUTES } from "./routes";

/**
 * `/since` folded into the activity ledger.
 *
 * Both addresses name one read of one event stream — narrowed to "since
 * you last looked", or not narrowed at all — so they are one screen with a
 * filter rather than two screens, each with its own idea of what you have
 * seen. `tests/nav-redirects.test.ts` asserts this names a real
 * destination.
 */
export const SINCE_REDIRECT_TARGET = "/activity";

/** True when every folded route's target is a destination the sidebar can reach. */
export function redirectTargetIsRoutable(target: string): boolean {
  return NAV_ROUTES.some((route) => route.href === target);
}
