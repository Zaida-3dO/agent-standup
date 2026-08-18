// What `/` shows.
//
// The root is a *choice* rather than a page: the organising principle of
// this product is projects, and the daily job is triage, and those two
// facts want different first screens. Rather than settle that by argument,
// `ui.default_landing` settles it by use — see the setting's own help text.
//
// This module is the consuming half. It reads a stored value that may be
// anything at all (an old value, a hand-edited override row, a typo through
// the API) and answers with a destination that certainly exists.
import { NAV_ROUTES, type NavId, type NavRoute } from "./routes";

/**
 * The destinations `/` may resolve to.
 *
 * A closed subset of the nav ids, not all of them: `/settings` and `/cost`
 * are places you go with a question, and landing there every morning would
 * be a configuration mistake the reader has to undo before they can start.
 * Mirrors the setting's own `z.enum`; `tests/nav-landing.test.ts` asserts
 * the two lists agree, so widening one without the other fails rather than
 * silently accepting a value this module then rejects.
 */
export const LANDING_CHOICES = ["standup", "projects", "board", "needs-you"] as const;

export type LandingChoice = (typeof LANDING_CHOICES)[number];

export const DEFAULT_LANDING: LandingChoice = "standup";

export function isLandingChoice(value: unknown): value is LandingChoice {
  return typeof value === "string" && (LANDING_CHOICES as readonly string[]).includes(value);
}

/**
 * The route `/` should show, for a stored setting value.
 *
 * Anything unrecognised falls back to the default rather than throwing.
 * This runs on the one route with no way out — a reader who cannot render
 * `/` cannot navigate anywhere, because the sidebar is inside the page
 * that failed — so degrading is the only behaviour that leaves the app
 * usable.
 */
export function landingRoute(stored: unknown): NavRoute {
  const choice: NavId = isLandingChoice(stored) ? stored : DEFAULT_LANDING;
  const route = NAV_ROUTES.find((candidate) => candidate.id === choice);
  // Unreachable while `LANDING_CHOICES` stays a subset of the nav ids —
  // which a test asserts — but returning a definite route matters more here
  // than a clever non-null assertion.
  return route ?? NAV_ROUTES[0]!;
}

/**
 * Whether `/` should redirect at all.
 *
 * Standup lives *at* `/` rather than at `/standup`, so choosing it means
 * rendering in place and not bouncing through a redirect to the same
 * screen. Every other choice is a real destination with its own path.
 */
export function landingRedirectPath(stored: unknown): string | null {
  const route = landingRoute(stored);
  return route.href === "/" ? null : route.href;
}
