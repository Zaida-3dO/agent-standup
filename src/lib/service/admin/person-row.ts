// Shared shape for the `person` write operation — the row as
// `update_person` returns it, and the mapping from a raw Postgres row to
// it. See docs/plans/SCHEMA.md §19, §8a. Same reasoning as `./repo-row.ts`:
// operations run against `TransactionHandle`, which exposes only
// `$queryRawUnsafe`/`$executeRawUnsafe`, so every read here maps columns by
// hand rather than trusting a generated client's typing.
//
// **Why this is a wider record than `list_people`'s `PersonRecord`.** The
// picker's read deliberately returns only what it renders (§8a — "nothing
// sensitive, nothing it doesn't render"), and in particular omits
// `notifyRules`, `createdAt` and `archivedAt`. A write, by contrast, has to
// read back what it just stored — a caller who sets `notifyRules` and is
// handed a record that cannot show them has no way to confirm the write,
// and a caller who archives someone needs to see `archivedAt` move. So the
// two shapes are different on purpose rather than one being a widening of
// the other, and `list_people` is left exactly as it was.

/** One `Person` row in full, as a write reads it back. */
export interface PersonAdminRecord {
  readonly id: string;
  readonly displayName: string;
  readonly avatar: string | null;
  readonly colour: string | null;
  /** The stored JSON, verbatim — snake_case buckets, as `parseStoredRules` expects. */
  readonly notifyRules: unknown;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

/** The raw shape `$queryRawUnsafe` returns for one `"Person"` row. */
export interface RawPersonAdminRow {
  id: string;
  displayName: string;
  avatar: string | null;
  colour: string | null;
  notifyRules: unknown;
  createdAt: Date | string;
  archivedAt: Date | string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toPersonAdminRecord(row: RawPersonAdminRow): PersonAdminRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    avatar: row.avatar,
    colour: row.colour,
    notifyRules: row.notifyRules ?? null,
    createdAt: isoOrNull(row.createdAt) as string,
    archivedAt: isoOrNull(row.archivedAt),
  };
}

export const PERSON_COLUMNS = [
  "id",
  '"displayName"',
  "avatar",
  "colour",
  '"notifyRules"',
  '"createdAt"',
  '"archivedAt"',
].join(", ");
