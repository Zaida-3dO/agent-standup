// The saved board views, pinned into the sidebar — MILESTONES.md #75.
//
// **This component knows nothing about filters.** It takes names and hrefs
// and renders links. That is what lets "pin a view to the sidebar" not turn
// into "the sidebar imports the board's filter model": a saved view is a
// board URL with a name on it, and a URL with a name on it is exactly what
// navigation is already made of.
//
// Rendered below the fixed destinations rather than mixed into them,
// because the two are different kinds of thing — `NAV_ROUTES` is the app's
// shape and cannot be changed from the interface, while these are the
// reader's own and come and go. Interleaving them would make the fixed list
// look editable and the editable list look permanent.
//
// Hook-free and prop-driven; see `SidebarNav.tsx`.
import Link from "next/link";
import { Bookmark } from "lucide-react";
import styles from "./Sidebar.module.css";

export interface SavedViewLink {
  readonly name: string;
  /** Where it points — a full board href, built by `boardHref`. */
  readonly href: string;
}

export interface SavedViewLinksProps {
  readonly views: readonly SavedViewLink[];
  /** The full path-and-query being rendered, so the matching view marks itself current. */
  readonly currentHref?: string | null;
  /** Called after a destination is chosen, so the mobile sheet can close itself. */
  readonly onNavigate?: () => void;
}

export function SavedViewLinks({ views, currentHref, onNavigate }: SavedViewLinksProps) {
  // Nothing saved renders nothing at all — not an empty heading. A section
  // title over no content is a promise the sidebar does not keep, and it
  // costs vertical space on every screen to say that a feature exists.
  if (views.length === 0) return null;

  return (
    <nav className={styles.savedViews} aria-label="Saved board views">
      <p className={styles.savedViewsHeading}>Views</p>
      <ul className={styles.navList}>
        {views.map((view) => (
          <li key={view.name}>
            <Link
              href={view.href}
              className={styles.navItem}
              aria-current={currentHref === view.href ? "page" : undefined}
              onClick={onNavigate}
            >
              <Bookmark size={16} aria-hidden="true" />
              <span className={styles.navLabel}>{view.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
