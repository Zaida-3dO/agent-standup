// The board's filter/sort state, and the URL it is carried in — MILESTONES.md
// #75.
//
// **The URL is the state, not a copy of it.** There is no separate filter
// store that the address bar is kept in step with; `parseBoardQuery` reads
// the query string and `boardQueryString` writes it, and the component tree
// holds nothing else. That is what makes a filtered board *linkable*: paste
// the address into another tab and you get the same board, because there is
// no in-memory state that the address failed to mention.
//
// It is also a **contract with other screens**. A chip on an item's detail
// page — its area, its repo, its priority — links back to a board narrowed
// to that chip, and it does so by building one of these query strings. So
// the parameter names below are load-bearing across features: renaming
// `area` to `areaId` here silently breaks every link built elsewhere,
// because a query parameter this module does not recognise is ignored
// rather than refused (see `parseBoardQuery`).
//
// Pure functions over plain data — no hooks, no `window` — so the whole
// round trip is testable in this repo's DOM-free harness
// (`vitest.config.ts`: `environment: "node"`).

import {
  BOARD_SORT_KEYS,
  BOARD_SORT_DIRECTIONS,
  DEFAULT_BOARD_SORT,
  DEFAULT_BOARD_SORT_DIRECTION,
  type BoardSortKey,
  type BoardSortDirection,
} from "./sort";

export { BOARD_SORT_KEYS, BOARD_SORT_DIRECTIONS, DEFAULT_BOARD_SORT, DEFAULT_BOARD_SORT_DIRECTION };
export type { BoardSortKey, BoardSortDirection };

/** The `kind` vocabulary, as a runtime list — the type alone is erased. */
export const BOARD_FILTER_KINDS = ["project", "task", "subtask"] as const;

/** The `priority` vocabulary. */
export const BOARD_FILTER_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/**
 * The `trust` vocabulary — whether a row's state can be taken on faith
 * (MILESTONES.md #131).
 *
 * Identical to `get_board`'s own enum, and deliberately so: the address bar
 * and the API share one vocabulary (see `BOARD_FILTER_PARAMS`), so a value
 * that reads well in a URL is the same value the operation validates. See
 * that schema for what each position means and why there are three rather
 * than a boolean.
 */
export const BOARD_FILTER_TRUST = ["trusted", "unverified", "verified"] as const;

/**
 * The deepest level the bar offers as a level of its own. Everything at or
 * below it is offered as one bucket — see `BOARD_LEVEL_CHOICES`.
 */
export const BOARD_LEVEL_TOP_BUCKET = 5;

/**
 * The levels a reader can pick, as a runtime list.
 *
 * **The last entry is a bucket, not a level.** Nesting is unbounded — the
 * `items.max_depth` setting is a runaway guard an installation configures,
 * not a ceiling — so a fixed list of individual levels would silently be
 * unable to express the deepest rows in a store configured past it. `5`
 * therefore means "5 or deeper" everywhere in the UI, and is expanded to the
 * levels it covers on the way to the API.
 */
export const BOARD_LEVEL_CHOICES = [0, 1, 2, 3, 4, BOARD_LEVEL_TOP_BUCKET] as const;

/** Which way a level selection reads: only these levels, or everything but them. */
export const BOARD_LEVEL_MODES = ["include", "exclude"] as const;

export type BoardLevelMode = (typeof BOARD_LEVEL_MODES)[number];

/**
 * A level selection: a mode and the levels it applies to.
 *
 * `include(1,2)` is "only level 1 and level 2" — a level-3 subtask under a
 * level-2 task is EXCLUDED, because membership is asked of each row on its
 * own and never of its ancestry. `exclude(0)` is "everything except
 * projects".
 *
 * `levels` is always sorted ascending and de-duplicated by `normaliseLevels`,
 * which is what makes one selection have one URL — see `boardQueryString`.
 */
export interface BoardLevelFilter {
  readonly mode: BoardLevelMode;
  readonly levels: readonly number[];
}

