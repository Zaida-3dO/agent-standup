// `list_people` — SCHEMA.md §19 `GET /people`: "Profiles. Archive rather
// than delete; attribution rows point here." §8a: "Netflix-style profile
// picker on first load … anyone who can reach the app can pick any
// profile." MILESTONES.md #35, #116, T13.
//
// The one read the front-end needs, for both its callers: the profile
// picker (every profile it may offer) and the administration surface
// (`/admin/people`, T13), which also needs to show and toggle archived
// rows — the same split `list_repos` already makes for `repos`.
//
// **Archived profiles are excluded by default** — §8a archives rather than
// deletes specifically so attribution rows keep working, not so an archived
// profile keeps showing up as something new work can be claimed under — but
// `includeArchived` widens that for the admin grid, mirroring
// `list_repos`'s own `includeArchived` flag exactly. `archivedAt` is
// returned unconditionally (not just when `includeArchived` is set): a
// nullable timestamp is not sensitive, and always including it means the
// admin grid can render its "Archived" badge and un-archive action off the
// same `PersonRecord` the picker uses, rather than a second, wider shape.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";

/**
 * The page bound — MILESTONES.md #109.
 *
 * A profile row is small and an installation holds few of them, which is
 * exactly why this read was unbounded: nothing about its size forces the
 * question. But that is a property of the data, not of the code, and the
 * row this milestone was filed over is that an unbounded read is a latent
 * failure whoever adds the hundredth profile discovers. 100 is comfortably
 * above any realistic picker; 500 is the most a caller may ask for.
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const inputSchema = z
  .object({
    includeArchived: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    /** The `id` of the last row of the previous page — pass back `nextCursor`. */
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type ListPeopleInput = z.infer<typeof inputSchema>;

/** One `Person` row. Still nothing sensitive — `notifyRules` stays off this shape, matching `update_person`'s header on why the write's record is wider on purpose. */
export interface PersonRecord {
  readonly id: string;
  readonly displayName: string;
  readonly avatar: string | null;
  readonly colour: string | null;
  readonly archivedAt: string | null;
}

interface RawPersonRow {
  id: string;
  displayName: string;
  avatar: string | null;
  colour: string | null;
  archivedAt: Date | string | null;
}

export interface ListPeopleOutput {
  readonly people: readonly PersonRecord[];
  /** The `id` of the last row in this page, to pass back as `cursor`. Null when this page is the last. */
  readonly nextCursor: string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const listPeople = defineOperation({
  name: "list_people",
  kind: "read",
  summary:
    "Reads profiles — active only by default, every profile with includeArchived. Paged: pass limit and cursor, and read nextCursor for the following page.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ListPeopleInput): Promise<ListPeopleOutput> {
    // Ordered by createdAt then id: stable and deterministic across calls,
    // which matters for a picker whose tiles would otherwise reorder
    // themselves between one load and the next for no reason a person
    // watching the screen could explain.
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (!input.includeArchived) conditions.push(`"archivedAt" IS NULL`);

    if (input.cursor !== undefined) {
      // Keyset pagination on `("createdAt", "id")` — the same pair this read
      // orders by, and ascending here because the ordering is ascending. A
      // cursor compared in the wrong direction does not error; it silently
      // returns the page you already had, which is why the comparison and
      // the ORDER BY are written next to each other.
      const cursorRows = await ctx.db.$queryRawUnsafe<{ createdAt: Date | string }[]>(
        `SELECT "createdAt" FROM "Person" WHERE "id" = $1`,
        input.cursor,
      );
      const cursorRow = cursorRows[0];
      if (cursorRow) {
        values.push(cursorRow.createdAt, input.cursor);
        conditions.push(
          `("createdAt", "id") > ($${values.length - 1}::timestamptz, $${values.length})`,
        );
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // One extra row, so "is there another page" is a fact this query
    // establishes rather than an inference from the page being full.
    values.push(input.limit + 1);
    const rows = await ctx.db.$queryRawUnsafe<RawPersonRow[]>(
      `SELECT "id", "displayName", "avatar", "colour", "archivedAt" FROM "Person"
       ${where}
       ORDER BY "createdAt" ASC, "id" ASC
       LIMIT $${values.length}`,
      ...values,
    );

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const people = page.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      avatar: row.avatar,
      colour: row.colour,
      archivedAt: isoOrNull(row.archivedAt),
    }));
    return {
      people,
      nextCursor: hasMore ? (people[people.length - 1]?.id ?? null) : null,
    };
  },
});
