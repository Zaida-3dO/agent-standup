// The top strip: where you are, a way to search, and who you are acting as.
//
// It is deliberately **not** where you navigate. Eight destinations with
// live counts do not fit across a strip, and squeezing them there is what
// makes each new screen invent its own navigation instead — so the
// destinations live in the sidebar and this carries only the three things
// that are about the *current* page rather than about the app's shape.
//
// **The profile switcher's behaviour is unchanged** — same props, same
// callback, same accessible name. It moved along the strip and gained
// neighbours; it did not gain a decision.
//
// Deliberately prop-driven rather than reading `useProfile()` itself: this
// repo's test harness runs `environment: "node"` with no DOM (no jsdom, no
// `@testing-library/react` — see `vitest.config.ts`), so a component that
// calls a hook can only be exercised through a real render pass. A
// component that takes plain props instead can be called directly as a
// function and its returned element tree inspected — see
// `tests/top-bar.test.ts` — which is what actually proves this file's
// conditionals rather than merely rendering it. `AppShell` is the one place
// that reads the context and hands this component its props.
import Link from "next/link";
import { Menu, Search } from "lucide-react";
import type { Profile } from "@/lib/profile/types";
import type { Crumb } from "@/lib/nav/breadcrumb";
import { DensityToggle } from "./DensityToggle";
import type { Density } from "@/lib/nav/density";
import styles from "./TopBar.module.css";

export interface TopBarProps {
  readonly activeProfile: Profile | null;
  readonly onSwitchProfile: () => void;
  /** Where the reader is, innermost last. Empty renders no trail rather than an empty one. */
  readonly crumbs?: readonly Crumb[];
  readonly density?: Density;
  readonly onToggleDensity?: () => void;
  /** Opens the mobile navigation sheet. The button is hidden by CSS above the breakpoint. */
  readonly onOpenNav?: () => void;
}

function initialOf(displayName: string): string {
  return displayName.trim().charAt(0).toUpperCase() || "?";
}

export function TopBar({
  activeProfile,
  onSwitchProfile,
  crumbs = [],
  density,
  onToggleDensity,
  onOpenNav,
}: TopBarProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.left}>
        {onOpenNav && (
          <button
            type="button"
            className={styles.menuButton}
            onClick={onOpenNav}
            aria-label="Open navigation"
          >
            <Menu size={18} aria-hidden="true" />
          </button>
        )}
        {crumbs.length > 0 && (
          <nav className={styles.crumbs} aria-label="Breadcrumb">
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className={styles.crumbGroup}>
                {index > 0 && (
                  <span className={styles.crumbSeparator} aria-hidden="true">
                    /
                  </span>
                )}
                {crumb.href === null ? (
                  // The trailing crumb — and any crumb with nowhere safe to
                  // point — is text, not a dead link. `aria-current` marks
                  // it so a reader is told which one they are on.
                  <span className={styles.crumbCurrent} aria-current="page">
                    {crumb.label}
                  </span>
                ) : (
                  <Link href={crumb.href} className={styles.crumb}>
                    {crumb.label}
                  </Link>
                )}
              </span>
            ))}
          </nav>
        )}
      </div>

      <div className={styles.right}>
        {/* Search is a placeholder, and it says so. A search field that
            accepted a query and did nothing would be worse than none — it
            teaches a reader the feature is broken rather than absent — so
            this is a disabled control with an honest label until the
            command palette lands behind it. */}
        <button
          type="button"
          className={styles.search}
          disabled
          aria-label="Search — not available yet"
          title="Search is not available yet"
        >
          <Search size={15} aria-hidden="true" />
          <span className={styles.searchLabel}>Search</span>
        </button>

        {density !== undefined && onToggleDensity !== undefined && (
          <DensityToggle density={density} onToggle={onToggleDensity} />
        )}

        {activeProfile && (
          <button
            type="button"
            className={styles.switcher}
            onClick={onSwitchProfile}
            aria-label={`Switch profile (active: ${activeProfile.displayName})`}
          >
            <span
              className={styles.avatar}
              style={activeProfile.colour ? { background: activeProfile.colour } : undefined}
              aria-hidden="true"
            >
              {activeProfile.avatar ?? initialOf(activeProfile.displayName)}
            </span>
            <span className={styles.name}>{activeProfile.displayName}</span>
          </button>
        )}
      </div>
    </header>
  );
}