/**
 * The board's level filter when the URL says nothing: everything except
 * projects.
 *
 * **A default rather than "no filter"**, and the distinction is the whole
 * design. A project's row on the board is a rollup of its subtree, so a
 * default board that listed every project alongside the work inside it would
 * double-count the same work in two places. A reader who genuinely wants
 * projects in the list asks for them, and the URL then says so.
 *
 * Declared here rather than in `get_board`'s schema deliberately: the
 * operation defaults nothing, so a caller that names no level still gets an
 * unnarrowed read. Defaulting in the service would change what every
 * existing non-board caller receives from a call it did not change.
 */
export function defaultLevelFilter(): BoardLevelFilter {
  return { mode: "exclude", levels: [0] };
}

/**
 * The ten axes a reader can narrow the board by — every filter `get_board`
 * accepts, which is the acceptance criterion this module exists to meet. A
 * key absent from the object is a filter not applied; there is no "all"
 * sentinel value, because an explicit `area=` in a URL and no `area` at all
 * would then mean different things while looking identical.
 *
 * **`level` is the one exception to that sentence, and it is deliberate.**
 * Absent means the board's default of `exclude(0)`, not "unfiltered", and
 * `parseBoardQuery` resolves it to that default. See `defaultLevelFilter`
 * for why a default board hides projects, and `levelIsDefault` for how an
 * address avoids carrying a parameter that says only what absence already
 * said.
 */
export interface BoardFilters {
  readonly area?: string;
  readonly repo?: string;
  /** A live assignment's holder — "who's on it". */
  readonly assignee?: string;
  /** The item's origin person — "whose idea it was". */
  readonly actor?: string;
  readonly priority?: (typeof BOARD_FILTER_PRIORITIES)[number];
  readonly state?: string;
  readonly kind?: (typeof BOARD_FILTER_KINDS)[number];
  /**
   * Which tree levels to show. Absent means the board default,
   * `exclude(0)` — never "no level narrowing".
   */
  readonly level?: BoardLevelFilter;
  /** One project id — the board is scoped to that project's whole subtree. */
  readonly project?: string;
  /**
   * Whether a row's state can be taken on faith (MILESTONES.md #131).
   *
   * Absent means no trust narrowing — unlike `level`, this has no default,
   * because a board that silently hid unverifiable rows would be hiding
   * exactly the rows the marking exists to draw attention to.
   */
  readonly trust?: (typeof BOARD_FILTER_TRUST)[number];
  /** Free-text. See `get-board.ts` for what this does and does not do. */
  readonly search?: string;
}

/** Filters plus ordering — the whole of what a board URL encodes. */
export interface BoardQuery {
  readonly filters: BoardFilters;
  readonly sort: BoardSortKey;
  readonly direction: BoardSortDirection;
}

/**
 * The parameter name each filter is carried under.
 *
 * **Identical to the API's own parameter names, deliberately.** The board's
 * address bar and `GET /api/board`'s query string use one vocabulary, so a
 * reader who has learned one has learned the other and a link can be built
 * from either without a translation table that could drift.
 */
export const BOARD_FILTER_PARAMS = [
  "area",
  "repo",
  "assignee",
  "actor",
  "priority",
  "state",
  "kind",
  "level",
  "project",
  // Appended AFTER the existing axes rather than inserted among them.
  // `boardQueryString` emits in this order and a saved view is matched by
  // string equality, so re-ordering this list would change the address of
  // every already-saved view and silently stop each one marking itself
  // current. New axes go on the end.
  "trust",
  "search",
] as const satisfies readonly (keyof BoardFilters)[];

export const BOARD_SORT_PARAM = "sort";
export const BOARD_DIRECTION_PARAM = "direction";

/**
 * A board with nothing narrowed and the default ordering.
 *
 * `level` is present and set to the default rather than absent, because
 * absent means the default anyway (`parseBoardQuery` resolves it) and an
 * explicit value is what makes this object equal to what parsing an empty
 * query string produces — `boardQueryString(emptyBoardQuery())` is still
 * `""`, since a default level emits no parameter.
 */
