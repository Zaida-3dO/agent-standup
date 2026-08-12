// The pure half of `ProfileProvider.tsx` — the state shape, the value it
// publishes through context, and how each is derived. Split out so this
// repo's DOM-free test harness (`vitest.config.ts`: `environment: "node"`)
// can exercise it directly rather than only through a hook-bound component,
// the same reasoning `./resolve.ts` and `./storage.ts` are already split
// out for.
import type { Profile } from "./types";

export type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; people: readonly Profile[] };

export interface ProfileContextValue {
  /** `null` while the profile list hasn't loaded (or failed to). */
  readonly people: readonly Profile[] | null;
  /**
   * `null` until a profile is chosen — covers both the no-profile-chosen-yet
   * case (nothing remembered) and the stale-profile case (a remembered id
   * that doesn't match anything in `people`). Both are indistinguishable to
   * a caller on purpose: either way, nothing is active.
   */
  readonly activeProfile: Profile | null;
  /** Set when `GET /api/people` failed. `people` stays `null` alongside it. */
  readonly error: string | null;
  /** Whether the switch panel a caller opened (e.g. the top bar's icon) should be shown. */
  readonly pickerOpen: boolean;
  readonly openPicker: () => void;
  readonly closePicker: () => void;
  /** Sets the active profile and remembers it in the browser. */
  readonly choose: (profile: Profile) => void;
}

export interface ProfileActions {
  readonly openPicker: () => void;
  readonly closePicker: () => void;
  readonly choose: (profile: Profile) => void;
}

/**
 * Combines the three pieces of state `ProfileProvider` tracks (the fetch's
 * `LoadState`, which profile is active, whether the switch panel was
 * opened) into the one value it publishes through context.
 */
export function deriveProfileContextValue(
  loadState: LoadState,
  activeProfile: Profile | null,
  pickerOpenedByUser: boolean,
  actions: ProfileActions,
): ProfileContextValue {
  return {
    people: loadState.status === "loaded" ? loadState.people : null,
    activeProfile,
    error: loadState.status === "error" ? loadState.message : null,
    pickerOpen: pickerOpenedByUser,
    ...actions,
  };
}

/** Every profile from `GET /api/people`. Throws a message fit to show directly — never a raw Response or a JSON-parse error. */
export async function fetchPeople(fetchImpl: typeof fetch = fetch): Promise<readonly Profile[]> {
  const response = await fetchImpl("/api/people");
  if (!response.ok) {
    throw new Error(`Could not load profiles (GET /api/people returned ${response.status}).`);
  }
  const body = (await response.json()) as { people: Profile[] };
  return body.people;
}

/** Turns a caught value into the message the error state shows — never a raw, possibly-unhelpful object. */
export function errorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load profiles.";
}
