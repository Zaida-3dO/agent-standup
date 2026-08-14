// First-run entry — MILESTONES.md #86's "first-run entry when no profiles
// exist".
//
// **The problem this solves is a genuine dead end**, not a cosmetic one. The
// app shell (row #35) holds the whole application behind the profile picker
// until a profile is active, and with zero profiles the picker has nothing
// to choose: it says so honestly and there is no way past it. A fresh
// installation therefore reaches a screen with no action on it — and the
// surface that could fix it (`/settings`, and the administration pages it
// links to) is behind the very gate that cannot be passed.
//
// The rule is deliberately narrow so it cannot become a way to skip the
// picker generally: the escape exists only when the list has loaded, is
// genuinely empty, and nothing is active. A stale remembered profile also
// resolves to `activeProfile: null` (`resolveActiveProfile`) but leaves a
// non-empty list — the picker works there and blocking is correct.

/** What the shell knows about profiles when it decides whether to gate the page. */
export interface FirstRunInput {
  /** The loaded profile list, or `null` while it has not loaded (or failed to). */
  readonly people: readonly unknown[] | null;
  /** The active profile, or `null` for both "none chosen" and "the remembered one is unknown". */
  readonly activeProfile: unknown | null;
}

/**
 * Whether this is a first run: the profile list has loaded and there is
 * nobody in it.
 *
 * `people === null` is **not** a first run — the list has not loaded, so the
 * question is unanswered, and answering it "yes" would flash the escape
 * hatch on every page load before the fetch returns.
 */
export function isFirstRun({ people, activeProfile }: FirstRunInput): boolean {
  if (people === null) return false;
  if (people.length > 0) return false;
  return activeProfile === null;
}

/**
 * Whether a given path may be shown without an active profile.
 *
 * Only the configuration surfaces, and only exactly them: `/settings`, and
 * the administration pages it links to. The board is not on this list, and
 * should not be — it is the thing the picker exists to attribute, and
 * showing it unattributed would make "who's working" a question the app had
 * quietly stopped asking rather than one nobody could answer yet.
 *
 * Matched as the path or a path segment beneath it, so `/admin/repos`
 * qualifies and a path that merely starts with the same characters
 * (`/settings-export`) does not — a prefix test alone would open anything
 * somebody later named with that stem.
 */
const FIRST_RUN_PATHS: readonly string[] = Object.freeze(["/settings", "/admin"]);

export function isFirstRunPath(pathname: string): boolean {
  return FIRST_RUN_PATHS.some(
    (allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`),
  );
}

/**
 * The shell's decision: show the page rather than the picker.
 *
 * Both conditions, never either — an escape that fired on the path alone
 * would let anyone reach `/settings` unattributed on an installation with
 * profiles, and one that fired on the first-run state alone would show the
 * board with nobody working on it.
 */
export function allowsWithoutProfile(input: FirstRunInput, pathname: string): boolean {
  return isFirstRun(input) && isFirstRunPath(pathname);
}
