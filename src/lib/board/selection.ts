// Which rows are selected, and what a click does to that — T6-E's first
// half.
//
// Pure functions over plain data, the same split every other board module
// follows (`view.ts`, `list.ts`, `drag-state.ts`). The reason is sharper
// here than usual, and worth stating rather than inheriting:
//
// **Selection is exactly the shape of the defect that has shipped three
// times in this repo.** A click handler wants to know "what is selected
// now" in order to decide what to do, and the naive way to get that is to
// read it out of a `setState` updater — which React defers whenever a lane
// is already pending on the fiber, and invokes twice under StrictMode.
// `scripts/check-updater-side-effects.mjs` exists because of those three
// occurrences, and its header names the established fix: read a ref
// synchronously *before* the setState and leave the updater a pure function
// of its argument.
//
// A pure module is what makes that fix cheap. Every question a handler
// needs answered — what does this click select, is this row selected, what
// is the anchor now — is a function from (current selection, click) to a
// new selection, computable *before* any setState is called. The component
// then has nothing to compute inside an updater, because there is nothing
// left to compute.
//
// ── Why selection is over ids and not entries ───────────────────────────
//
// A `Selection` holds ids, never `BoardEntry` objects. The board reloads
// under the reader — paging appends, the live feed patches, a filter
// re-reads the whole thing — and a selection holding entry objects would
// hold copies that quietly went stale, then act on the stale copy. Ids
// survive a reload; whether the row is still *there* is a separate question
// answered against the loaded board (`selectedEntries`), and answering it
// against the loaded board on every gesture is what keeps a bulk from
// acting on a row that has left the view.

import type { BoardEntry } from "./types";

/**
 * Whether a row can be selected for a bulk action at all.
 *
 * **A project cannot**, and it is the same rule and the same reason
 * `isDraggable` gives for the kanban: a project's column is derived from
 * its children and it has no state of its own to transition — the service
 * refuses outright with `ProjectHasNoStateError`, and DECISIONS.md §13c
 * says the answer is to move the children instead. Offering a checkbox and
 * then always refusing the action would teach the wrong model of the data,
 * and it would do it inside a batch, where the refusal is one line in a
 * report rather than something the reader can see happen.
 *
 * Not shared with `isDraggable` despite the two agreeing: this is a rule
 * about a *selection*, that one is about a drag gesture, and collapsing
 * them would mean a future change to what can be dragged silently changed
 * what can be bulk-moved.
 */
export function isSelectable(entry: BoardEntry): boolean {
  return entry.item.kind !== "project";
}

/** The ids of the rows a reader is allowed to select, in the order shown. */
export function selectableIds(entries: readonly BoardEntry[]): readonly string[] {
  return entries.filter(isSelectable).map((entry) => entry.item.id);
}

/**
 * What is selected, and where a range would measure from.
 *
 * `anchor` is the last row the reader clicked *without* shift — the fixed
 * end of a range. Held here rather than beside the selection because the
 * two change together on every click and a separate anchor is how the two
 * come to disagree: a selection cleared without clearing its anchor leaves
 * a shift-click measuring from a row nobody can see is special.
 *
 * `null` when nothing has been clicked yet, which is the state a shift-click
 * has to cope with (see `rangeFrom`).
 */
export interface Selection {
  readonly ids: ReadonlySet<string>;
  readonly anchor: string | null;
}

/** Nothing selected — the state the list mounts in and returns to. */
export function emptySelection(): Selection {
  return { ids: new Set(), anchor: null };
}

/** Whether anything at all is selected. */
export function isEmpty(selection: Selection): boolean {
  return selection.ids.size === 0;
}

/** How many rows are selected. */
export function selectionSize(selection: Selection): number {
  return selection.ids.size;
}

/** Whether this row is selected. */
export function isSelected(selection: Selection, id: string): boolean {
  return selection.ids.has(id);
}

/**
 * A plain click on `id` — toggles that one row and moves the anchor to it.
 *
 * Toggle rather than replace: the list's checkboxes are the primary
 * affordance and a checkbox that cleared every other checkbox when ticked
 * would be a radio button wearing the wrong shape. The anchor moves even
 * when the click *deselects*, because the anchor is "where the reader last
 * put their attention", not "the last thing selected" — a shift-click after
 * an unticking measures from the row they just unticked, which is where
 * their cursor is.
 */
