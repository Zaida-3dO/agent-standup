// The vocabularies the filter bar's selects offer — MILESTONES.md #75.
//
// Three of the eight axes have a closed vocabulary the code already knows
// (`priority`, `kind`, `state`), and those are read straight from the
// constants. The other three — areas, repos, people — are rows in the store,
// so they are fetched.
//
// **A failed options read leaves the axis usable, not broken.** Each fetch
// resolves to an empty list rather than throwing, and an axis with no
// options still renders with its "Any" entry — so a board whose `/api/areas`
// is down is a board you cannot filter by area, not a board that will not
// load. The filters themselves live in the URL, so a link carrying
// `area=web` still works even when the select that would have offered it
// came back empty.
//
// Every request goes through `uiApiPath`, like every other front-end read:
// a call from the browser carries no credential and the API refuses it, so
// the front end talks to the forwarding route that attaches the server's own
// token. `tests/ui-proxy-paths.test.ts` enforces that no module here writes a
// bare `/api/` literal.
//
// Pure fetch shaping, no hooks — testable against a stub `fetch` in a
// DOM-free harness.

import { uiApiPath } from "@/lib/ui-proxy/path";

/** One choosable value: what goes in the URL, and what the reader reads. */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** Everything the bar's selects need, in one object so the container holds one piece of state. */
export interface FilterOptions {
  readonly areas: readonly FilterOption[];
  readonly repos: readonly FilterOption[];
  readonly people: readonly FilterOption[];
  /** The projects the board can be scoped to — see `fetchFilterOptions`. */
  readonly projects: readonly FilterOption[];
}

export function emptyFilterOptions(): FilterOptions {
  return { areas: [], repos: [], people: [], projects: [] };
}

/**
 * Reads one collection endpoint, resolving any failure to an empty list.
 *
 * Takes an already-proxied path rather than applying `uiApiPath` itself, so
 * the `/api/…` literal and the call that rewrites it sit on the same line at
 * each call site — which is what `tests/ui-proxy-paths.test.ts` reads, and
 * is the more honest arrangement anyway: a helper that silently rewrote its
 * argument would make the address a caller passes not the address it gets.
 */
async function fetchOptions(
  fetchImpl: typeof fetch,
  path: string,
  key: string,
  toOption: (row: Record<string, unknown>) => FilterOption | null,
): Promise<readonly FilterOption[]> {
  try {
    const response = await fetchImpl(path);
    if (!response.ok) return [];
    const body = (await response.json()) as Record<string, unknown>;
    const rows = body[key];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      .map(toOption)
      .filter((option): option is FilterOption => option !== null);
  } catch {
    return [];
  }
}

/** A row's `id`, or `null` when it has none usable as a filter value. */
function idOf(row: Record<string, unknown>): string | null {
  const id = row.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * The display name a row carries, falling back to its id.
 *
 * The fallback matters: an area's id is what the filter sends and what a
 * URL shows, so a row with no display name still produces a usable, honest
 * option rather than a blank line in a menu.
 */
function labelOf(row: Record<string, unknown>, id: string, ...fields: readonly string[]): string {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return id;
}

/**
 * Loads every store-backed vocabulary at once.
 *
 * In parallel: the three reads are independent, and serialising them would
 * make the bar's slowest select decide when any of them can be used.
 */
export async function fetchFilterOptions(fetchImpl: typeof fetch = fetch): Promise<FilterOptions> {
  const [areas, repos, people, projects] = await Promise.all([
    fetchOptions(fetchImpl, uiApiPath("/api/areas"), "areas", (row) => {
      const id = idOf(row);
      return id === null ? null : { value: id, label: labelOf(row, id, "displayName", "name") };
    }),
    fetchOptions(fetchImpl, uiApiPath("/api/repos"), "repos", (row) => {
      const id = idOf(row);
      return id === null ? null : { value: id, label: labelOf(row, id, "displayName", "name") };
    }),
    fetchOptions(fetchImpl, uiApiPath("/api/people"), "people", (row) => {
      const id = idOf(row);
      return id === null ? null : { value: id, label: labelOf(row, id, "displayName", "name") };
    }),
    // The project-scope vocabulary. A project is labelled by its `title` —
    // unlike an area or a repo, whose id is a readable slug, a project id is
    // a UUID and would make the menu unusable if the fallback ever showed.
    // `labelOf` still falls back to the id, which is the honest last resort:
    // an unreadable option a reader can still select beats a blank line.
    fetchOptions(fetchImpl, uiApiPath("/api/projects"), "projects", (row) => {
      const id = idOf(row);
      return id === null ? null : { value: id, label: labelOf(row, id, "title", "displayName") };
    }),
  ]);
  return { areas, repos, people, projects };
}
