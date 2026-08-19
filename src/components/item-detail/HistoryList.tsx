// The history section — MILESTONES.md #72's third piece, redone for M10
// T10: "history is also taking up a lot of vertical space … should
// probably be a paginated list."
//
// Hook-free and prop-driven, like every other detail-tab component — see
// `SubtaskTree.tsx`'s header. Everything this renders was already decided
// by the caller: which page of which filtered, grouped set of entries to
// show. `ItemDetailContainer` owns the filter and page as state; the pure
// decisions (grouping by day, filtering by type, slicing into pages) live
// in `@/lib/item-detail/history.ts` so they are testable without a render.
import type { DetailHistoryEntry } from "@/lib/item-detail/types";
import { humanEventType } from "@/lib/item-detail/view";
import {
  eventTypesPresent,
  filterByType,
  groupByDay,
  pageCount,
  pageOf,
  HISTORY_PAGE_SIZE,
} from "@/lib/item-detail/history";
import type { EventType } from "@/lib/events";
import { EventTypeIcon } from "./EventTypeIcon";
import styles from "./ItemDetail.module.css";

export interface HistoryListProps {
  readonly history: readonly DetailHistoryEntry[];
  /** True when the ledger holds more than was returned — see the note on why this is shown. */
  readonly truncated: boolean;
  /**
   * The event type the reader has narrowed to, or `null` for every type.
   * Defaults to `null` so a caller that does not wire filtering still
   * renders the unfiltered list — the same "defaulted, not required"
   * convention `ItemDetailView`'s own props follow.
   */
  readonly typeFilter?: EventType | null;
  /** Called with the type a reader picked from the filter row, or `null` for "All". */
  readonly onTypeFilterChange?: (type: EventType | null) => void;
  /** Zero-based — which page of the (already filtered) list is showing. Defaults to the first page. */
  readonly page?: number;
  /** Called with the page a reader picked. */
  readonly onPageChange?: (page: number) => void;
}

/**
 * A timestamp as the list shows it. `toISOString` rather than a locale
 * format on purpose: a locale format renders differently on the server and
 * the client (different time zone, different locale), which React reports
 * as a hydration mismatch. An ISO string is the same on both.
 */
function formatTs(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

/** A day key (`YYYY-MM-DD`) as the group heading shows it — the date alone, the time already sits per-row. */
function formatDay(day: string): string {
  return day;
}

/** The filter row — "All" plus every type actually present in the unfiltered ledger. */
function typeFilterRow(
  present: readonly EventType[],
  active: EventType | null,
  onChange?: (type: EventType | null) => void,
) {
  return (
    <div className={styles.historyFilters} role="group" aria-label="Filter by event type">
      <button
        type="button"
        className={styles.historyFilterChip}
        data-active={active === null}
        aria-pressed={active === null}
        onClick={onChange ? () => onChange(null) : undefined}
      >
        All
      </button>
      {present.map((type) => (
        <button
          key={type}
          type="button"
          className={styles.historyFilterChip}
          data-active={active === type}
          data-event-type={type}
          aria-pressed={active === type}
          onClick={onChange ? () => onChange(type) : undefined}
        >
          <EventTypeIcon type={type} />
          <span>{humanEventType(type)}</span>
        </button>
      ))}
    </div>
  );
}

/** The pager — "Page X of Y", with Prev/Next. Rendered even at one page, showing the count as a fact. */
function pager(page: number, total: number, onPageChange?: (page: number) => void) {
  const count = pageCount(total);
  return (
    <div className={styles.historyPager} data-page={page} data-page-count={count}>
      <button
        type="button"
        className={styles.historyPagerButton}
        disabled={page <= 0}
        onClick={onPageChange ? () => onPageChange(page - 1) : undefined}
      >
        Previous
      </button>
      <span className={styles.historyPagerLabel}>
        Page {page + 1} of {count}
      </span>
      <button
        type="button"
        className={styles.historyPagerButton}
        disabled={page >= count - 1}
        onClick={onPageChange ? () => onPageChange(page + 1) : undefined}
      >
        Next
      </button>
    </div>
  );
}

export function HistoryList({
  history,
  truncated,
  typeFilter = null,
  onTypeFilterChange,
  page = 0,
  onPageChange,
}: HistoryListProps) {
  const present = eventTypesPresent(history);
  const filtered = filterByType(history, typeFilter);
  // Grouped by day AFTER paging, not before — see the header on
  // `@/lib/item-detail/history.ts`: a page is a fixed-size slice of the
  // filtered, ordered list, and grouping it afterwards only decides where
  // the day headings fall within that slice. Grouping first and paging the
  // groups would make a page's size vary with how many days it happened to
  // span, which is not what "25 at a time" means.
  const shown = pageOf(filtered, page);
  const groups = groupByDay(shown);

  return (
    <section className={styles.section} aria-label="History">
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>History</h2>
      </header>

      {history.length === 0 ? (
        <p className={styles.empty}>Nothing recorded yet.</p>
      ) : (
        <>
          {typeFilterRow(present, typeFilter, onTypeFilterChange)}

          {filtered.length === 0 ? (
            <p className={styles.empty}>No events of this type.</p>
          ) : (
            <>
              <ul className={styles.historyDays} data-shown-count={shown.length}>
                {groups.map((group) => (
                  <li key={group.day} className={styles.historyDay} data-day={group.day}>
                    <h3 className={styles.historyDayHeading}>{formatDay(group.day)}</h3>
                    <ul className={styles.history}>
                      {group.entries.map((entry) => (
                        <li key={entry.id} className={styles.historyEntry} data-type={entry.type}>
                          <span className={styles.historyIcon}>
                            <EventTypeIcon type={entry.type as EventType} />
                          </span>
                          <span className={styles.historyTs}>{formatTs(entry.ts)}</span>
                          <span className={styles.historyType}>{humanEventType(entry.type)}</span>
                          {(entry.headline ?? entry.body) !== null && (
                            <span className={styles.historyBody}>
                              {entry.headline ?? entry.body}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>

              {/* The page count is over the FILTERED list, not the raw
                  `historyLimit` window — a filter that leaves three matches
                  in a 100-row window is one page, not four. */}
              {pager(page, filtered.length, onPageChange)}
            </>
          )}

          {/* Said outright rather than left to be inferred from a
              suspiciously round number of rows: a list that silently stops
              at its cap reads as the whole history, and "this is all of it"
              is the one thing a history view must not imply falsely.
              Independent of pagination and the type filter — it describes
              the SERVER's `historyLimit` window, not what is on screen. */}
          {truncated && (
            <p className={styles.truncated}>
              Older entries are not shown — this is the most recent {history.length}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export { HISTORY_PAGE_SIZE };
