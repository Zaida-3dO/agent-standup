// The route map, as data.
//
// Every destination the sidebar can reach is declared once, here, and both
// the navigation and the active-item highlighting read from this list. The
// alternative — a `<Link>` per destination written out in the view — makes
// the route map a thing you reconstruct by reading JSX, and makes "is this
// path one of ours?" a question with no answer at all.
//
// Declared as plain data with no React in it, so the ordering, the paths
// and the active-match rule are all exercisable in a harness with no DOM
// (`vitest.config.ts`: `environment: "node"`).

/**
 * The identifier for a navigation destination. Closed rather than free
 * text so a badge wired to the wrong name fails to compile instead of
 * silently never rendering.
 */
export type NavId =
  "standup" | "projects" | "board" | "needs-you" | "fleet" | "activity" | "cost" | "settings";

/**
 * Which live count, if any, a destination carries beside its label.
 *
 * Two counters, not one per destination: a badge is a claim that something
 * is waiting for you, and a number that is merely "how many things exist"
 * trains you to ignore the whole row of them. `unseen` is the activity a
 * profile has not marked seen; `needsYou` is the three-reason union
 * `get_needs_you` computes server-side — blocked on you, a merge awaiting
 * your approval, or a plan awaiting your review (`@/lib/nav/counts`,
 * `fetchNeedsYouCount`). It is **not** the narrower client-side
 * `needsYouCount()` in `@/lib/board/view` that the board's own banner uses
 * (T24 moved the sidebar off that count on purpose, after the two disagreed
 * with nothing to explain the gap) — see `NeedsYouBadge.tsx`'s header for
 * why the board banner still uses the narrower one.
 */
export type NavBadge = "unseen" | "needsYou";

export interface NavRoute {
  readonly id: NavId;
  readonly label: string;
  readonly href: string;
  /** The lucide icon name the view maps to a component. Kept as a string so this module stays React-free. */
  readonly icon: string;
  readonly badge?: NavBadge;
}

/**
 * The sidebar's destinations, in the order they are rendered.
 *
 * The order is a claim about the day, not an alphabetisation: the two
 * entries you land on and triage from come first, the organising view
 * (projects) and the working view (board) next, then the things you go to
 * when you have a question, and configuration last. Changing this changes
 * what the eye reaches first, so it is ordered deliberately and asserted
 * in `tests/nav-routes.test.ts`.
 */
export const NAV_ROUTES: readonly NavRoute[] = Object.freeze([
  { id: "standup", label: "Standup", href: "/", icon: "layout-dashboard", badge: "unseen" },
  { id: "projects", label: "Projects", href: "/projects", icon: "folder-kanban" },
  { id: "board", label: "Board", href: "/board", icon: "columns-3" },
  {
    id: "needs-you",
    label: "Needs you",
    href: "/needs-you",
    icon: "circle-alert",
    badge: "needsYou",
  },
  { id: "fleet", label: "Fleet", href: "/fleet", icon: "cpu" },
  { id: "activity", label: "Activity", href: "/activity", icon: "activity" },
  { id: "cost", label: "Cost", href: "/cost", icon: "banknote" },
  { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
]);

/**
 * Whether a nav entry is the one the current path is inside.
 *
 * Prefix-matched on a **segment boundary**, so `/projects/abc` highlights
 * Projects while `/projects-archive` does not — a bare `startsWith` would
 * light up any route someone later named with the same stem, which is the
 * same trap `isFirstRunPath` (`@/lib/settings-page/first-run`) documents.
 *
 * `/` is special-cased to an exact match. It is a prefix of literally
 * every path, so prefix-matching it would leave Standup highlighted on
 * every screen in the app and the highlight would carry no information.
 */
export function isActiveRoute(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The nav entry a path belongs to, or `null` for a path outside the map
 * (`/items/{id}`, `/admin/{slug}`).
 *
 * Returns the **longest** matching href rather than the first, so a nested
 * route under two matching prefixes resolves to the more specific one. No
 * such pair exists in the list above; the rule is here because relying on
 * declaration order would make adding one a silent mis-highlight rather
 * than a caught mistake.
 */
export function activeRoute(pathname: string): NavRoute | null {
  let best: NavRoute | null = null;
  for (const route of NAV_ROUTES) {
    if (!isActiveRoute(route.href, pathname)) continue;
    if (best === null || route.href.length > best.href.length) best = route;
  }
  return best;
}
