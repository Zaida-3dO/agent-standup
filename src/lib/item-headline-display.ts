// How a card or a detail header picks its primary line — MILESTONES.md
// #131's first half, "titles a person can read".
//
// ── The problem this is display-only for ─────────────────────────────────
//
// Every imported title is a work order written by and for an agent —
// "agent-standup #102 - route the four raw event writes through
// appendEvent" — so a board scanned by a person reads as a wall of internal
// references. `item-title.ts` already states the convention for anything
// created from here on; this module is the other half, for the ~portion of
// the board that predates it.
//
// **Rewriting `title` is off the table**, and deliberately: it is what a
// reader correlates a row against its source PR by, it is what free-text
// `search` matches (`get-board.ts`'s `search` filter reads `title`/`body`
// directly), and a rewrite cannot be undone once the row it replaced is
// gone. `headline` (MILESTONES.md #107's one-line BLUF, maintained as work
// moves) already exists and says what a title should have said, so the fix
// is which field a card leads with, not what either field contains.
//
// So: **show `headline` where present, `title` otherwise.** No data moves,
// nothing is renamed, and an item nobody has written a headline for shows
// exactly what it always showed.

/**
 * Anything carrying a `title` and an optional `headline` — a board card or
 * a detail header. `BoardItem` and `DetailItem` both satisfy this
 * structurally, without either importing the other's module — the same
 * "own types, not a shared import" split `board/types.ts`'s header explains
 * for why it mirrors the API by hand instead of importing the service
 * layer's shape.
 */
export interface HeadlinedItem {
  readonly title: string;
  readonly headline: string | null;
}

/**
 * The line a reader sees first: `headline` when one has been written,
 * `title` otherwise.
 *
 * A blank or whitespace-only `headline` is treated as absent rather than
 * rendered as an empty primary line — the same defensive read
 * `waitingReason` and the card's own `headline` guard already apply
 * elsewhere in this codebase (`ItemCard.tsx`: `{entry.item.headline && …}`).
 * `record_artifact`/`create_item` do not themselves refuse a whitespace
 * headline, so a caller that wrote one is still shown *something* rather
 * than a blank card title.
 */
export function primaryLine(item: HeadlinedItem): string {
  const headline = item.headline?.trim();
  return headline && headline.length > 0 ? headline : item.title;
}

/**
 * True when the primary line is standing in for `title` — i.e. a headline
 * exists, so `title` is available as a secondary, smaller line rather than
 * being replaced outright.
 *
 * A named predicate rather than re-testing `item.headline` at each call
 * site, so `ItemCard.tsx` and the detail header agree on exactly the same
 * blank/whitespace handling `primaryLine` uses — testing `Boolean(headline)`
 * directly at the call site would silently diverge the moment either one
 * added the trim.
 */
export function hasDistinctHeadline(item: HeadlinedItem): boolean {
  const headline = item.headline?.trim();
  return Boolean(headline && headline.length > 0);
}