export function emptyBoardQuery(): BoardQuery {
  return {
    filters: { level: defaultLevelFilter() },
    sort: DEFAULT_BOARD_SORT,
    direction: DEFAULT_BOARD_SORT_DIRECTION,
  };
}

/**
 * A level list in the one canonical form: ascending, de-duplicated.
 *
 * **This is what makes one filter selection have one address.** The URL
 * carries the levels as a list, so `1,2` and `2,1` and `2,1,2` are three
 * spellings a reader can arrive at by clicking checkboxes in a different
 * order — and three different query strings for one board would break the
 * saved-view marker, which decides "this is the view you are looking at" by
 * comparing query strings for equality. Ordering the values is the value-level
 * half of the same determinism `BOARD_FILTER_PARAMS` ordering gives the
 * parameters.
 */
export function normaliseLevels(levels: readonly number[]): readonly number[] {
  return [...new Set(levels)].sort((a, b) => a - b);
}

/** A level selection in canonical form — the only form this module stores or emits. */
export function normaliseLevelFilter(filter: BoardLevelFilter): BoardLevelFilter {
  return { mode: filter.mode, levels: normaliseLevels(filter.levels) };
}

/**
 * Whether a selection is the board's default, and so needs no parameter.
 *
 * Compared on the canonical form, so a default arrived at by clicking rather
 * than by loading `/board` is recognised as the default and drops out of the
 * address — otherwise a reader who unticked "Projects" and re-ticked it
 * would end up at a different URL for the same board than the one they
 * started at.
 */
export function levelIsDefault(filter: BoardLevelFilter): boolean {
  const canonical = normaliseLevelFilter(filter);
  const fallback = defaultLevelFilter();
  return (
    canonical.mode === fallback.mode &&
    canonical.levels.length === fallback.levels.length &&
    canonical.levels.every((level, index) => level === fallback.levels[index])
  );
}

/**
 * A level selection as it appears in a URL: `exclude:0`, `include:1,2`.
 *
 * One parameter carrying a mode and a list rather than two parameters, or a
 * repeated `level=1&level=2`. A mode split across parameters can arrive
 * half-set from a hand-edited link — `mode=include` with no levels is not a
 * filter anyone meant — and this form keeps the whole selection atomic:
 * either the value parses as a complete selection or it is dropped entirely,
 * which is the same rule every other axis here follows.
 */
export function formatLevelFilter(filter: BoardLevelFilter): string {
  const canonical = normaliseLevelFilter(filter);
  return `${canonical.mode}:${canonical.levels.join(",")}`;
}

/**
 * Reads `exclude:0` / `include:1,2` back, or `undefined` if it is not a
 * complete, well-formed selection.
 *
 * **Unparseable is dropped, never partially honoured** — the same rule
 * `parseBoardQuery` applies to an unknown `priority`. A hand-edited
 * `level=include:` or `level=nonsense` renders the default board, which the
 * reader can see and correct, rather than a 400 they cannot.
 */
export function parseLevelFilter(raw: string): BoardLevelFilter | undefined {
  const separator = raw.indexOf(":");
  if (separator === -1) return undefined;
  const mode = raw.slice(0, separator);
  if (!(BOARD_LEVEL_MODES as readonly string[]).includes(mode)) return undefined;

  const levels: number[] = [];
  for (const part of raw.slice(separator + 1).split(",")) {
    const trimmed = part.trim();
    // `Number("")` is 0, so an empty segment would silently become level 0 —
    // "projects" — which is the one value that most changes what the board
    // shows. Refusing the whole value is the honest reading of `include:`.
    if (!/^\d+$/.test(trimmed)) return undefined;
    levels.push(Number(trimmed));
  }
  if (levels.length === 0) return undefined;
  return { mode: mode as BoardLevelMode, levels: normaliseLevels(levels) };
}

/**
 * True when no filter is applied — what decides whether an empty column
 * blames a filter.
 *
 * **The default level filter does not count as narrowing.** It is applied to
 * every board including the one a reader lands on having chosen nothing, so
 * counting it would put a permanent "1 filter" on an untouched board and
 * make the empty-column message blame a filter nobody set.
 */
