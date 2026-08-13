// Shared shape for the `area` admin operations — mirrors `./repo-row.ts`.
// See docs/plans/SCHEMA.md §23.1.

export interface AreaRecord {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

export interface RawAreaRow {
  id: string;
  displayName: string;
  createdAt: Date | string;
  archivedAt: Date | string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toAreaRecord(row: RawAreaRow): AreaRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    createdAt: isoOrNull(row.createdAt) as string,
    archivedAt: isoOrNull(row.archivedAt),
  };
}

export const AREA_COLUMNS = ["id", '"displayName"', '"createdAt"', '"archivedAt"'].join(", ");
