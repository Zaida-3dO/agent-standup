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
import { Search, SlidersHorizontal, X } from "lucide-react";
import {
  BOARD_FILTER_KINDS,
  BOARD_FILTER_PRIORITIES,
  BOARD_FILTER_TRUST,
  BOARD_LEVEL_CHOICES,
  BOARD_LEVEL_TOP_BUCKET,
  BOARD_SORT_KEYS,
  activeFilterCount,
  defaultLevelFilter,
  type BoardFilters,
  type BoardLevelFilter,
  type BoardQuery,
  type BoardSortKey,
} from "@/lib/board/filters";
import {
  FILTER_VISIBILITY_CHOICES,
  canHide,
  isFilterVisible,
  type VisibleFilters,
} from "@/lib/board/visible-filters";
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
  /** The projects that exist — the vocabulary for the project-scope select. */
  readonly projects?: readonly FilterOption[];
  /**
   * Which axes render in the header (MILESTONES.md — the "More filters"
   * picker). Browser-local, never in the URL: see
   * `@/lib/board/visible-filters` for why the two are deliberately split.
   */
  readonly visibleFilters: VisibleFilters;
  readonly onVisibilityChange: (param: keyof BoardFilters, visible: boolean) => void;
  /** Whether the picker is open. Held by the container, like the search draft. */
  readonly pickerOpen?: boolean;
  readonly onTogglePicker?: () => void;
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
 * What each trust position is called in the menu.
 *
 * **Not `humanise()`d from the stored word**, unlike `state` and `kind`,
 * because the bare words mislead here. "Unverified" reads as a claim about
 * the WORK — that nobody has reviewed the task — when the actual claim is
 * about the ROW: its state was copied in from another system and has never
 * been checked against reality. Unlike `TrustBadge` (whose "Unchecked"
 * label deliberately carries no provenance — see that file's header), this
 * filter's `unverified`/`verified` positions ARE origin-gated
 * (`trustCondition()`, `trust-view.ts`: `originType === "source" AND
 * (not) checked`), so "Imported" is the accurate word here even though it
 * would be false on the badge.
 *
 * A `Record` over the vocabulary, so a fourth trust position would be a type
 * error here until it is given wording, rather than rendering as raw
 * `undefined` in a menu.
 */
const TRUST_LABELS: Record<(typeof BOARD_FILTER_TRUST)[number], string> = {
  trusted: "Trusted",
  unverified: "Imported, unchecked",
  verified: "Imported, checked",
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

/**
 * A level's reader-facing name. The top entry is a BUCKET, not a level —
 * nesting is unbounded, so the deepest choice has to mean "this and
 * anything deeper" or a store nested past the list would have rows no
 * choice could reach.
 */
function levelLabel(level: number): string {
  if (level === 0) return "Projects (level 0)";
  if (level === BOARD_LEVEL_TOP_BUCKET) return `Level ${BOARD_LEVEL_TOP_BUCKET}+`;
  return `Level ${level}`;
}

/**
 * The level axis: a mode toggle plus one checkbox per level.
 *
 * **Checkboxes rather than a multiple `<select>`.** A `<select multiple>` is
 * the control readers most often cannot operate — deselecting needs a
 * modifier key nothing on screen mentions, and one stray click clears the
 * whole set. Toggle chips follow the idiom already in this codebase
 * (`HistoryList`'s filter row), and each one carries its own accessible
 * name and pressed state.
 *
 * **The mode is announced in words, not by colour.** It is the difference
 * between "only these levels" and "everything but these", which reverses the
 * meaning of every chip beside it — the one thing on this control that must
 * not be conveyed by styling alone. Same reasoning as the sort-direction
 * button below.
 */
function LevelAxis({
  value,
  onChange,
}: {
  readonly value: BoardLevelFilter;
  readonly onChange: (value: BoardLevelFilter) => void;
}) {
  const include = value.mode === "include";
  const chosen = new Set(value.levels);
  const modeWords = include ? "Only these levels" : "Everything except";

  return (
    <div className={styles.axis} data-axis="level">
      <span className={styles.axisLabel} id="board-filter-level-label">
        Level
      </span>
      <div
        className={styles.levelGroup}
        role="group"
        aria-labelledby="board-filter-level-label"
        data-mode={value.mode}
      >
        <button
          id="board-filter-level-mode"
          type="button"
          className={styles.levelMode}
          data-mode={value.mode}
          aria-pressed={include}
          onClick={() => onChange({ ...value, mode: include ? "exclude" : "include" })}
          // The full sentence, because the two states mean opposite things
          // and a reader arriving on this control has to be able to tell
          // which one is active without inspecting the chips.
          aria-label={
            include
              ? "Showing only the levels ticked below — switch to excluding them instead"
              : "Showing everything except the levels ticked below — switch to only them instead"
          }
        >
          {modeWords}
        </button>
        {BOARD_LEVEL_CHOICES.map((level) => {
          const ticked = chosen.has(level);
          return (
            <button
              key={level}
              id={`board-filter-level-${level}`}
              type="button"
              className={styles.levelChip}
              data-level={level}
              data-active={ticked}
              aria-pressed={ticked}
              // Says what ticking this chip will DO, which depends on the
              // mode — a bare "Level 2" would read identically in the two
              // modes that show opposite boards.
              // The pressed state is carried by `aria-pressed`, which is
              // what a screen reader announces for a toggle; the name says
              // what ticking DOES, which depends on the mode and would
              // otherwise read identically in the two modes that show
              // opposite boards.
              aria-label={`${levelLabel(level)} — ${include ? "shown" : "hidden"} when ticked`}
              onClick={() => {
                const levels = ticked
                  ? value.levels.filter((entry) => entry !== level)
                  : [...value.levels, level];
                // An empty selection is meaningless in both modes — `include`
                // nothing shows an empty board and `exclude` nothing is no
                // filter — so emptying it returns to the board default
                // rather than to a state whose own control cannot escape it.
                onChange(levels.length === 0 ? defaultLevelFilter() : { ...value, levels });
              }}
            >
              {levelLabel(level)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The "More filters" picker — a checkbox per axis, deciding which controls
 * the header renders.
 *
 * This changes what the HEADER shows, never what the BOARD shows. That
 * distinction is why an axis that narrows the board cannot be unticked:
 * hiding it would leave the board filtered with no on-screen control to undo
 * it. The box is disabled and says why, rather than being enabled and doing
 * nothing.
 */
function MoreFiltersPicker({
  open,
  onToggle,
  visible,
  filters,
  onVisibilityChange,
}: {
  readonly open: boolean;
  readonly onToggle?: () => void;
  readonly visible: VisibleFilters;
  readonly filters: BoardFilters;
  readonly onVisibilityChange: (param: keyof BoardFilters, next: boolean) => void;
}) {
  const shown = FILTER_VISIBILITY_CHOICES.filter((choice) =>
    isFilterVisible(visible, choice.param),
  ).length;

  return (
    <div className={styles.picker}>
      <button
        id="board-more-filters"
        type="button"
        className={styles.pickerToggle}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="board-more-filters-menu"
        // The count is what makes the control honest about the state it is
        // hiding: a header missing an axis otherwise looks like a build that
        // forgot one.
        aria-label={`More filters — ${shown} of ${FILTER_VISIBILITY_CHOICES.length} controls shown`}
      >
        <SlidersHorizontal size={13} aria-hidden="true" />
        <span>More filters</span>
      </button>
      {open && (
        <div
          id="board-more-filters-menu"
          className={styles.pickerMenu}
          role="group"
          aria-label="Choose which filter controls to show"
        >
          <p className={styles.pickerHint}>
            Which controls appear in this bar. Saved in this browser — it is not part of the
            board&rsquo;s address, so a link you share is unaffected.
          </p>
          {FILTER_VISIBILITY_CHOICES.map((choice) => {
            const checked = isFilterVisible(visible, choice.param);
            const hideable = canHide(choice.param, filters);
            const locked = checked && !hideable;
            return (
              <label
                key={choice.param}
                className={styles.pickerRow}
                htmlFor={`board-show-${choice.param}`}
              >
                <input
                  id={`board-show-${choice.param}`}
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  onChange={(event) => onVisibilityChange(choice.param, event.target.checked)}
                />
                <span>{choice.label}</span>
                {locked && (
                  <span className={styles.pickerLocked}>
                    in use — clear it to hide this control
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
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
  projects = [],
  visibleFilters,
  onVisibilityChange,
  pickerOpen = false,
  onTogglePicker,
}: BoardFilterBarViewProps) {
  const active = activeFilterCount(query.filters);
  const ascending = query.direction === "asc";
  // One helper rather than the same `includes` at each of nine call sites:
  // an axis is rendered when the reader has it turned on.
  const shows = (param: keyof BoardFilters) => isFilterVisible(visibleFilters, param);
  // Never absent in practice — `parseBoardQuery` resolves an absent `level`
  // to the default — but the type allows it, and defaulting here is cheaper
  // than a non-null assertion that would be wrong if the shape ever changed.
  const level = query.filters.level ?? defaultLevelFilter();

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

      {/* Only the axes this reader has turned on. The set is browser-local
          and the values stay in the URL — see `@/lib/board/visible-filters`
          for why those two are deliberately different places.

          **A CSS-only checkbox disclosure collapses this block below 641px**
          (row 74ef86fb-9da8-4ab1-9b63-9eb84bd43ee6's second finding — 821px
          of chrome before the first card, because `.axes` alone measured
          ~400px of an ~540px bar at 320px). Tried `<details>` first and
          measured it broken: modern Chromium renders a closed `<details>`'s
          non-summary content through an internal `::details-content`
          mechanism that an author stylesheet's `display` override cannot
          reach, regardless of what `getComputedStyle` reports on the light
          DOM — every property read back as visible while the axes painted
          nothing. A checkbox has no such shadow content; the sibling
          selector in `BoardFilterBar.module.css` is ordinary CSS with
          nothing hidden from it.

          `defaultChecked` makes this uncontrolled by design: it is a
          display preference for THIS load, not a value the rest of the
          component tree reads or writes, so there is nothing to lift into
          state. `.axesToggle:checked ~ .axes` in the CSS shows the block on
          tap; desktop is unaffected by ABSENCE, not by an override — `.axes`
          is `display: flex` in its own base rule in `BoardFilterBar.module.css`
          and is only ever collapsed inside `@media (max-width: 640px)`, so a
          wide viewport never depends on the checkbox's state at all. No JS,
          no new stored preference: this is
          a second, orthogonal disclosure from the "More filters" picker
          below, which still decides WHICH axes exist; this only decides
          whether the existing set is showing right now on a narrow
          screen. */}
      <input
        type="checkbox"
        id="board-axes-toggle"
        className={styles.axesToggle}
        defaultChecked={false}
        // **No `aria-hidden`, no negative `tabIndex`.** Those two attributes
        // are for a decorative element with nothing behind them — the
        // opposite of what a visually-hidden-but-functional control needs.
        // With them, a keyboard user reached no filter at all below 641px,
        // which was strictly worse than the overflow this disclosure exists
        // to fix. A plain, unhidden, tabbable checkbox is the whole point
        // of the idiom this file's header already describes: real input,
        // invisible styling.
        onChange={(event) => {
          // Not React state — this component is hook-free by design (see
          // this file's header and `tests/board-filter-bar-component.test.ts`,
          // which calls it as a plain function with no renderer beneath it,
          // so a hook here would throw outside an actual React tree). The
          // checkbox's own `checked` is already live and browser-tracked
          // with zero code; this only keeps the VISIBLE trigger's
          // `aria-expanded` — which belongs on `label`, not on `checkbox`
          // (the `checkbox` role does not support `aria-expanded` in ARIA
          // 1.2 the way `button` does) — in sync with it after a toggle.
          const label = event.currentTarget.nextElementSibling;
          if (label instanceof HTMLElement) {
            label.setAttribute("aria-expanded", String(event.currentTarget.checked));
          }
        }}
      />
      <label
        htmlFor="board-axes-toggle"
        className={styles.axesSummary}
        // `role="button"` is what makes `aria-expanded` below land on a role
        // that supports it — ARIA 1.2 does not define `aria-expanded` for
        // the implicit `generic` role a plain `<label>` maps to (found in
        // review, row cd36e9fd-25e1-47f8-980c-7c0ea9a178a6: the attribute
        // was written and kept in sync correctly but never reached
        // assistive tech). This does not change the label's native
        // click-toggles-its-`htmlFor`-checkbox behaviour — that comes from
        // the DOM `<label>`/`for` relationship, not from the ARIA role — so
        // the hook-free checkbox toggle above is untouched.
        //
        // **Latent trap, row 40f75641-86f3-4828-8843-24460f732e50: this
        // label has NO `tabIndex`, so it is not keyboard-focusable — a real
        // `<button>` activates on Enter as well as Space, this one does
        // neither, but nothing can reach it to notice. Keyboard users land
        // on the native checkbox instead, where Space is correct and
        // Enter-does-nothing is standard checkbox behaviour, so as long as
        // that stays true there is no reachable failure mode.** The gap
        // becomes real the moment `tabIndex={0}` is added here without also
        // adding an Enter
        // handler — an easy, superficially sensible "make the button
        // focusable" edit that would make an element announcing as
        // `button` ignore half the keys a button user presses. If you are
        // adding `tabIndex` to this label, add an `onKeyDown` Enter handler
        // in the same change (see the checkbox's `onChange` above for how
        // this component keeps `aria-expanded` in sync without hooks).
        // Guarded by the "must not become focusable while Enter is
        // unhandled" test in tests/board-filter-bar-component.test.ts.
        role="button"
        aria-controls="board-axes-panel"
        // Matches `defaultChecked={false}` above — correct on first paint,
        // and kept correct after that by the `onChange` beside it.
        aria-expanded={false}
      >
        <SlidersHorizontal size={13} aria-hidden="true" />
        <span>Filters{active > 0 ? ` — ${active} active` : ""}</span>
      </label>
      <div id="board-axes-panel" className={styles.axes}>
        {shows("area") && (
          <AxisSelect
            id="board-filter-area"
            label="Area"
            value={query.filters.area}
            options={areas}
            onChange={(value) => onFilterChange("area", value)}
          />
        )}
        {shows("repo") && (
          <AxisSelect
            id="board-filter-repo"
            label="Repo"
            value={query.filters.repo}
            options={repos}
            onChange={(value) => onFilterChange("repo", value)}
          />
        )}
        {shows("assignee") && (
          <AxisSelect
            id="board-filter-assignee"
            label="On it"
            value={query.filters.assignee}
            options={assignees}
            onChange={(value) => onFilterChange("assignee", value)}
          />
        )}
        {shows("actor") && (
          <AxisSelect
            id="board-filter-actor"
            label="Raised by"
            value={query.filters.actor}
            options={people}
            onChange={(value) => onFilterChange("actor", value)}
          />
        )}
        {shows("priority") && (
          <AxisSelect
            id="board-filter-priority"
            label="Priority"
            value={query.filters.priority}
            options={BOARD_FILTER_PRIORITIES.map((value) => ({ value, label: value }))}
            onChange={(value) => onFilterChange("priority", value as BoardFilters["priority"])}
          />
        )}
        {shows("state") && (
          <AxisSelect
            id="board-filter-state"
            label="State"
            value={query.filters.state}
            options={ITEM_STATES.map((value) => ({ value, label: humanise(value) }))}
            onChange={(value) => onFilterChange("state", value)}
          />
        )}
        {shows("kind") && (
          <AxisSelect
            id="board-filter-kind"
            label="Kind"
            value={query.filters.kind}
            options={BOARD_FILTER_KINDS.map((value) => ({ value, label: humanise(value) }))}
            onChange={(value) => onFilterChange("kind", value as BoardFilters["kind"])}
          />
        )}
        {shows("project") && (
          <AxisSelect
            id="board-filter-project"
            label="Project"
            value={query.filters.project}
            options={projects}
            onChange={(value) => onFilterChange("project", value)}
          />
        )}
        {shows("trust") && (
          <AxisSelect
            id="board-filter-trust"
            label="Trust"
            value={query.filters.trust}
            // Labelled for what each position MEANS to a reader rather than
            // with the stored word. "Unverified" alone reads as a property
            // of the work ("nobody has reviewed this task"), when the claim
            // is narrower and about the row itself: its state was copied in
            // and never checked. `TRUST_LABELS` carries the wording; see
            // there. `AxisSelect` supplies the "Any" entry every other
            // control on this bar has, so a board narrowed by trust can be
            // widened from the control that narrowed it.
            options={BOARD_FILTER_TRUST.map((value) => ({ value, label: TRUST_LABELS[value] }))}
            onChange={(value) => onFilterChange("trust", value as BoardFilters["trust"])}
          />
        )}
        {shows("level") && (
          <LevelAxis value={level} onChange={(value) => onFilterChange("level", value)} />
        )}
      </div>

      <MoreFiltersPicker
        open={pickerOpen}
        onToggle={onTogglePicker}
        visible={visibleFilters}
        filters={query.filters}
        onVisibilityChange={onVisibilityChange}
      />

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
