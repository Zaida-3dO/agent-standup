// Shared shape for the `area` admin operations — mirrors `./repo-row.ts`.
// See docs/plans/SCHEMA.md §23.1.

export interface AreaRecord {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  /**
   * How many items carry this area — present on `list_areas`, absent on the
   * single-row reads that do not compute it.
   *
   * **This is what makes a near-duplicate visible.** Areas are free text with
   * find-or-create, so typing `website` where `web` exists silently produces
   * a second row; normalisation collapses case and separators but not
   * synonyms. Before this, nobody could answer "do we have near-duplicate
   * areas?" without querying the database, because a bare list of names does
   * not distinguish a real area from a typo somebody made once — the count
   * is exactly the fact that does. `web 41 / website 1` reads as a mistake at
   * a glance in a way `web / website` does not.
   *
   * Counted over `ItemArea`, the join table, not `Item.area`: an item may
   * sit in several areas and the join table is the complete set including
   * the primary one, so this is the same source of truth `areaFilterCondition`
   * filters on. A count taken from `Item.area` would under-report every area
   * that is some item's second one — and it would disagree with the number of
   * rows the board actually shows when you filter by it, which is the one
   * number this has to match.
   */
  readonly itemCount?: number;
}

export interface RawAreaRow {
  id: string;
  displayName: string;
  createdAt: Date | string;
  archivedAt: Date | string | null;
  /** Present only on the `list_areas` projection — Postgres `count()` returns `bigint`. */
  itemCount?: bigint | number | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toAreaRecord(row: RawAreaRow): AreaRecord {
  const record: AreaRecord = {
    id: row.id,
    displayName: row.displayName,
    createdAt: isoOrNull(row.createdAt) as string,
    archivedAt: isoOrNull(row.archivedAt),
  };
  // Omitted rather than defaulted to 0 when the projection did not compute
  // it: "no items" and "nobody counted" are different answers, and a zero
  // that means the second is the kind of confident wrong number somebody
  // later acts on. `Number()` because a Postgres `count()` arrives as a
  // `bigint`, which `JSON.stringify` throws on outright.
  if (row.itemCount === undefined || row.itemCount === null) return record;
  return { ...record, itemCount: Number(row.itemCount) };
}

export const AREA_COLUMNS = ["id", '"displayName"', '"createdAt"', '"archivedAt"'].join(", ");
