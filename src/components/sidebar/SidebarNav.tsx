// The navigation list itself — the part that is the same whether it is
// rendered in the persistent rail or inside the mobile sheet.
//
// Hook-free and prop-driven, so it can be called as a plain function and
// its output inspected in this repo's DOM-free harness — see
// `TopBar.tsx`'s header for the full reasoning, and
// `tests/sidebar-nav.test.ts` for what that buys.
import Link from "next/link";
import { NAV_ROUTES, isActiveRoute } from "@/lib/nav/routes";
import { countForBadge, type NavCounts } from "@/lib/nav/counts";
import { NavIcon } from "./NavIcon";
import styles from "./Sidebar.module.css";

export interface SidebarNavProps {
  /** The path being rendered. `null` before the router resolves — nothing is highlighted, rather than the wrong thing. */
  readonly pathname: string | null;
  readonly counts: NavCounts;
  /** Called after a destination is chosen, so the mobile sheet can close itself. */
  readonly onNavigate?: () => void;
}

export function SidebarNav({ pathname, counts, onNavigate }: SidebarNavProps) {
  return (
    <nav className={styles.nav} aria-label="Main">
      <ul className={styles.navList}>
        {NAV_ROUTES.map((route) => {
          const active = pathname !== null && isActiveRoute(route.href, pathname);
          const count = countForBadge(route.badge, counts);
          return (
            <li key={route.id}>
              <Link
                href={route.href}
                className={styles.navItem}
                // `aria-current="page"` rather than a class alone: the
                // highlight is a colour and a left rule, and neither is
                // available to a screen reader. The CSS selects on this
                // attribute too, so the two cannot drift apart — there is
                // one source for "this is the active item".
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
              >
                <NavIcon name={route.icon} />
                <span className={styles.navLabel}>{route.label}</span>
                {/* Rendered only above zero. A badge reading "0" occupies the
                    spot the eye checks for a number and answers a question
                    nobody asked — the same rule `NeedsYouBadge` states. */}
                {count !== null && count > 0 && (
                  <span
                    className={`${styles.badge} tabular`}
                    // The number alone is meaningless out of visual context
                    // — a reader hearing "Needs you, 3" needs the 3 to be
                    // attached to something. The visible text stays the
                    // bare number.
                    aria-label={`${count} ${route.label.toLowerCase()}`}
                  >
                    {count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
