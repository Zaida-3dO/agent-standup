// `my_work` — SCHEMA.md §18 (`my_work`: "What you hold right this moment,
// and in what role"), MILESTONES.md #28's second half.
//
// This is a session-scoped read over `assignments` (row #23) joined to
// `events` for a lightweight per-item "last happened" marker, **not** a
// filter on `list_items`. That distinction is the row's own point, and it
// is structural, not just a difference in query shape:
//
//   - `list_items` (row #26) answers "which items match these criteria" —
//     it has no concept of a session or a role at all; its rows are
//     `ItemRecord`s with none of `assignments`' columns.
//   - `my_work` answers "what does THIS session hold, and as what" — a
//     question `list_items` cannot express because the *role* a caller
//     holds on an item is not a property of the item. Two different
//     sessions can hold the same item in two different roles at once
//     (SCHEMA.md §2: "orchestrator *plus* a builder *plus* two reviewers");
//     an item-list filter, however parameterised, returns the same row for
//     both callers, because the row *is* the item and the item has no
//     "role" column to filter on. `my_work` returns one row **per live
//     assignment for this session**, each carrying that assignment's own
//     `role`/`roleCustom` — information that exists only on `assignments`,
//     never on `items`, and so is categorically outside what any item
//     filter could produce no matter how it were parameterised.
//
// See `tests/my-work-operation.test.ts` for the two-sessions-different-roles
// case that proves this in practice.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";
import type { HolderType, Liveness, Role } from "../../claims";

const inputSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export type MyWorkInput = z.infer<typeof inputSchema>;

export interface MyWorkEntry {
  readonly item: ItemRecord;
  /** This session's own live assignment on `item` — the role information no item-list filter carries. */
  readonly assignment: {
    readonly id: string;
    readonly role: Role;
    readonly roleCustom: string | null;
    readonly holderType: HolderType;
    readonly holderId: string;
    readonly liveness: Liveness;
    readonly claimedAt: string;
    readonly lastActive: string;
  };
}

export interface MyWorkOutput {
  readonly sessionId: string;
  readonly items: readonly MyWorkEntry[];
}

interface RawSessionAssignmentRow extends RawItemRow {
  assignmentId: string;
  assignmentRole: Role;
  assignmentRoleCustom: string | null;
  assignmentHolderType: HolderType;
  assignmentHolderId: string;
  assignmentLiveness: Liveness;
  assignmentClaimedAt: Date | string;
  assignmentLastActive: Date | string;
}

function isoOrString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export const myWork = defineOperation({
  name: "my_work",
  kind: "read",
  summary: "What this session holds right now, and in what role, per SCHEMA.md §18.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: MyWorkInput): Promise<MyWorkOutput> {
    // One statement: every item this session holds a *live* assignment on
    // (`releasedAt IS NULL` — the same predicate `liveAssignments` in
    // claims.ts reads, so "what my_work reports" and "what the claim/release
    // machinery enforces" cannot disagree about which rows count), joined
    // to that assignment's own role columns. A raw join rather than two
    // round-trips (assignments, then items by id) because the row this
    // returns genuinely is one item paired with one assignment — the same
    // reasoning `toItemRecord` already applies to keep one mapping instead
    // of one per caller.
    // `i.*` rather than the shared `ITEM_COLUMNS` list: that constant is a
    // flat, pre-joined string built for an unqualified `SELECT ... FROM
    // "Item"` (get-item.ts, list-items.ts), and re-deriving a per-column
    // `i."column"` alias list from it would need to parse its own quoting
    // rather than just ask Postgres for every column on the aliased table —
    // which is exactly what `i.*` does, with no name collision here because
    // every assignment column below is aliased under an `assignment`-
    // prefixed name.
    const rows = await ctx.db.$queryRawUnsafe<RawSessionAssignmentRow[]>(
      `SELECT
         i.*,
         a."id" AS "assignmentId",
         a."role" AS "assignmentRole",
         a."roleCustom" AS "assignmentRoleCustom",
         a."holderType" AS "assignmentHolderType",
         a."holderId" AS "assignmentHolderId",
         a."liveness" AS "assignmentLiveness",
         a."claimedAt" AS "assignmentClaimedAt",
         a."lastActive" AS "assignmentLastActive"
       FROM "Assignment" a
       JOIN "Item" i ON i."id" = a."itemId"
       WHERE a."sessionId" = $1 AND a."releasedAt" IS NULL
       ORDER BY a."claimedAt" ASC`,
      input.sessionId,
    );

    const items: MyWorkEntry[] = rows.map((row) => ({
      item: toItemRecord(row),
      assignment: {
        id: row.assignmentId,
        role: row.assignmentRole,
        roleCustom: row.assignmentRoleCustom,
        holderType: row.assignmentHolderType,
        holderId: row.assignmentHolderId,
        liveness: row.assignmentLiveness,
        claimedAt: isoOrString(row.assignmentClaimedAt),
        lastActive: isoOrString(row.assignmentLastActive),
      },
    }));

    return { sessionId: input.sessionId, items };
  },
});
