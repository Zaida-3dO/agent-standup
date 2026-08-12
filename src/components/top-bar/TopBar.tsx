// The existing chrome MILESTONES.md #35 asks the switcher to live in
// ("switchable from the top bar … it belongs in the existing chrome, not a
// separate page"). Rendered once, in `AppShellView`, above every page.
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
import type { Profile } from "@/lib/profile/types";
import styles from "./TopBar.module.css";

export interface TopBarProps {
  readonly activeProfile: Profile | null;
  readonly onSwitchProfile: () => void;
}

function initialOf(displayName: string): string {
  return displayName.trim().charAt(0).toUpperCase() || "?";
}

export function TopBar({ activeProfile, onSwitchProfile }: TopBarProps) {
  return (
    <header className={styles.bar}>
      <span className={styles.title}>Agent Standup</span>
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
    </header>
  );
}
