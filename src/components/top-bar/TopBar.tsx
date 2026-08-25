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
import { Menu, Plus, Search } from "lucide-react";
import type { Profile } from "@/lib/profile/types";
import { personColour } from "@/lib/design/person-colour";
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
  /**
   * Opens the command palette — T18. Optional, and when it is absent the
   * search control stays the disabled placeholder it was, rather than
   * becoming a button that looks live and does nothing.
   */
  readonly onOpenPalette?: () => void;
  /**
   * Opens quick create — T18. The `+` renders only when this is supplied,
   * for the same reason: an affordance for a dialog with no mount is worse
   * than no affordance.
   */
  readonly onOpenCreate?: () => void;
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
  onOpenPalette,
  onOpenCreate,
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
        {/* The command palette landed behind this control (T18), so it is
            now live — it opens the palette, whose first field is the
            search box. It keeps the disabled placeholder as its fallback
            for a caller that supplies no handler: a control that looks
            live and does nothing teaches a reader the feature is broken
            rather than absent, which is why the placeholder was written
            honest in the first place. */}
        <button
          type="button"
          className={styles.search}
          disabled={onOpenPalette === undefined}
          onClick={onOpenPalette}
          aria-label={
            onOpenPalette === undefined ? "Search — not available yet" : "Search and run commands"
          }
          title={onOpenPalette === undefined ? "Search is not available yet" : undefined}
        >
          <Search size={15} aria-hidden="true" />
          <span className={styles.searchLabel}>Search</span>
          {onOpenPalette !== undefined && (
            // The chord, shown on the control that runs it. This is the
            // only place in the app the palette advertises itself to
            // someone who has not pressed `?`, so it is worth the width.
            <kbd className={styles.searchChord} aria-hidden="true">
              Ctrl K
            </kbd>
          )}
        </button>

        {onOpenCreate !== undefined && (
          // T18's visible create affordance. In the top strip rather than
          // on the board, because creating an item is not a thing you do
          // *to* the board — it is available on every screen, which is
          // exactly what the strip is for.
          <button
            type="button"
            className={styles.create}
            onClick={onOpenCreate}
            aria-label="Create an item"
            title="Create an item (c)"
          >
            <Plus size={15} aria-hidden="true" />
            <span className={styles.createLabel}>Create</span>
          </button>
        )}

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
              // T22 — every person has a colour, stored or derived, so a
              // profile nobody has recoloured still paints as itself rather
              // than as the default grey. Identity only; the top bar shows
              // exactly one profile, so nothing here signals selection.
              style={{ background: personColour(activeProfile) }}
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