export function isFiltered(filters: BoardFilters): boolean {
  return BOARD_FILTER_PARAMS.some((param) => isNarrowed(filters, param));
}

/** Whether one axis is narrowed — the default level filter is not. */
function isNarrowed(filters: BoardFilters, param: (typeof BOARD_FILTER_PARAMS)[number]): boolean {
  const value = filters[param];
  if (value === undefined) return false;
  if (param === "level") return !levelIsDefault(value as BoardLevelFilter);
  return true;
}

/** How many axes are narrowed — the number on the "clear" control, so it says what it will undo. */
export function activeFilterCount(filters: BoardFilters): number {
  return BOARD_FILTER_PARAMS.filter((param) => isNarrowed(filters, param)).length;
}

/** What every accepted query-string source structurally provides. */
export interface QueryParamSource {
  get(name: string): string | null;
  /**
   * Every value for one name.
   *
   * **Optional, because not every source has one.** A caller can hand this
   * module any object with a `get` — `tests` do, and so does anything
   * hand-rolled — and requiring `getAll` would break those for the sake of
   * one parameter. `readParam` falls back to `get` when it is absent, which
   * reads the first value: enough for every scalar axis, and `level` carries
   * its whole selection in a single value anyway (see `formatLevelFilter`),
   * so nothing silently loses information by taking the fallback.
   */
  getAll?(name: string): readonly string[];
}

/**
 * Reads one param, treating an empty or whitespace-only value as absent.
 *
 * An empty value is dropped rather than kept because the two ways a reader
 * reaches one are both "no filter": clearing a text box leaves `search=`
 * behind, and a hand-trimmed URL can too. Keeping it would send `search=""`
 * to an API whose schema requires at least one character, turning a cleared
 * box into a 400.
 */
function readParam(params: QueryParamSource, name: string): string | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Reads a board query out of a query string.
 *
 * **Unrecognised values are dropped, never passed through.** A `priority=P9`
 * in a hand-edited URL is ignored rather than sent to the API, so a bad link
 * renders an unfiltered board instead of an error page — the reader can see
 * what they have and fix it, which they cannot do from a 400. The same rule
 * covers an unknown sort key, which falls back to the default ordering.
 *
 * Accepts a string or anything with a `get(name)` — a `URLSearchParams`, or
 * Next's `ReadonlyURLSearchParams`, which is not an instance of the former
 * in every runtime and so is read structurally rather than cast.
 */
