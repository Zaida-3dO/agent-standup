"use client";

// The client-side half of MILESTONES.md #35 ("Profile picker — choose a
// user profile, remembered in the browser, switchable from the top bar").
// Fetches the list of profiles once, resolves the remembered choice
// against it, and exposes both through context so the top bar (and
// anything later that needs to know who's acting) can read and change it
// without re-fetching.
//
// Every piece of actual decision logic lives in a plain function with no
// hooks and no DOM dependency, so this repo's DOM-free test harness
// (`vitest.config.ts`: `environment: "node"`) can exercise it directly:
// `./resolve.ts` (what a stored id resolves to), `./storage.ts` (where
// it's persisted), `./state.ts` (what the fetch and the picker-open flag
// combine into). This component is deliberately thin wiring on top of all
// three — the same shape §22 asks of an HTTP route: parse/fetch, call the
// pure logic, render the result.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { resolveActiveProfile } from "./resolve";
import { readStoredProfileId, writeStoredProfileId } from "./storage";
import { deriveProfileContextValue, errorMessageFrom, fetchPeople, type LoadState } from "./state";
import type { ProfileContextValue } from "./state";
import type { Profile } from "./types";

export type { ProfileContextValue } from "./state";

/**
 * Exported (not just used internally) so a test can render a probe
 * component under a controlled value with `react-dom/server` — the one
 * way to prove `useProfile()`'s behaviour and `AppShell`'s prop relay
 * without a DOM. See `tests/profile-provider.test.ts`.
 */
export const ProfileContext = createContext<ProfileContextValue | null>(null);

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
        setLoadState({ status: "error", message: errorMessageFrom(err) });
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

  const value = deriveProfileContextValue(loadState, activeProfile, pickerOpenedByUser, {
    openPicker,
    closePicker,
    choose,
  });

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
