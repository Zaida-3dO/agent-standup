// The pure half of `ProfileProvider.tsx` — the state shape, the value it
// publishes through context, and how each is derived. Split out so this
// repo's DOM-free test harness (`vitest.config.ts`: `environment: "node"`)
// can exercise it directly rather than only through a hook-bound component,
// the same reasoning `./resolve.ts` and `./storage.ts` are already split
// out for.
import type { Profile } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";

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
  /**
   * Appends a freshly created profile to `people`, so it shows up in the
   * picker without a reload. See `withPersonAdded` — the pure logic this
   * wraps — for why appending the known row beats a refetch.
   */
  readonly addPerson: (person: Profile) => void;
}

export interface ProfileActions {
  readonly openPicker: () => void;
  readonly closePicker: () => void;
  readonly choose: (profile: Profile) => void;
  readonly addPerson: (person: Profile) => void;
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
  const response = await fetchImpl(uiApiPath("/api/people"));
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

/**
 * Appends a freshly created person to a `LoadState`, so `ProfilePicker`
 * sees it in the same session it was created — the bug this closes: a
 * mount-only `fetchPeople()` effect means nothing re-fetches `people` after
 * a create, so the picker read a stale empty (or merely incomplete) list
 * and rendered "No profiles are set up yet" over a profile that plainly
 * exists.
 *
 * Appends the known-created row rather than triggering a refetch: the
 * caller already has the exact `Profile` `POST`'s response returned, a
 * refetch would be a second round-trip to re-learn what is already known,
 * and it would reintroduce a loading flicker right after the create
 * spinner the form just cleared.
 *
 * A no-op outside `status: "loaded"` — there is no list to append to while
 * still loading or in an error state, and silently fabricating one would
 * hide whichever of those is real. In practice `addPerson` is only ever
 * called once a profile was successfully created, which cannot happen
 * before the initial fetch resolves (the create form isn't reachable
 * without a `people` list to render), so that branch is defensive rather
 * than reachable — kept for totality, not because it fires.
 */
export function withPersonAdded(loadState: LoadState, person: Profile): LoadState {
  if (loadState.status !== "loaded") return loadState;
  return { status: "loaded", people: [...loadState.people, person] };
}
