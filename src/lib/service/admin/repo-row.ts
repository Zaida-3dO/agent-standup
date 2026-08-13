// Shared shape for the `repo` admin operations — the row as `repos` returns
// it, and the mapping from a raw Postgres row to it. See docs/plans/
// SCHEMA.md §23.1, §19. Same reasoning as `../items/row.ts`: operations run
// against `TransactionHandle`, which exposes only
// `$queryRawUnsafe`/`$executeRawUnsafe`, so every read here maps columns by
// hand rather than trusting a generated client's typing.

export interface RepoRecord {
  readonly id: string;
  readonly displayName: string;
  readonly defaultBranch: string;
  readonly host: string | null;
  readonly needsVisualReview: boolean;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

/** The raw shape `$queryRawUnsafe` returns for one `"Repo"` row. */
export interface RawRepoRow {
  id: string;
  displayName: string;
  defaultBranch: string;
  host: string | null;
  needsVisualReview: boolean;
  createdAt: Date | string;
  archivedAt: Date | string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toRepoRecord(row: RawRepoRow): RepoRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    defaultBranch: row.defaultBranch,
    host: row.host,
    needsVisualReview: row.needsVisualReview,
    createdAt: isoOrNull(row.createdAt) as string,
    archivedAt: isoOrNull(row.archivedAt),
  };
}

export const REPO_COLUMNS = [
  "id",
  '"displayName"',
  '"defaultBranch"',
  "host",
  '"needsVisualReview"',
  '"createdAt"',
  '"archivedAt"',
].join(", ");
