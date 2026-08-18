// The presentational half of the app's profile lifecycle: loading the
// profile list, the initial (uncancellable) picker when nothing is active
// yet — no-profile-chosen-yet or stale/unknown, both surface as
// `activeProfile: null` (`resolveActiveProfile`, tested in
// `tests/profile-resolve.test.ts`) — the whole application frame once a
// profile IS active, and a plain error state if `GET /api/people` failed.
//
// **The frame is the sidebar, the top strip and the page**, in that
// arrangement. Navigation lives in the rail rather than the strip because
// eight destinations with live counts do not fit across a strip, and a
// product whose nav cannot hold its destinations is one where every new
// screen invents its own.
//
// Deliberately prop-driven, not a `useProfile()` caller itself — same
// reasoning as `TopBar.tsx`: this repo's test harness has no DOM
// (`vitest.config.ts`: `environment: "node"`), so a component with no
// hooks can be called directly as a function and its returned element
// tree inspected (`tests/app-shell-view.test.ts`), which is what actually
// proves these branches rather than merely rendering them once. `AppShell`
// is the thin container that reads the context and hands this component
// its props.
import type { ReactNode } from "react";
import type { Profile } from "@/lib/profile/types";
import { ProfilePicker } from "@/components/profile-picker/ProfilePicker";
import { TopBar } from "@/components/top-bar/TopBar";
import { SidebarView } from "@/components/sidebar/SidebarView";
import type { SavedViewLink } from "@/components/sidebar/SavedViewLinks";
import { allowsWithoutProfile } from "@/lib/settings-page/first-run";
import { crumbsFor } from "@/lib/nav/breadcrumb";
import { emptyCounts, type NavCounts } from "@/lib/nav/counts";
import type { Density } from "@/lib/nav/density";
import styles from "./AppShell.module.css";

export interface AppShellViewProps {
  readonly people: readonly Profile[] | null;
  readonly activeProfile: Profile | null;
  readonly error: string | null;
  readonly pickerOpen: boolean;
  readonly choose: (profile: Profile) => void;
  readonly closePicker: () => void;
  readonly openPicker: () => void;
  /**
   * The path being rendered, for the first-run entry and for what the
   * sidebar highlights. Only consulted for the first-run decision when
   * there are no profiles at all — see `@/lib/settings-page/first-run`,
   * which owns that rule and states why it is as narrow as it is. Optional
   * so a caller that does not know the path gets the pre-existing behaviour
   * (gate everything) rather than an accidental escape.
   */
  readonly pathname?: string;
  /** The picker's inline create form — see `AppShell.tsx` for why this state lives in the container rather than the profile context. */
  readonly createOpen: boolean;
  readonly createDraft: string;
  readonly creating: boolean;
  readonly createError: string | null;
  readonly onToggleCreate: () => void;
  readonly onCreateDraftChange: (raw: string) => void;
  readonly onCreateSubmit: () => void;
  /** The sidebar's live badge numbers. Defaults to zeroes, which render as no badges at all. */
  readonly counts?: NavCounts;
  /**
   * The reader's pinned board views (MILESTONES.md #75). Passed straight
   * through to the sidebar, which renders them as ordinary links — the shell
   * never learns what a filter is.
   */
  readonly savedViews?: readonly SavedViewLink[];
  /** The full path and query being rendered, so a pinned view can mark itself current. */
  readonly currentHref?: string | null;
  readonly navOpen?: boolean;
  readonly onOpenNav?: () => void;
  readonly onCloseNav?: () => void;
  readonly density?: Density;
  readonly onToggleDensity?: () => void;
  readonly children: ReactNode;
}

export function AppShellView({
  people,
  activeProfile,
  error,
  pickerOpen,
  choose,
  closePicker,
  openPicker,
  pathname,
  createOpen,
  createDraft,
  creating,
  createError,
  onToggleCreate,
  onCreateDraftChange,
  onCreateSubmit,
  counts,
  savedViews,
  currentHref,
  navOpen = false,
  onOpenNav,
  onCloseNav,
  density,
  onToggleDensity,
  children,
}: AppShellViewProps) {
  if (error) {
    return (
      <div className={styles.centered}>
        <p>{error}</p>
      </div>
    );
  }

  if (!people) {
    return (
      <div className={styles.centered}>
        <p>Loading profiles…</p>
      </div>
    );
  }

  // First run — no profiles exist at all, so the picker has nothing to
  // choose and is a dead end. The configuration surfaces are let through so
  // there is a way to set the installation up; everything else still gates.
  // The rule lives in `allowsWithoutProfile`, which requires *both* the
  // empty-list state and an allowed path.
  //
  // **No frame here, deliberately.** A sidebar offering eight destinations
  // on an installation where seven of them are behind the gate this branch
  // is escaping would be seven links to the picker.
  if (
    !activeProfile &&
    pathname !== undefined &&
    allowsWithoutProfile({ people, activeProfile }, pathname)
  ) {
    return <main>{children}</main>;
  }

  // No-profile-chosen-yet AND unknown/stale-profile both land here —
  // `activeProfile` is `null` for either reason — and there is nothing to
  // cancel back to, so the picker fills the whole page rather than opening
  // over it.
  if (!activeProfile) {
    return (
      <ProfilePicker
        people={people}
        onChoose={choose}
        createOpen={createOpen}
        createDraft={createDraft}
        creating={creating}
        createError={createError}
        onToggleCreate={onToggleCreate}
        onCreateDraftChange={onCreateDraftChange}
        onCreateSubmit={onCreateSubmit}
      />
    );
  }

  return (
    <div className={styles.shell}>
      <SidebarView
        pathname={pathname ?? null}
        counts={counts ?? emptyCounts()}
        sheetOpen={navOpen}
        onCloseSheet={onCloseNav ?? (() => {})}
        savedViews={savedViews}
        currentHref={currentHref}
      />
      <div className={styles.column}>
        <TopBar
          activeProfile={activeProfile}
          onSwitchProfile={openPicker}
          crumbs={pathname === undefined ? [] : crumbsFor(pathname)}
          density={density}
          onToggleDensity={onToggleDensity}
          onOpenNav={onOpenNav}
        />
        {pickerOpen && (
          <ProfilePicker
            people={people}
            onChoose={choose}
            onClose={closePicker}
            createOpen={createOpen}
            createDraft={createDraft}
            creating={creating}
            createError={createError}
            onToggleCreate={onToggleCreate}
            onCreateDraftChange={onCreateDraftChange}
            onCreateSubmit={onCreateSubmit}
          />
        )}
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}