export function parseBoardQuery(input: string | QueryParamSource): BoardQuery {
  const params: QueryParamSource = typeof input === "string" ? new URLSearchParams(input) : input;

  const filters: {
    -readonly [K in keyof BoardFilters]: BoardFilters[K];
  } = {};

  const area = readParam(params, "area");
  if (area !== undefined) filters.area = area;
  const repo = readParam(params, "repo");
  if (repo !== undefined) filters.repo = repo;
  const assignee = readParam(params, "assignee");
  if (assignee !== undefined) filters.assignee = assignee;
  const actor = readParam(params, "actor");
  if (actor !== undefined) filters.actor = actor;
  const project = readParam(params, "project");
  if (project !== undefined) filters.project = project;
  const search = readParam(params, "search");
  if (search !== undefined) filters.search = search;

  // **Absent resolves to the board default, not to "unfiltered".** This is
  // the one axis where a missing parameter means something rather than
  // nothing — see `defaultLevelFilter`. An unparseable value resolves to the
  // default too, for the same reason an unknown `priority` is dropped: a bad
  // link should render a board the reader can see and fix.
  const rawLevel = readParam(params, "level");
  filters.level =
    (rawLevel === undefined ? undefined : parseLevelFilter(rawLevel)) ?? defaultLevelFilter();

  const priority = readParam(params, "priority");
  if (priority !== undefined && (BOARD_FILTER_PRIORITIES as readonly string[]).includes(priority)) {
    filters.priority = priority as BoardFilters["priority"];
  }
  const kind = readParam(params, "kind");
  if (kind !== undefined && (BOARD_FILTER_KINDS as readonly string[]).includes(kind)) {
    filters.kind = kind as BoardFilters["kind"];
  }
  // Validated against the closed vocabulary here, unlike `state`, because
  // this list is short, fixed, and already duplicated in the operation's
  // schema — so a hand-edited `trust=maybe` is dropped and renders an
  // unfiltered board rather than being forwarded to an API that would
  // refuse it with a 400 the reader cannot act on.
  const trust = readParam(params, "trust");
  if (trust !== undefined && (BOARD_FILTER_TRUST as readonly string[]).includes(trust)) {
    filters.trust = trust as BoardFilters["trust"];
  }
  // `state` is not validated against the twelve-value vocabulary here. The
  // list lives in the service layer and in `@/lib/design/tokens`, and a
  // third copy in the URL codec is a third place to forget a new state —
  // the API refuses an unknown one on its own terms, which is one refusal
  // in one place rather than two that can disagree.
  const state = readParam(params, "state");
  if (state !== undefined) filters.state = state;

  const rawSort = readParam(params, BOARD_SORT_PARAM);
  const sort: BoardSortKey =
    rawSort !== undefined && (BOARD_SORT_KEYS as readonly string[]).includes(rawSort)
      ? (rawSort as BoardSortKey)
      : DEFAULT_BOARD_SORT;

  const rawDirection = readParam(params, BOARD_DIRECTION_PARAM);
  const direction: BoardSortDirection =
    rawDirection !== undefined &&
    (BOARD_SORT_DIRECTIONS as readonly string[]).includes(rawDirection)
      ? (rawDirection as BoardSortDirection)
      : DEFAULT_BOARD_SORT_DIRECTION;

  return { filters, sort, direction };
}

/**
 * Writes a board query back to a query string — the inverse of
 * `parseBoardQuery` for every query the parser can produce.
 *
 * **A default is omitted rather than written.** A board in its default
 * ordering has no `sort` in its address, so the common URL is the short one
 * and a link that carries `sort` is a link that means it. The round trip
 * still holds, because the parser resolves an absent key to the same
 * default.
 *
 * Parameters are emitted in `BOARD_FILTER_PARAMS` order, so the same board
 * always produces the same string — two readers who arrive at one board by
 * different routes get one shared address rather than two that differ only
 * in ordering.
 */
export function boardQueryString(query: BoardQuery): string {
  const params = new URLSearchParams();
  for (const name of BOARD_FILTER_PARAMS) {
    if (name === "level") {
      // Omitted when it is the default, exactly as a default sort is: the
      // common address stays the short one, and a link carrying a `level`
      // is a link that means it. The round trip still holds because
      // `parseBoardQuery` resolves an absent `level` to the same default.
      const level = query.filters.level;
      if (level !== undefined && !levelIsDefault(level)) {
        params.set(name, formatLevelFilter(level));
      }
      continue;
    }
    const value = query.filters[name];
    if (value !== undefined && value !== "") params.set(name, value);
  }
  if (query.sort !== DEFAULT_BOARD_SORT) params.set(BOARD_SORT_PARAM, query.sort);
  if (query.direction !== DEFAULT_BOARD_SORT_DIRECTION) {
    params.set(BOARD_DIRECTION_PARAM, query.direction);
  }
  return params.toString();
}

/**
 * The board's address for a query — what a link on another screen points at.
 *
 * The unfiltered board is `/board` with no trailing `?`, because an empty
 * query string in an address bar reads as a filter that failed to apply.
 */
export function boardHref(query: BoardQuery, basePath = "/board"): string {
  const qs = boardQueryString(query);
  return qs === "" ? basePath : `${basePath}?${qs}`;
}

