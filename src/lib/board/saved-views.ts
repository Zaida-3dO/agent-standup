// Saved views — a named filter+sort combination, MILESTONES.md #75.
//
// **A saved view is just a board URL with a name on it.** It stores the
// query string `boardQueryString` produces, not a parsed structure, and
// applying one is `parseBoardQuery` over that string. That is deliberate:
// the URL is already the whole of the board's state, so storing anything
// else would be a second representation that could disagree with the
// address bar — and the failure mode of a saved view that disagrees with
// its own link is one nobody would think to check.
//
// It also means a view survives a filter being added later. A stored query
// string carrying a parameter this build does not know is ignored by the
// parser rather than rejected, so an old view degrades to the filters that
// still exist instead of failing to load.
//
// The schema lives here rather than in the settings registry so that the
// front end can validate what it reads back without importing the registry
// (which pulls in the service layer's dependency graph). The registry
// imports THIS, so there is one schema, not two.
import { z } from "zod";

/** The longest a view name may be. Long enough to be descriptive, short enough to fit a chip. */
export const SAVED_VIEW_NAME_MAX = 40;

/** How many views one installation may pin. A bound, so the sidebar cannot grow without limit. */
export const SAVED_VIEWS_MAX = 20;

export const savedViewSchema = z.object({
  /**
   * The reader's name for it, and its identity. Names are unique, checked by
   * `upsertSavedView` — an id nobody types would be a second thing to
   * reconcile, and two views called "Mine" is a worse problem than being
   * told the name is taken.
   */
  name: z.string().min(1).max(SAVED_VIEW_NAME_MAX),
  /**
   * The board's query string — exactly what `boardQueryString` produced, with
   * no leading `?`. Empty is legal and means the unfiltered board in the
   * default order, which is a view worth being able to pin.
   */
  query: z.string().max(2000),
  /**
   * Whether this view is pinned into the sidebar. Saving a view pins it,
   * and this field exists so that unpinning is a value change rather than a
   * schema migration.
   */
  pinned: z.boolean().default(true),
});

export type SavedView = z.infer<typeof savedViewSchema>;

export const savedViewsSchema = z.array(savedViewSchema).max(SAVED_VIEWS_MAX);

export type SavedViews = z.infer<typeof savedViewsSchema>;

/** The settings key these are stored under. Named once, so no caller spells it by hand. */
export const SAVED_VIEWS_KEY = "ui.saved_views";

/**
 * Names differing only by case or surrounding space are the same name.
 *
 * Without this, "Mine" and "mine " are two chips a reader cannot tell apart
 * in a sidebar, and saving over one of them is a coin flip.
 */
export function normaliseViewName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Adds a view, or overwrites the one with the same name.
 *
 * **Overwrite rather than refuse**, because saving over a view is how a
 * reader adjusts one: narrow the board a bit more, press save with the same
 * name. Refusing would make the only way to edit a view "delete it, then
 * make it again", which is two steps to express one intent and loses the
 * view entirely if the second step is forgotten.
 *
 * Position is kept — a view does not jump to the end of the sidebar because
 * it was edited.
 */
export function upsertSavedView(views: SavedViews, view: SavedView): SavedViews {
  const key = normaliseViewName(view.name);
  const index = views.findIndex((existing) => normaliseViewName(existing.name) === key);
  if (index === -1) return [...views, view];
  return views.map((existing, i) => (i === index ? view : existing));
}

/** Removes the view with this name. A name that is not present is not an error — the end state is the same. */
export function removeSavedView(views: SavedViews, name: string): SavedViews {
  const key = normaliseViewName(name);
  return views.filter((view) => normaliseViewName(view.name) !== key);
}

/** The view whose stored query matches this one exactly, or `undefined` — what marks a chip as active. */
export function findMatchingView(views: SavedViews, query: string): SavedView | undefined {
  return views.find((view) => view.query === query);
}

/**
 * Whether a name can be saved, and why not when it cannot.
 *
 * Returns the reason as a sentence rather than a boolean, so the control can
 * say which of the three limits it hit instead of being inertly disabled —
 * a disabled control with no explanation is the thing a reader retries.
 */
export function savedViewNameProblem(
  views: SavedViews,
  name: string,
): { readonly reason: string } | null {
  const trimmed = name.trim();
  if (trimmed === "") return { reason: "Give the view a name before saving it." };
  if (trimmed.length > SAVED_VIEW_NAME_MAX) {
    return { reason: `A view name is at most ${SAVED_VIEW_NAME_MAX} characters.` };
  }
  // The cap is checked against a name that is NOT already in use, because
  // saving over an existing view overwrites rather than adds and so cannot
  // push the list past the limit — refusing it would block the one action
  // that is always safe at the cap.
  const overwriting = views.some(
    (view) => normaliseViewName(view.name) === normaliseViewName(name),
  );
  if (!overwriting && views.length >= SAVED_VIEWS_MAX) {
    return { reason: `You can pin ${SAVED_VIEWS_MAX} views. Delete one to save another.` };
  }
  return null;
}
