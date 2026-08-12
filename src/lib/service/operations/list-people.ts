// `list_people` — SCHEMA.md §19 `GET /people`: "Profiles. Archive rather
// than delete; attribution rows point here." §8a: "Netflix-style profile
// picker on first load … anyone who can reach the app can pick any
// profile." MILESTONES.md #35.
//
// The one read the front-end profile picker needs: every profile it may
// offer. Archived profiles are excluded — §8a archives rather than deletes
// specifically so attribution rows keep working, not so an archived profile
// keeps showing up as something new work can be claimed under.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";

const inputSchema = z.object({}).strict();

export type ListPeopleInput = z.infer<typeof inputSchema>;

/** One `Person` row, as the picker needs it — nothing sensitive, nothing it doesn't render. */
export interface PersonRecord {
  readonly id: string;
  readonly displayName: string;
  readonly avatar: string | null;
  readonly colour: string | null;
}

interface RawPersonRow {
  id: string;
  displayName: string;
  avatar: string | null;
  colour: string | null;
}

export interface ListPeopleOutput {
  readonly people: readonly PersonRecord[];
}

export const listPeople = defineOperation({
  name: "list_people",
  kind: "read",
  summary: "Reads every non-archived profile, for the profile picker.",
  input: inputSchema,
  async handler(ctx: ServiceContext): Promise<ListPeopleOutput> {
    // Ordered by createdAt then id: stable and deterministic across calls,
    // which matters for a picker whose tiles would otherwise reorder
    // themselves between one load and the next for no reason a person
    // watching the screen could explain.
    const rows = await ctx.db.$queryRawUnsafe<RawPersonRow[]>(
      `SELECT "id", "displayName", "avatar", "colour" FROM "Person"
       WHERE "archivedAt" IS NULL
       ORDER BY "createdAt" ASC, "id" ASC`,
    );
    return {
      people: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        avatar: row.avatar,
        colour: row.colour,
      })),
    };
  },
});
