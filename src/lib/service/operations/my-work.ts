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
import {
  NOT_ARCHIVED_CONDITION,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "../items/row";
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
  /**
   * Whether a hook has ever reported a protocol version for this session.
   *
   * A session with no hook can claim and do work — the version being
   * unreported is information, not a reason to refuse ownership. What that
   * leaves is a reader unable to tell **"no rule could have fired here,
   * because nothing was watching"** from **"a rule fired and found nothing
   * wrong"**, and the two look identical in a session's history. It matters
   * most at review: trusting that policy was enforced on a session that ran
   * no hook at all is trusting something that was never true.
   *
   * `false` is therefore the honest answer for a session that has never
   * registered at all, not just one that registered without a version.
   * Neither has a hook this installation has heard from, and a reader asking
   * "was anything watching" is owed the same answer for both.
   *
   * It says nothing about whether a rule *did* fire — only whether one
   * could have. That is deliberately the narrower claim: what fired is in
   * the ledger, and a summary field that implied otherwise would be a new
   * way of being wrong about the same question.
   */
  readonly hooked: boolean;
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

// Exported (rather than kept file-private, like `isoOrNull` in items/row.ts)
// specifically so `claimedAt`/`lastActive`'s mapping can be unit-tested
// directly: `$queryRawUnsafe` always deserializes `Assignment.claimedAt`/
// `lastActive` (Postgres `timestamptz`) as a JS `Date`, so the DB-backed
// tests in my-work-operation.test.ts can only ever exercise the `Date`
// branch — the string-passthrough branch needs a direct call to be reached
// honestly at all. See tests/my-work-operation.test.ts's "isoOrString"
// describe block.
export function isoOrString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const myWork = defineOperation({
  name: "my_work",
  kind: "read",
  summary: "What this session holds right now, and in what role, per SCHEMA.md §18.",
  // Stryker restore all
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
       -- An archived item is not work in hand, even while an assignment on
       -- it is still open (MILESTONES.md #137). Archiving does not release
       -- claims — a claim is a fact about who took the row, and rewriting it
       -- would falsify that history — so without this condition a session
       -- would be shown holding a row that every other read denies it, with
       -- nothing in the response to explain the contradiction.
       JOIN "Item" i ON i."id" = a."itemId"
       WHERE a."sessionId" = $1 AND a."releasedAt" IS NULL AND i.${NOT_ARCHIVED_CONDITION}
       ORDER BY a."claimedAt" ASC`,
      input.sessionId,
    );

    // A second statement rather than a join onto the first: this answers a
    // question about the *session*, and there is exactly one answer to it
    // however many assignments come back — including **none**, which is
    // precisely the case a join would lose. A session holding nothing still
    // has a hook, or still does not, and that is worth knowing about the
    // session a reviewer is looking at, held work or not.
    const sessionRows = await ctx.db.$queryRawUnsafe<{ hookVersion: number | null }[]>(
      `SELECT "hookVersion" FROM "Session" WHERE "id" = $1`,
      input.sessionId,
    );

    // No row and a null version collapse to the same answer on purpose —
    // see `hooked`'s own comment. `?? null` rather than optional chaining
    // alone so an absent row and a present-but-null column take the same
    // path instead of one being `undefined` and the other `null`.
    const hooked = (sessionRows[0]?.hookVersion ?? null) !== null;

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

    return { sessionId: input.sessionId, items, hooked };
  },
});