export function toggle(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/**
 * A shift-click on `id` — selects every row between the anchor and `id`.
 *
 * `order` is the rows as the reader sees them, top to bottom, which is what
 * makes "between" mean anything. It is the list's own flattened order
 * (`listEntries`), so a range spans section boundaries exactly as the
 * reader's eye does — shift-clicking from a Backlog row to an In-progress
 * row selects everything visually between them, which is what the gesture
 * looks like it should do.
 *
 * **The range is added, not assigned.** A shift-click extends what is
 * already selected, so a reader can build a selection out of several
 * ranges. An assignment would silently discard everything picked before
 * the range, and the reader would only find out by counting the bar.
 *
 * **The anchor does not move.** That is what makes a shift-click
 * *adjustable*: clicking further down after a shift-click grows the same
 * range rather than starting a new one from where the last one ended.
 *
 * Three degenerate cases, each resolved to the least surprising thing
 * rather than to an error:
 *
 *   - **No anchor** (nothing clicked yet) — behaves as a plain click on
 *     `id`. A shift-click has to mean *something*, and selecting the row
 *     under the cursor is what the reader asked for.
 *   - **Anchor absent from `order`** — the row was filtered away or paged
 *     out from under the selection. Same fallback: there is no range to
 *     measure, so select the clicked row and re-anchor there.
 *   - **Anchor === id** — a range of one, which is just that row.
 */
export function rangeFrom(selection: Selection, id: string, order: readonly string[]): Selection {
  const { anchor } = selection;
  if (anchor === null) return toggle(selection, id);

  const anchorIndex = order.indexOf(anchor);
  const clickedIndex = order.indexOf(id);
  // A clicked row that is not in `order` cannot be ranged to either. This
  // should not happen — the reader clicked something that is on screen —
  // but resolving it to the plain-click fallback beats producing a range
  // computed from `-1`, which would silently select from the top of the
  // list.
  if (anchorIndex === -1 || clickedIndex === -1) return toggle(selection, id);

  const start = Math.min(anchorIndex, clickedIndex);
  const end = Math.max(anchorIndex, clickedIndex);
  const ids = new Set(selection.ids);
  for (let i = start; i <= end; i += 1) {
    const rowId = order[i];
    if (rowId !== undefined) ids.add(rowId);
  }
  return { ids, anchor };
}

/**
 * Select every row in `order`, or clear the lot.
 *
 * The list's header checkbox. **`select: true` selects only the rendered
 * rows**, never the column's counted total — a board of 68
 * shows 8, and a "select all" that quietly meant all sixty-eight would let
 * a reader apply a destructive action to sixty rows they have never seen.
 * The bar states the count, so the number the reader confirms against is
 * the number that will actually move.
 *
 * The anchor is set to the first row on a select-all so a following
 * shift-click has somewhere to measure from, and cleared on a deselect-all
 * because an empty selection gives a range nothing to extend.
 */
export function selectAll(order: readonly string[], select: boolean): Selection {
  if (!select) return emptySelection();
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/**
 * Drop from the selection every id the board omits.
 *
 * Called after a reload — a filter change, a page, a live patch, a
 * completed bulk. **Selection survives a reload that still shows the row,
 * and does not survive one that does not.** That is the rule this function
 * *is*, and it is the one worth stating to a reader: a reader who selects
 * twelve rows, pages in more, and finds their twelve still ticked has had
 * the interface keep their place; a reader whose selection silently
 * retained six rows that filtering removed would be one click from moving
 * items that are not in front of them.
 *
 * The anchor is dropped when its row goes, for the same reason: a range
 * measured from an invisible row is a range the reader cannot predict.
 * `rangeFrom` also tolerates a missing anchor, so this is belt and braces
 * — but it is the layer that keeps the *stored* state honest rather than
 * relying on every reader of it to compensate.
 *
 * Returns the SAME object when nothing was dropped. That is not a
 * micro-optimisation: this runs on every board load, and a new `Selection`
 * every time would be a new object identity in a dependency list, which is
 * how a reconcile-on-load becomes a render loop.
 */
export function reconcile(selection: Selection, present: readonly string[]): Selection {
  const live = new Set(present);
  const kept = new Set<string>();
  for (const id of selection.ids) {
    if (live.has(id)) kept.add(id);
  }
  const anchor = selection.anchor !== null && live.has(selection.anchor) ? selection.anchor : null;
  if (kept.size === selection.ids.size && anchor === selection.anchor) return selection;
  return { ids: kept, anchor };
}

/**
 * The selected rows, as entries, in the order they appear.
 *
 * **Resolved against the loaded board, never remembered.** This is the
 * function that makes "selection holds ids" safe: whatever the selection
 * says, what a bulk acts on is the intersection with what is on the board
 * right now, in board order. An id whose row has gone simply does not
 * appear, so a bulk cannot act on it.
 *
 * Board order rather than click order, deliberately — the report a partial
 * bulk produces reads down the list the way the reader's eye does, and a
 * report ordered by when each row happened to be clicked would be
 * unscannable against the list it describes.
 */
export function selectedEntries(
  selection: Selection,
  entries: readonly BoardEntry[],
): readonly BoardEntry[] {
  return entries.filter((entry) => selection.ids.has(entry.item.id));
}
