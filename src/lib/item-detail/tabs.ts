// The detail page's tab set, and the rule for reading one out of a URL.
//
// ── Why the tabs are data rather than markup ───────────────────────────
//
// The six tabs are filled by separate pieces of work landing at separate
// times, so the set has to be nameable — as a type, so a tab that does not
// exist fails to compile, and as a runtime list, so the tab strip is
// rendered by mapping rather than by six hand-written buttons that can
// drift out of step with the six panels. `TABS` below is both.
//
// ── Why the URL carries the active tab ─────────────────────────────────
//
// A section of a long page has to be linkable. The board wants to point a
// chip at an item's activity; an approval queue wants to point at its
// review findings. If the active tab lived only in component state, every
// one of those links would land on Overview and leave the reader to find
// the section themselves — which is the same problem the tabs were added to
// solve, moved one step along.
//
// It is the **hash** rather than a query parameter. A hash change is
// handled entirely in the browser and needs no server round trip, so
// switching tabs costs nothing and the back button walks the tabs the
// reader actually visited. It is also the fragment convention a reader
// already recognises from a document's table of contents, and it composes
// with a plain `<a href="/items/x#activity">` — a linker needs to know
// nothing about this module or the router to build one.

/** Every tab, in the order the strip shows them. */
export const TABS = ["overview", "plan", "reviews", "subtasks", "activity", "summary"] as const;

export type DetailTab = (typeof TABS)[number];

/**
 * The tab shown when the URL names none, or names one that does not exist.
 *
 * Overview, because it is the tab that answers "what is this item" — the
 * question a reader arriving with no more specific intent is asking.
 */
export const DEFAULT_TAB: DetailTab = "overview";

/**
 * What each tab is called on screen.
 *
 * A `Record<DetailTab, string>` deliberately: adding a seventh tab to
 * `TABS` fails to compile here until someone decides what it is called,
 * which is the property that keeps a tab from shipping with its id showing
 * as its label.
 */
export const TAB_LABELS: Record<DetailTab, string> = {
  overview: "Overview",
  plan: "Plan",
  reviews: "Reviews",
  subtasks: "Subtasks",
  activity: "Activity",
  summary: "Summary",
};

/** True if `value` names a tab — the type guard the hash parser narrows with. */
export function isDetailTab(value: string): value is DetailTab {
  return (TABS as readonly string[]).includes(value);
}

/**
 * The tab a URL hash asks for, falling back to `DEFAULT_TAB`.
 *
 * **An unrecognised hash falls back rather than erroring.** A hash is the
 * most easily mistyped, most easily outdated part of a URL — it survives in
 * bookmarks and in links written before a tab was renamed — and a reader
 * following a stale link wants the item, not a failure. Falling back shows
 * them the item on its default tab, which is the same thing a link with no
 * hash at all gives them.
 *
 * Accepts the hash with or without its leading `#`, because
 * `location.hash` includes it and a hand-written string usually does not.
 * Matching is case-insensitive: a hash is frequently retyped by hand, and
 * `#Activity` asks for the same section as `#activity` by any reasonable
 * reading.
 */
export function tabFromHash(hash: string | null | undefined): DetailTab {
  if (hash === null || hash === undefined) return DEFAULT_TAB;
  const raw = (hash.startsWith("#") ? hash.slice(1) : hash).trim().toLowerCase();
  return isDetailTab(raw) ? raw : DEFAULT_TAB;
}

/**
 * The hash that links to a tab — `"#activity"`.
 *
 * Exported so a linker elsewhere builds one from the tab id rather than by
 * concatenating a `#` onto a string it hopes is a tab, which is the version
 * that goes stale silently when a tab is renamed.
 */
export function hashForTab(tab: DetailTab): string {
  return `#${tab}`;
}
