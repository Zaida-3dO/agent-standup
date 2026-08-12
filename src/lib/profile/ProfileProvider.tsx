"use client";

// The client-side half of MILESTONES.md #35 ("Profile picker — choose a
// user profile, remembered in the browser, switchable from the top bar").
// Fetches the list of profiles once, resolves the remembered choice
// against it (`resolveActiveProfile` — pure, unit tested), and exposes both
// through context so the top bar (and anything later that needs to know
// who's acting) can read and change it without re-fetching.
//
// The actual decision logic — what a stored id resolves to, where it's
// persisted — lives in `./resolve.ts` and `./storage.ts`, both plain
// functions with no React and no DOM dependency, so they're the pieces
// this repo's test harness can exercise directly (`environment: "node"`,
// `vitest.config.ts`). This component is deliberately thin wiring on top,
// the same shape §22 asks of an HTTP route: parse/fetch, call the pure
// logic, render the result.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { resolveActiveProfile } from "./resolve";
import { readStoredProfileId, writeStoredProfileId } from "./storage";
import type { Profile } from "./types";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; people: readonly Profile[] };

export interface ProfileContextValue {
  /** `null` while the profile list hasn't loaded (or failed to). */
  people: readonly Profile[] | null;
  /**
   * `null` until a profile is chosen — covers both the no-profile-chosen-yet
   * case (nothing remembered) and the stale-profile case (a remembered id
   * that no longer matches anything in `people`). Both are indistinguishable
   * to a caller on purpose: either way, nothing is currently active.
   */
  activeProfile: Profile | null;
  /** Set when `GET /api/people` failed. `people` stays `null` alongside it. */
  error: string | null;
  /** Whether the switch panel a caller opened (e.g. the top bar's icon) should be shown. */
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  /** Sets the active profile and remembers it in the browser. */
  choose: (profile: Profile) => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

async function fetchPeople(): Promise<readonly Profile[]> {
  const response = await fetch("/api/people");
  if (!response.ok) {
    throw new Error(`Could not load profiles (GET /api/people returned ${response.status}).`);
  }
  const body = (await response.json()) as { people: Profile[] };
  return body.people;
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [pickerOpenedByUser, setPickerOpenedByUser] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPeople()
      .then((people) => {
        if (cancelled) return;
        setLoadState({ status: "loaded", people });
        setActiveProfile(resolveActiveProfile(readStoredProfileId(), people));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({
          status: "error",
          message: err instanceof Error ? err.message : "Could not load profiles.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback((profile: Profile) => {
    writeStoredProfileId(profile.id);
    setActiveProfile(profile);
    setPickerOpenedByUser(false);
  }, []);

  const openPicker = useCallback(() => setPickerOpenedByUser(true), []);
  const closePicker = useCallback(() => setPickerOpenedByUser(false), []);

  const value: ProfileContextValue = {
    people: loadState.status === "loaded" ? loadState.people : null,
    activeProfile,
    error: loadState.status === "error" ? loadState.message : null,
    pickerOpen: pickerOpenedByUser,
    openPicker,
    closePicker,
    choose,
  };

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

/** Reads the current profile state. Must be called under `ProfileProvider`. */
export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) {
    throw new Error("useProfile() must be called within a ProfileProvider.");
  }
  return ctx;
}
