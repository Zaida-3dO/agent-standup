// The presentational half of MILESTONES.md #35's profile lifecycle:
// loading the profile list, the initial (uncancellable) picker when
// nothing is active yet — no-profile-chosen-yet or stale/unknown, both
// surface as `activeProfile: null` (`resolveActiveProfile`, tested in
// `tests/profile-resolve.test.ts`) — the top bar plus an optional
// switch-panel once a profile IS active, and a plain error state if
// `GET /api/people` failed.
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
import { allowsWithoutProfile } from "@/lib/settings-page/first-run";
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
   * The path being rendered, for MILESTONES.md #86's first-run entry. Only
   * consulted when there are no profiles at all — see
   * `@/lib/settings-page/first-run`, which owns the rule and states why it
   * is as narrow as it is. Optional so a caller that does not know the path
   * gets the pre-existing behaviour (gate everything) rather than an
   * accidental escape.
   */
  readonly pathname?: string;
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
    return <ProfilePicker people={people} onChoose={choose} />;
  }

  return (
    <>
      <TopBar activeProfile={activeProfile} onSwitchProfile={openPicker} />
      {pickerOpen && <ProfilePicker people={people} onChoose={choose} onClose={closePicker} />}
      <main>{children}</main>
    </>
  );
}
