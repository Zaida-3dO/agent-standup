// Counting what still points at a reference row, for the hard-delete guard
// (MILESTONES.md #96, SCHEMA.md §23.1's "Archive, never delete — attribution
// and history point at these rows").
//
// ── Why this table is written out by hand ────────────────────────────────
//
// A hard delete is refused unless *every* referring column counts zero, and
// the guard is only as good as its list of referring columns. A column this
// file forgets is not a missing count in a report — it is a foreign-key
// violation raised at the `DELETE`, or worse, a row deleted while something
// still points at it.
//
// The list is therefore explicit rather than derived. Prisma's relation
// metadata is not consulted at runtime on purpose: the referring side of a
// relation is spelled in the *schema*, and a query planner that walked it
// would produce a list nobody has read. `tests/reference-counts.test.ts`
// pins this table against `prisma/schema.prisma` itself, so adding a new
// column that references one of these three entities and not adding it here
// fails a test rather than shipping a guard with a hole in it.
//
// ── The entities ────────────────────────────────────────────────────────
//
// Three, and only three, carry `archivedAt` and are hard-deletable: `Repo`,
// `Area`, `Person`. `Item` is not one of them — an item is archived by
// `delete_item`, which never removes a row, and there is no hard delete for
// items at all.

/** One column, somewhere, that holds a foreign key into a reference row. */
export interface ReferringColumn {
  /** The table holding the reference, quoted exactly as Postgres needs it. */
  readonly table: string;
  /** The column within it. */
  readonly column: string;
  /**
   * How this reference reads in a refusal message — a human phrase, because
   * `"Item"."originPersonId"` tells a person nothing about what they must
   * fix, and "items that originated from them" tells them exactly.
   */
  readonly label: string;
}

/** The entities that can be archived and, when unreferenced, hard-deleted. */
export const REFERENCE_ENTITIES = ["repo", "area", "person"] as const;

export type ReferenceEntity = (typeof REFERENCE_ENTITIES)[number];

/**
 * Every column holding a foreign key into each reference entity.
 *
 * Kept in the same order the refusal reports them, so two runs against the
 * same data produce byte-identical messages.
 */
export const REFERRING_COLUMNS: Record<ReferenceEntity, readonly ReferringColumn[]> = {
  repo: [{ table: "Item", column: "repo", label: "items in this repo" }],
  area: [
    { table: "Item", column: "area", label: "items whose primary area this is" },
    { table: "ItemArea", column: "areaId", label: "items also tagged with this area" },
  ],
  person: [
    { table: "Item", column: "originPersonId", label: "items that originated from them" },
    { table: "Item", column: "blockedOnPersonId", label: "items blocked on them" },
    { table: "EventSeen", column: "personId", label: "events they have marked seen" },
    { table: "Authorization", column: "grantedById", label: "authorizations they granted" },
    { table: "Session", column: "personId", label: "sessions registered to them" },
  ],
};

/** The table each entity's own row lives in. */
export const ENTITY_TABLE: Record<ReferenceEntity, string> = {
  repo: "Repo",
  area: "Area",
  person: "Person",
};

/** A single referring column's count, for a refusal that reports the totals. */
export interface ReferenceCount {
  readonly table: string;
  readonly column: string;
  readonly label: string;
  readonly count: number;
}

/**
 * Renders counts into the sentence a refusal carries.
 *
 * Only non-zero counts appear — listing every column with "0" buries the one
 * line the reader needs among four that do not apply to them.
 */
export function describeReferenceCounts(counts: readonly ReferenceCount[]): string {
  return counts
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.label}`)
    .join(", ");
}