/**
 * The board, scoped to one project's subtree, with the default level filter.
 *
 * **This is where a project card on the grid leads.** The grid answers "what
 * projects are there"; the question a reader has after picking one is "what
 * is the work under it", and that is a board rather than a rollup page. The
 * project's own row on the board remains the way to its detail page, so both
 * destinations stay reachable and each is reached from the surface that
 * makes it the obvious next question.
 *
 * Built through `boardHref` rather than by concatenating a string, so this
 * link is emitted by the same encoder every other board link is — a
 * hand-built query string is exactly how a link comes to name a parameter
 * the board does not read, which reads as navigation and silently does
 * nothing.
 *
 * **The address is `?project=<id>`, and it carries NO `level` parameter.**
 * That is the same board as `?project=<id>&level=exclude:0` — an absent
 * `level` parses to exactly that default (`parseBoardQuery`) — and it is
 * spelled the shorter way on purpose: `boardQueryString` omits a default so
 * that ONE board has ONE address. Writing the default explicitly here would
 * give this link a different string from the one the bar produces the moment
 * the reader touches any other control, and the saved-view marker decides
 * "you are looking at this view" by comparing those strings for equality.
 * Two spellings of one board is precisely the defect that determinism rule
 * exists to prevent.
 */
export function projectBoardHref(projectId: string): string {
  return boardHref({
    filters: { project: projectId, level: defaultLevelFilter() },
    sort: DEFAULT_BOARD_SORT,
    direction: DEFAULT_BOARD_SORT_DIRECTION,
  });
}

/**
 * The query string the board sends to `GET /api/board` for one column.
 *
 * Built from the same `BoardQuery` the address bar carries, which is the
 * property that makes a pasted URL reproduce the board: there is no second
 * translation that could apply a filter to the request but not the address,
 * or the reverse.
 *
 * Unlike `boardQueryString`, this **always** writes the sort. The default is
 * omitted from an address for readability; omitting it from a request would
 * mean the API's default and this module's default have to stay equal
 * forever, and they are declared in different files.
 */
export function boardRequestParams(
  query: BoardQuery,
  options: { readonly column: string; readonly cursor?: string },
): URLSearchParams {
  const params = new URLSearchParams({ column: options.column });
  for (const name of BOARD_FILTER_PARAMS) {
    if (name === "level") {
      // Unlike the address, the REQUEST always carries the level — including
      // the default. The same reasoning the sort already follows two lines
      // below: omitting it would require this module's default and the
      // operation's to stay equal forever, and `get_board` deliberately has
      // no default for `level` at all, so omitting it here would silently
      // widen the board to include every project.
      const level = query.filters.level ?? defaultLevelFilter();
      params.set(name, formatLevelFilter(level));
      continue;
    }
    const value = query.filters[name];
    if (value !== undefined && value !== "") params.set(name, value);
  }
  params.set(BOARD_SORT_PARAM, query.sort);
  params.set(BOARD_DIRECTION_PARAM, query.direction);
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  return params;
}

/**
 * Applies one axis, or clears it when `value` is `undefined` or empty.
 *
 * A cleared `level` becomes the board default rather than absent, because
 * absent already MEANS the default — leaving the key off would produce a
 * `BoardFilters` whose `level` reads as `undefined` while the board it
 * describes is still excluding projects, and every consumer would then have
 * to remember to re-apply the default itself.
 */
export function withFilter<K extends keyof BoardFilters>(
  query: BoardQuery,
  key: K,
  value: BoardFilters[K] | undefined,
): BoardQuery {
  const filters = { ...query.filters };
  if (key === "level") {
    filters.level =
      value === undefined ? defaultLevelFilter() : normaliseLevelFilter(value as BoardLevelFilter);
    return { ...query, filters };
  }
  if (value === undefined || value === "") delete filters[key];
  else filters[key] = value;
  return { ...query, filters };
}

/**
 * Clears every filter, keeping the ordering — what the "clear filter"
 * control does.
 *
 * The level returns to its default rather than to nothing, for the reason
 * `withFilter` gives: "no level filter" is not a state this board has.
 */
export function withoutFilters(query: BoardQuery): BoardQuery {
  return { ...query, filters: { level: defaultLevelFilter() } };
}
