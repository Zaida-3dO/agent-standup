// The board's filter, sort and search bar — MILESTONES.md #75.
//
// **This row exists because the service filters were already finished.**
// `get_board` has accepted `area`, `repo`, `state`, `assignee`, `priority`
// and `search` for some time, and the row that added them was marked done.
// Nothing on the board could reach any of them, so the delivered capability
// was zero while the record said complete. That is what this component is
// for: it is not a new capability, it is the only way to use one that
// already existed.
//
// **One search box for the whole board, not one per column.** Four boxes is
// four places to look for a query you have already typed and four states to
// reconcile when they disagree — and the underlying read is one call per
// column against one predicate, so per-column search would be four ways to
// express something the API cannot vary by column anyway.
//
// Hook-free and prop-driven, like every other view in this directory: this
// repo's harness runs `environment: "node"` with no DOM, so a component
// that takes plain props can be called as a function and its element tree
// inspected — which is what actually proves the branches below. The state,
// the router and the debounce live in `BoardFilterBar.tsx`.
import { Search, X } from "lucide-react";
import {
  BOARD_FILTER_KINDS,
  BOARD_FILTER_PRIORITIES,
  BOARD_SORT_KEYS,
  activeFilterCount,
  type BoardFilters,
  type BoardQuery,
  type BoardSortKey,
} from "@/lib/board/filters";
import { ITEM_STATES } from "@/lib/design/tokens";
import styles from "./BoardFilterBar.module.css";

/** One choosable value on an axis whose vocabulary comes from the store rather than the code. */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface BoardFilterBarViewProps {
  readonly query: BoardQuery;
  /**
   * Sets or clears one axis. `undefined` clears — the same call the "any"
   * option makes, so clearing is not a second code path that could diverge
   * from setting.
   */
  readonly onFilterChange: <K extends keyof BoardFilters>(
    key: K,
    value: BoardFilters[K] | undefined,
  ) => void;
  readonly onSortChange: (sort: BoardSortKey) => void;
  /** Flips the direction. One control rather than two, because the two are never independently useful. */
  readonly onToggleDirection: () => void;
  readonly onClearFilters: () => void;
  /**
   * What the search box shows. Held by the container rather than
   * read from `query.filters.search`, because the two deliberately differ
   * while a reader is mid-word — the box updates on every keystroke and the
   * URL only after the debounce.
   */
  readonly searchDraft: string;
  readonly onSearchDraftChange: (value: string) => void;
  /** The areas that exist. Empty renders the axis with only its "any" option rather than hiding it. */
  readonly areas?: readonly FilterOption[];
  readonly repos?: readonly FilterOption[];
  /** People — the vocabulary for both "who's on it" and "whose idea it was". */
  readonly people?: readonly FilterOption[];
  /** Live assignment holders, which includes agent crew names a `Person` list does not carry. */
  readonly assignees?: readonly FilterOption[];
}

/**
 * The reader-facing name of each sort key — the schema's word is not always
 * the reader's ("updated" is a column; "Last updated" is what it means).
 *
 * A `Record` over the key type, so adding a fifth sort key is a type error
 * here until it is given a label, rather than a menu entry rendering as
 * `undefined`.
 */
const SORT_LABELS: Record<BoardSortKey, string> = {
  priority: "Priority",
  name: "Name",
  created: "Created",
  updated: "Last updated",
};

/**
 * A sort key's label.
 *
 * A function rather than a bare index because this project compiles with
 * `noUncheckedIndexedAccess`, which types every index read as possibly
 * absent even against an exhaustive `Record` — the fallback is unreachable
 * and exists to keep that honest without a non-null assertion.
 */
function sortLabel(key: BoardSortKey): string {
  return SORT_LABELS[key] ?? key;
}

/** `on_deck` → `On deck`. The stored vocabulary is snake_case; a filter menu should not be. */
function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * One `<select>` axis.
 *
 * **Every axis carries an explicit "any" option whose value is the empty
 * string**, and choosing it clears the filter. A select with no such option
 * can be narrowed and never widened without reaching for the browser's back
 * button, which is the most common way a filter bar traps a reader.
 */
function AxisSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string | undefined;
  readonly options: readonly FilterOption[];
  readonly onChange: (value: string | undefined) => void;
}) {
  return (
    <div className={styles.axis}>
      {/* A real `<label>`, not a placeholder option. A placeholder
          disappears the moment a value is chosen, leaving a control whose
          meaning has to be inferred from its contents — and leaving a
          screen-reader user with an unnamed select. */}
      <label className={styles.axisLabel} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={styles.select}
        value={value ?? ""}
        data-filtered={value !== undefined ? "true" : undefined}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function BoardFilterBarView({
  query,
  onFilterChange,
  onSortChange,
  onToggleDirection,
  onClearFilters,
  searchDraft,
  onSearchDraftChange,
  areas = [],
  repos = [],
  people = [],
  assignees = [],
}: BoardFilterBarViewProps) {
  const active = activeFilterCount(query.filters);
  const ascending = query.direction === "asc";

  return (
    <div className={styles.bar} role="search" aria-label="Filter and sort the board">
      <div className={styles.searchWrap}>
        <Search size={14} className={styles.searchIcon} aria-hidden="true" />
        <input
          id="board-search"
          type="search"
          className={styles.search}
          value={searchDraft}
          onChange={(event) => onSearchDraftChange(event.target.value)}
          placeholder="Search titles and bodies"
          // Says what it does rather than promising more than it delivers:
          // this is a case-insensitive substring match, not ranked search,
          // and a reader who expects relevance ordering from a box labelled
          // "Search" has been misled by the label rather than by the
          // results. See `get-board.ts` for the cost of the predicate.
          aria-label="Search the board — matches text anywhere in an item's title or body"
          title="Matches text anywhere in a title or body. Not a ranked search: results come back in the sort order you chose."
        />
      </div>

      <div className={styles.axes}>
        <AxisSelect
          id="board-filter-area"
          label="Area"
          value={query.filters.area}
          options={areas}
          onChange={(value) => onFilterChange("area", value)}
        />
        <AxisSelect
          id="board-filter-repo"
          label="Repo"
          value={query.filters.repo}
          options={repos}
          onChange={(value) => onFilterChange("repo", value)}
        />
        <AxisSelect
          id="board-filter-assignee"
          label="On it"
          value={query.filters.assignee}
          options={assignees}
          onChange={(value) => onFilterChange("assignee", value)}
        />
        <AxisSelect
          id="board-filter-actor"
          label="Raised by"
          value={query.filters.actor}
          options={people}
          onChange={(value) => onFilterChange("actor", value)}
        />
        <AxisSelect
          id="board-filter-priority"
          label="Priority"
          value={query.filters.priority}
          options={BOARD_FILTER_PRIORITIES.map((value) => ({ value, label: value }))}
          onChange={(value) => onFilterChange("priority", value as BoardFilters["priority"])}
        />
        <AxisSelect
          id="board-filter-state"
          label="State"
          value={query.filters.state}
          options={ITEM_STATES.map((value) => ({ value, label: humanise(value) }))}
          onChange={(value) => onFilterChange("state", value)}
        />
        <AxisSelect
          id="board-filter-kind"
          label="Kind"
          value={query.filters.kind}
          options={BOARD_FILTER_KINDS.map((value) => ({ value, label: humanise(value) }))}
          onChange={(value) => onFilterChange("kind", value as BoardFilters["kind"])}
        />
      </div>

      <div className={styles.sortGroup}>
        <label className={styles.axisLabel} htmlFor="board-sort">
          Sort
        </label>
        <select
          id="board-sort"
          className={styles.select}
          value={query.sort}
          onChange={(event) => onSortChange(event.target.value as BoardSortKey)}
        >
          {BOARD_SORT_KEYS.map((key: BoardSortKey) => (
            <option key={key} value={key}>
              {sortLabel(key)}
            </option>
          ))}
        </select>
        {/* The arrow is not the only channel: the accessible name says the
            direction in words, because an arrow glyph is exactly the kind of
            single-character difference that carries no meaning to a screen
            reader and very little at a glance. */}
        <button
          type="button"
          className={styles.direction}
          onClick={onToggleDirection}
          aria-label={
            ascending
              ? `Sorted ascending by ${sortLabel(query.sort).toLowerCase()} — switch to descending`
              : `Sorted descending by ${sortLabel(query.sort).toLowerCase()} — switch to ascending`
          }
          data-direction={query.direction}
        >
          <span aria-hidden="true">{ascending ? "↑" : "↓"}</span>
        </button>
      </div>

      {/* Rendered only when something is narrowed. A permanently visible
          "clear" is a control that does nothing most of the time, and the
          count is what makes it honest about how much it will undo — the
          same rule the nav badges follow. */}
      {active > 0 && (
        <button type="button" className={styles.clear} onClick={onClearFilters}>
          <X size={13} aria-hidden="true" />
          <span>
            Clear {active} filter{active === 1 ? "" : "s"}
          </span>
        </button>
      )}
    </div>
  );
}
