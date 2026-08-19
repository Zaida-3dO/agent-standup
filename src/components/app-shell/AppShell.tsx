"use client";

// The thin container: reads profile state/actions from context, holds the
// profile-create form's own state (T13 — the picker's inline create form),
// and hands everything to `AppShellView` as plain props. Kept deliberately
// thin on branching — see `AppShellView.tsx`'s header for why the picker's
// display logic lives there instead, where it's directly testable.
//
// **Why create-form state lives here and not in `ProfileProvider`.** The
// draft, the pending flag and the error are UI-only and specific to the one
// place a create form renders; putting them in the shared profile context
// would make every consumer of `useProfile()` (not just the shell) carry
// state that only this component ever reads. `choose` and `addPerson`
// (both already on the context) are enough to wire a freshly created
// profile in as active and visible — see `onCreateSubmit` below, and
// `addPerson`'s own header (`./state.ts`) for why landing it in `people`
// is a separate step from activating it.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { createErrorMessage, createPerson } from "@/lib/profile/create";
import { emptyCounts, fetchNavCounts, type NavCounts } from "@/lib/nav/counts";
import { DEFAULT_DENSITY, densityClass, writeStoredDensity, type Density } from "@/lib/nav/density";
import { fetchSavedViews } from "@/lib/board/saved-views-client";
import { savedViewLinksFrom } from "@/lib/nav/saved-view-links";
import type { SavedViewLink } from "@/components/sidebar/SavedViewLinks";
import { AppShellView } from "./AppShellView";

/**
 * Stands in for a path the router has not resolved yet, so the sheet's
 * "opened on this path" tag is always a comparable string.
 *
 * Deliberately not a path anything can navigate to: every real pathname
 * begins with a slash, so this can never collide with one and the sheet
 * cannot be left open by a navigation that happens to match it.
 */
const UNRESOLVED_PATH = "path:unresolved";

/** The class the density boot script writes and the toggle maintains. */
const compactClass = densityClass("compact");

