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
 * The eight axes a reader can narrow the board by — every filter
 * `get_board` accepts, which is the acceptance criterion this module exists
 * to meet. A key absent from the object is a filter not applied; there is no
 * "all" sentinel value, because an explicit `area=` in a URL and no `area`
 * at all would then mean different things while looking identical.
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
  "search",
] as const satisfies readonly (keyof BoardFilters)[];

export const BOARD_SORT_PARAM = "sort";
export const BOARD_DIRECTION_PARAM = "direction";

/** A board with nothing narrowed and the default ordering. */
export function emptyBoardQuery(): BoardQuery {
  return { filters: {}, sort: DEFAULT_BOARD_SORT, direction: DEFAULT_BOARD_SORT_DIRECTION };
}

/** True when no filter is applied — what decides whether an empty column blames a filter. */
export function isFiltered(filters: BoardFilters): boolean {
  return BOARD_FILTER_PARAMS.some((param) => filters[param] !== undefined);
}

/** How many axes are narrowed — the number on the "clear" control, so it says what it will undo. */
export function activeFilterCount(filters: BoardFilters): number {
  return BOARD_FILTER_PARAMS.filter((param) => filters[param] !== undefined).length;
}

/** What every accepted query-string source structurally provides. */
export interface QueryParamSource {
  get(name: string): string | null;
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
  const search = readParam(params, "search");
  if (search !== undefined) filters.search = search;

  const priority = readParam(params, "priority");
  if (priority !== undefined && (BOARD_FILTER_PRIORITIES as readonly string[]).includes(priority)) {
    filters.priority = priority as BoardFilters["priority"];
  }
  const kind = readParam(params, "kind");
  if (kind !== undefined && (BOARD_FILTER_KINDS as readonly string[]).includes(kind)) {
    filters.kind = kind as BoardFilters["kind"];
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
    const value = query.filters[name];
    if (value !== undefined && value !== "") params.set(name, value);
  }
  params.set(BOARD_SORT_PARAM, query.sort);
  params.set(BOARD_DIRECTION_PARAM, query.direction);
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  return params;
}

/** Applies one axis, or clears it when `value` is `undefined` or empty. */
export function withFilter<K extends keyof BoardFilters>(
  query: BoardQuery,
  key: K,
  value: BoardFilters[K] | undefined,
): BoardQuery {
  const filters = { ...query.filters };
  if (value === undefined || value === "") delete filters[key];
  else filters[key] = value;
  return { ...query, filters };
}

/** Clears every filter, keeping the ordering — what the "clear filter" control does. */
export function withoutFilters(query: BoardQuery): BoardQuery {
  return { ...query, filters: {} };
}
