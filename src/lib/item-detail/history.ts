// The Activity tab's own derivations — grouping, filtering and paging over
// `DetailHistoryEntry` — M10 T10.
//
// Split out for the reason every other `@/lib/item-detail` module is: this
// repo's harness runs `environment: "node"` with no DOM, so what a press
// or a type filter *means* has to be a plain function to be directly
// testable at all. `HistoryList.tsx` renders what these decide.
//
// ── Why this is client-side windowing over a capped read, not real paging ─
//
// `get_item_detail`'s `historyLimit` is a **cap on the newest N rows**, not
// a cursor — there is no `offset`/`before` the API accepts (SCHEMA.md #72's
// operation deliberately reads history in the same transaction as the rest
// of the detail payload, so paging it independently would mean a second
// read outside that transaction's snapshot). With up to 500 rows on one
// item, loading a "page" therefore means slicing the array this module
// already has, not issuing a second request — which is also why a filter
// is applied AFTER the slice into pages: filtering first and paging the
// filtered result would change page boundaries every time the filter
// changed, which is the one thing a paginated list must not do underfoot.
//
// A ledger with more than `historyLimit` entries (`truncated`, per the
// operation's own doc) still cannot show its oldest rows from this screen —
// that gap is real and is called out in `HistoryList`'s truncation notice,
// not hidden by this module pretending to page past it.
import type { DetailHistoryEntry } from "./types";
import type { EventType } from "@/lib/events";

/** How many rows one page of the timeline shows. */
export const HISTORY_PAGE_SIZE = 25;

/** One day's worth of history entries, newest first within the day. */
export interface HistoryDayGroup {
  /** `YYYY-MM-DD`, in UTC — see `dayKeyOf` for why UTC and not local time. */
  readonly day: string;
  readonly entries: readonly DetailHistoryEntry[];
}

/**
 * The `YYYY-MM-DD` a timestamp falls on, in UTC.
 *
 * UTC rather than the reader's local zone, for the same reason
 * `HistoryList`'s existing timestamp formatting uses `toISOString`: a local
 * day boundary depends on where the browser is, so the same item would
 * group its events into different days for two readers looking at the same
 * data — and worse, differently on the server's render and the client's
 * first one, which is a hydration mismatch. An invalid timestamp groups
 * under itself verbatim rather than throwing, matching `formatTs`'s own
 * fallback.
 */
export function dayKeyOf(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Entries grouped by day, days newest-first, entries within a day in the
 * order they were given.
 *
 * Assumes the input is already newest-first (what the server sends) —
 * this does not re-sort, so a caller that hands it something else gets
 * groups in that same order. Re-sorting here would silently mask the one
 * property `orderedHistory`'s own header exists to assert.
 */
export function groupByDay(entries: readonly DetailHistoryEntry[]): HistoryDayGroup[] {
  const groups: HistoryDayGroup[] = [];
  let current: { day: string; entries: DetailHistoryEntry[] } | null = null;
  for (const entry of entries) {
    const day = dayKeyOf(entry.ts);
    if (current === null || current.day !== day) {
      current = { day, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

/**
 * Every event type present in `entries`, in the order `EVENT_TYPE_ORDER`
 * lists them — not the order they happen to appear in the ledger, so the
 * filter row does not reshuffle itself from one item to the next.
 */
export function eventTypesPresent(entries: readonly DetailHistoryEntry[]): EventType[] {
  const present = new Set(entries.map((entry) => entry.type));
  return EVENT_TYPE_ORDER.filter((type) => present.has(type));
}

/**
 * `entries` narrowed to the chosen type, or all of them when `type` is
 * `null` — the "show everything" state a filter row always has to have.
 *
 * An entry whose `type` is not one of the sixteen known values (a future
 * type this build has not seen) still passes the `null` filter — an
 * unrecognised type is not the same claim as "does not match the type you
 * picked", and hiding it from the unfiltered view would silently drop
 * ledger rows from a screen whose whole point is completeness.
 */
export function filterByType(
  entries: readonly DetailHistoryEntry[],
  type: EventType | null,
): readonly DetailHistoryEntry[] {
  if (type === null) return entries;
  return entries.filter((entry) => entry.type === type);
}

/**
 * One page of entries, `HISTORY_PAGE_SIZE` at a time.
 *
 * `page` is zero-based and clamped rather than trusted, so a stale page
 * number left over from a wider filter (page 4 of "everything", now
 * filtered to a type with two entries) degrades to the last real page
 * instead of rendering empty beneath a filter that plainly has matches —
 * see `clampPage`, which callers use to keep the page index itself honest.
 */
export function pageOf(
  entries: readonly DetailHistoryEntry[],
  page: number,
): readonly DetailHistoryEntry[] {
  const clamped = clampPage(page, pageCount(entries.length));
  const start = clamped * HISTORY_PAGE_SIZE;
  return entries.slice(start, start + HISTORY_PAGE_SIZE);
}

/** How many pages `total` entries make, at least one so an empty list still has a "page 1 of 1". */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
}

/** `page`, clamped to `[0, pageCount - 1]` — see `pageOf`'s header for why this matters after a filter change. */
export function clampPage(page: number, pageCount: number): number {
  if (page < 0) return 0;
  if (page > pageCount - 1) return pageCount - 1;
  return page;
}

/**
 * Every event type this build knows about, in the order the filter row
 * lists them — busiest / most routine first, the types a reader is most
 * likely to want to exclude last. Mirrors `EventType` in `events-insert.ts`
 * exactly; a type added there and not here fails at the call site rather
 * than silently, because `EVENT_TYPE_ORDER` is typed as
 * `readonly EventType[]` and `eventTypesPresent` above would otherwise
 * simply never offer it as a filter.
 */
export const EVENT_TYPE_ORDER: readonly EventType[] = [
  "field_change",
  "state_change",
  "checkpoint",
  "note",
  "claim",
  "release",
  "takeover",
  "dispatch",
  "dispatch_claimed",
  "review_requested",
  "review",
  "merge",
  "open_loop",
  "open_loop_closed",
  "open_loop_edited",
  "open_loop_deleted",
  "nudge",
  "escalation",
  "setting_change",
];