export function AppShell({ children }: { children: ReactNode }) {
  const profile = useProfile();
  // Read here rather than in the view, so the view stays hook-free and
  // callable as a plain function in the DOM-free harness. `usePathname` can
  // return null before the router has resolved; `?? undefined` maps that to
  // "path unknown", which the view treats as gate-everything.
  const pathname = usePathname() ?? undefined;
  /** The path as a comparable tag — see `navOpenedAt` for why `undefined` needs a stand-in. */
  const pathTag = pathname ?? UNRESOLVED_PATH;

  // The sidebar's badge numbers, and the mobile sheet's open flag. Both are
  // shell-level rather than sidebar-level: the counts are re-fetched when
  // the active profile changes (they are per person), and the sheet is
  // opened by a control in the top strip, which is the sidebar's sibling
  // and not its child.
  const [counts, setCounts] = useState<NavCounts>(emptyCounts);
  // The reader's pinned board views (MILESTONES.md #75). Held at shell level
  // because they render in the sidebar, which is on every screen — a board
  // that owned them would leave them missing everywhere else.
  const [savedViews, setSavedViews] = useState<readonly SavedViewLink[]>([]);
  // **The sheet's state carries the path it was opened on**, rather than an
  // effect resetting it when the path changes. The reset is genuinely
  // wanted — the sheet covers the page it just navigated to, so leaving it
  // open hides the result of the reader's own action, and its own
  // `onNavigate` cannot catch a back-button navigation — but doing it with
  // a synchronous `setState` inside an effect is a cascading render and is
  // what `react-hooks/set-state-in-effect` warns about. Comparing during
  // render makes "a navigation closes the sheet" a derived fact, which is
  // the same shape `SinceLastVisit.tsx` uses for its per-profile feed.
  //
  // `pathname` can be `undefined` before the router resolves, so the tag is
  // stored as a string with a sentinel for that case rather than as
  // `string | null` — comparing `null` against `undefined` would be false
  // and the sheet would refuse to open at all on an unresolved path.
  const [navOpenedAt, setNavOpenedAt] = useState<string | null>(null);
  const navOpen = navOpenedAt !== null && navOpenedAt === pathTag;
  // **Read from the document, not from storage, and during render.** The
  // inline boot script in `layout.tsx` has already put the class on
  // `<html>` before first paint, so the class IS the live state and reading
  // it is reading the external system rather than duplicating it — which is
  // why this is not an effect that would immediately re-render.
  //
  // The state below is only an override: `null` means "whatever the
  // document says", and it becomes a value the first time the reader
  // toggles. On the server there is no document, so this falls through to
  // the default, and the script corrects the class before anything paints.
  const [densityOverride, setDensityOverride] = useState<Density | null>(null);
  const density: Density =
    densityOverride ??
    (typeof document !== "undefined" && document.documentElement.classList.contains(compactClass)
      ? "compact"
      : DEFAULT_DENSITY);

  const personId = profile.activeProfile?.id ?? null;

  // Re-fetched when the profile changes, not just on mount: both counts are
  // per person (an unseen event and a blocked-on-you item are both claims
  // about *you*), so leaving the previous profile's numbers on screen after
  // a switch would attribute one person's queue to another.
  useEffect(() => {
    let cancelled = false;
    // `fetchNavCounts` folds every failure into a zero rather than
    // rejecting — see its header for why chrome on every page must not be
    // able to fail the page — so there is no rejection path to catch here.
    void fetchNavCounts(personId).then((next) => {
      if (cancelled) return;
      setCounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [personId]);

  // Loaded once, on mount. Not per profile: a saved view is a way of looking
  // at the work, not a claim about a person, so it is the same list whoever
  // is active. `fetchSavedViews` folds every failure into an empty list, so
  // there is no rejection path here for the same reason `fetchNavCounts` has
  // none — chrome on every page must not be able to fail the page.
  useEffect(() => {
    let cancelled = false;
    void fetchSavedViews().then((views) => {
      if (!cancelled) setSavedViews(savedViewLinksFrom(views));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggleDensity = useCallback(() => {
    const next: Density = density === "compact" ? "comfortable" : "compact";
    writeStoredDensity(next);
    // The class on `<html>` is the single source of truth for what the
    // spacing tokens resolve to (`globals.css` §10), so it is written here
    // rather than derived by any component. Guarded because this module is
    // imported in a server render too.
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      root.classList.remove(compactClass);
      const className = densityClass(next);
      if (className !== "") root.classList.add(className);
    }
    // Written after the class, so the render this schedules already sees a
    // document that agrees with it.
    setDensityOverride(next);
  }, [density]);

  const onOpenNav = useCallback(() => setNavOpenedAt(pathTag), [pathTag]);
  const onCloseNav = useCallback(() => setNavOpenedAt(null), []);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const onToggleCreate = useCallback(() => {
    setCreateOpen((open) => !open);
    setCreateError(null);
  }, []);

  const onCreateSubmit = useCallback(() => {
    const displayName = createDraft.trim();
    if (displayName === "" || creating) return;
    setCreating(true);
    setCreateError(null);
    createPerson(displayName)
      .then((created) => {
        setCreating(false);
        setCreateDraft("");
        setCreateOpen(false);
        // T21 — lands the new row in `people` first, so the picker (which
        // reads `people` to decide what to render) never sees `choose`'s
        // activation before the profile it is activating exists in the
        // list. See `addPerson` (`ProfileProvider.tsx`/`state.ts`) for why
        // this appends rather than refetching.
        profile.addPerson(created);
        // Activates the person just created — see the module header on why
        // this reuses `choose` rather than the shell tracking its own
        // "who's active" state a second time.
        profile.choose(created);
      })
      .catch((err: unknown) => {
        setCreating(false);
        setCreateError(createErrorMessage(err));
      });
  }, [createDraft, creating, profile]);

  return (
    <AppShellView
      {...profile}
      pathname={pathname}
      createOpen={createOpen}
      createDraft={createDraft}
      creating={creating}
      createError={createError}
      onToggleCreate={onToggleCreate}
      onCreateDraftChange={setCreateDraft}
      onCreateSubmit={onCreateSubmit}
      counts={counts}
      savedViews={savedViews}
      navOpen={navOpen}
      onOpenNav={onOpenNav}
      onCloseNav={onCloseNav}
      density={density}
      onToggleDensity={onToggleDensity}
    >
      {children}
    </AppShellView>
  );
}
