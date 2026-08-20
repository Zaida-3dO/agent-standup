// Which filter controls the board's header renders — the "More filters"
// picker's state.
//
// **This is a display preference, and it is the one piece of the filter bar
// that is deliberately NOT in the URL.** The split is the whole design:
//
//   - WHICH controls are visible is *per person, per browser*. It says
//     nothing about what the board shows.
//   - What each control is SET to is the URL, unchanged.
//
// The URL is the shareable address of a board (`filters.ts`: "the URL is the
// state"). Putting a chosen control set in it would mean a link handed to
// someone else rearranged their header, and a saved view — which is stored
// as a query string and matched by string equality — would silently become a
// different view for anyone whose picker differed. Neither is a thing a
// reader asking to hide a control has asked for.
//
// So it lives in `localStorage`, and the consequences are accepted rather
// than worked around: it does not follow a person to another browser, and it
// is invisible to the server. Both are true of a preference about one
// person's own screen.
//
// Pure functions over plain data, no `window` — the storage access itself is
// in `visible-filters-client.ts`, so every decision here is provable in this
// repo's DOM-free harness.

import { BOARD_FILTER_PARAMS, levelIsDefault, type BoardFilters } from "./filters";

/** One axis the picker can show or hide, and what the checkbox calls it. */
export interface FilterVisibilityChoice {
  readonly param: keyof BoardFilters;
  readonly label: string;
}

/**
 * The axes the picker offers, in the order the header renders them.
 *
 * A `Record` over the param type, so an axis added to `BOARD_FILTER_PARAMS`
 * is a type error here until it is given a label — rather than an axis that
 * silently never appears in the picker and so can never be turned on.
 */
const FILTER_LABELS: Record<keyof BoardFilters, string> = {
  area: "Area",
  repo: "Repo",
  assignee: "On it",
  actor: "Raised by",
  priority: "Priority",
  state: "State",
  kind: "Kind",
  level: "Level",
  project: "Project",
  search: "Search",
};

/**
 * `search` is not offered.
 *
 * The search box is not one of the axis selects — it is the bar's primary
 * control, it is what the whole row is `role="search"` for, and hiding it
 * would leave a search landmark with nothing in it. A picker entry that can
 * break the containing landmark is worse than an entry that does not exist.
 */
const PICKER_EXCLUDED: readonly (keyof BoardFilters)[] = ["search"];

/** Every axis the picker can show or hide, in header order. */
export const FILTER_VISIBILITY_CHOICES: readonly FilterVisibilityChoice[] =
  BOARD_FILTER_PARAMS.filter((param) => !PICKER_EXCLUDED.includes(param)).map((param) => ({
    param,
    label: FILTER_LABELS[param],
  }));

/**
 * What the header shows before anyone has chosen — the seven axes that were
 * there already, plus `level`.
 *
 * `level` is in the default set because it is applied to every board whether
 * or not anyone asked for it (`defaultLevelFilter`). A filter that is always
 * acting on what a reader sees, with no visible control saying so, is a
 * board quietly hiding rows for a reason nothing on screen explains.
 *
 * `project` is NOT, which is what makes the picker worth having: it is the
 * tenth control on an eight-control row, it is reached far more often by
 * clicking a project card than by hunting a select, and a reader who wants
 * it can turn it on once and keep it.
 */
export const DEFAULT_VISIBLE_FILTERS: readonly (keyof BoardFilters)[] = [
  "area",
  "repo",
  "assignee",
  "actor",
  "priority",
  "state",
  "kind",
  "level",
];

/** The visible set as the picker holds it — an ordered, de-duplicated list of axes. */
export type VisibleFilters = readonly (keyof BoardFilters)[];

/**
 * Puts a set into header order and drops anything unrecognised.
 *
 * Ordering here rather than at render is what stops the header's layout
 * depending on the order a reader happened to tick boxes in — two people
 * with the same axes visible see the same bar. Dropping unknown entries is
 * what makes a stored preference survive an axis being renamed or removed in
 * a later build: the rest of the set still applies, instead of the whole
 * preference being discarded.
 */
export function normaliseVisibleFilters(visible: VisibleFilters): VisibleFilters {
  const wanted = new Set(visible);
  return FILTER_VISIBILITY_CHOICES.filter((choice) => wanted.has(choice.param)).map(
    (choice) => choice.param,
  );
}

/** Whether one axis renders in the header. */
export function isFilterVisible(visible: VisibleFilters, param: keyof BoardFilters): boolean {
  return visible.includes(param);
}

/**
 * Ticking or unticking one box.
 *
 * **An axis that is currently NARROWED cannot be hidden.** Hiding it would
 * leave the board filtered by something with no control on screen to undo
 * it — the reader sees a short board, sees no filter, and has only the back
 * button. Turning a narrowed axis off is therefore refused rather than
 * silently also clearing the filter, because clearing it would change what
 * the board shows in response to a control that only claims to change what
 * the header shows.
 */
export function visibilityToggled(
  visible: VisibleFilters,
  param: keyof BoardFilters,
  next: boolean,
  filters: BoardFilters,
): VisibleFilters {
  if (next) return normaliseVisibleFilters([...visible, param]);
  if (!canHide(param, filters)) return normaliseVisibleFilters(visible);
  return normaliseVisibleFilters(visible.filter((entry) => entry !== param));
}

/**
 * Whether an axis may be hidden right now — false while it is narrowing the
 * board. The picker disables the box rather than letting the press do
 * nothing, and says why in the box's own title.
 */
export function canHide(param: keyof BoardFilters, filters: BoardFilters): boolean {
  const value = filters[param];
  if (value === undefined) return true;
  // `level` is never absent once a query has been parsed — absent MEANS the
  // default — so an `=== undefined` test alone would make it permanently
  // un-hideable, which is the opposite of the rule: a default level is not
  // narrowing anything a reader needs a control to undo.
  if (param === "level") return levelIsDefault(value as BoardFilters["level"] & object);
  return false;
}
