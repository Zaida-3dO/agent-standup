// The change highlight's bookkeeping — T17, part 3.
//
// **Which cards are highlighted is a set with expiries, and that is all this
// is.** The appearance lives in CSS (`.cardChanged`, which also honours
// `prefers-reduced-motion`), and the timer lives in the component; what is
// here is the part with a decision in it — when a mark starts, when it has
// run out, and what happens when a card changes twice in quick succession.
//
// Pure functions over plain data, like everything else the board's logic is
// made of, so the expiry behaviour is provable without a renderer or a fake
// clock installed globally.

/** How long a card stays marked. Matches `.cardChanged`'s animation duration. */
export const HIGHLIGHT_MS = 2_000;

/** Item id → the moment its mark expires. */
export type Highlights = ReadonlyMap<string, number>;

export function noHighlights(): Highlights {
  return new Map();
}

/**
 * Marks every id in `itemIds` as just-changed, expiring `HIGHLIGHT_MS` from
 * `now`.
 *
 * **A card that changes again while still marked has its expiry extended,
 * not ignored.** Two moves of the same card two seconds apart are two things
 * that happened, and letting the first mark's expiry end the second one's
 * would make the later change the invisible one — exactly backwards.
 *
 * Returns a new map; the input is never mutated, because it is a React value
 * that may be rendered again.
 */
export function highlightAdded(
  current: Highlights,
  itemIds: readonly string[],
  now: number,
): Highlights {
  if (itemIds.length === 0) return current;
  const next = new Map(current);
  for (const id of itemIds) next.set(id, now + HIGHLIGHT_MS);
  return next;
}

/**
 * Drops every mark that has expired at `now`.
 *
 * Returns the **same reference** when nothing expired, so a caller can use
 * identity to decide whether a re-render is warranted — a sweep that
 * allocated a new map on every tick would re-render the whole board several
 * times a second for a value that did not change.
 */
export function highlightsSwept(current: Highlights, now: number): Highlights {
  let expired = false;
  for (const expiry of current.values()) {
    if (expiry <= now) {
      expired = true;
      break;
    }
  }
  if (!expired) return current;
  const next = new Map<string, number>();
  for (const [id, expiry] of current) {
    if (expiry > now) next.set(id, expiry);
  }
  return next;
}

/** The ids under an unexpired mark — what `BoardView` takes as `changedItemIds`. */
export function highlightedIds(current: Highlights): ReadonlySet<string> {
  return new Set(current.keys());
}
