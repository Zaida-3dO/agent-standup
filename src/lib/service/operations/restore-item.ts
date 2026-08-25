// `restore_item` — the inverse of `delete_item`, which had none.
//
// ── Why this exists ────────────────────────────────────────────────────
//
// `delete_item` is built on a promise it could not keep. Its whole design
// is "archive, never delete": the row stays in the database, `get_item`
// still resolves it by id so a stale link lands somewhere real, and the
// response says what happened rather than pretending the row is gone. All
// of that is only worth anything if the row can come back — and nothing
// cleared `archivedAt`. `update_item`'s input schema is `.strict()` and has
// no such field, so the generic edit path could not do it either.
//
// The gap was not theoretical for long. It surfaced where a person could
// see it: the undo affordance offered after an archive rendered a
// confirmation with **no button**, because `inverseOf` correctly derived
// that the inverse was unavailable and the crew that built it declined to
// show a control that would fail when pressed. That was the right call and
// the wrong situation — a person who archived the wrong row had no path
// back through the product at all.
//
// ── Why an operation of its own, not a field on `update_item` ──────────
//
// The obvious cheaper move is to let `update_item` accept `archivedAt:
// null`. It is rejected here for the reason `delete_item` is its own
// operation rather than a state: un-archiving has **preconditions that no
// generic field edit would run**. A restore has to ask where the row is
// being restored *to* — whether its parent still exists unarchived,
// whether its area and repo are still live — and refuse when the answer
// puts the row back into a tree that cannot hold it. Those are guards, and
// guards belong to an operation that can name them. Folding them into a
// column diff would hide a lifecycle write inside a patch loop, where the
// next person adding an editable field has no reason to look.
//
// ── What it deliberately does not do ───────────────────────────────────
//
// It does not restore descendants. Archiving a parent does not archive its
// children (`delete_item` refuses a parent with live children unless the
// caller acknowledges them, and leaves them where they are), so there is no
// symmetric subtree to put back — each archived row was archived by its own
// call, with its own reason, and is restored by its own call. A cascade
// would resurrect rows nobody named, which is the same class of mistake as
// the one this operation exists to let a person undo.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent } from "@/lib/events";
import { callerEventActor } from "../items/event-attribution";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";

/**
 * Refused because the row was archived in favour of a named replacement and
 * the caller did not say they meant to restore it anyway.
 */
export const RESTORE_SUPERSEDED_GUARD = "items.restore_superseded_needs_acknowledgement";

/**
 * Refused because restoring would put the row back somewhere that cannot
 * hold it — an archived parent, area, or repo.
 */
export const RESTORE_CONTEXT_GUARD = "items.restore_into_archived_context";

const inputSchema = z
  .object({
    id: z.string().trim().min(1, "id is required"),
    /**
     * Required to restore a row carrying `supersededById`.
     *
     * **Restoring a superseded row is a different act from restoring an
     * accident, and the two must not behave the same.** A row archived with
     * no replacement was, by `delete_item`'s own framing, one that should
     * never have existed — a duplicate or a misfire — and bringing it back
     * restores the status quo. A row archived *in favour of another* records
     * a decision: someone judged this work to be the same work as item X and
     * pointed everything at X. Restoring it silently un-makes that judgement
     * and puts two rows for one piece of work back on the board — which is
     * exactly the duplicate `delete_item` was used to resolve.
     *
     * So it is refused by default and permitted on an explicit flag, rather
     * than either blocked outright or allowed silently. Blocking outright
     * would be wrong: superseding is a judgement and judgements are
     * sometimes mistaken, and a person who has looked at both rows and
     * decided they are genuinely different work should not have to reach
     * for SQL. Allowing it silently would be worse: the caller most likely
     * to restore a superseded row is one who never noticed it was
     * superseded, because the undo path offers a button seconds after an
     * archive and says nothing about a replacement.
     *
     * The refusal names the replacement, so a caller deciding whether to
     * pass this has the id they need to go and look.
     */
    acknowledgeSuperseded: z.boolean().default(false),
  })
  .strict();

export type RestoreItemInput = z.infer<typeof inputSchema>;

export interface RestoreItemOutput {
  readonly item: ItemRecord;
  /**
   * Whether this call did the work, as distinct from finding it already
   * done. The same distinction `delete_item`'s `archived` carries, and for
   * the same reason: a retry, a double-click, or a second undo press should
   * report honestly rather than claim a restore that already happened.
   */
  readonly restored: boolean;
  /** What was cleared, kept on the response so a caller can log or show it. */
  readonly clearedReason: string | null;
  readonly effect: string;
}

/**
 * The row's context — the things that have to still be live for a restore to
 * land somewhere coherent.
 *
 * One query rather than three, because all three are the same question
 * ("would this row be visible if I put it back") and answering it in pieces
 * would report only the first problem, sending a caller round the loop once
 * per broken reference.
 *
 * `LEFT JOIN` on parent and repo because both are genuinely optional — a
 * top-level project has no parent and many items have no repo — and an
 * `INNER JOIN` would silently return no rows for them, which this code would
 * then have to distinguish from "the item does not exist".
 */
interface RestoreContext {
  parentId: string | null;
  parentArchivedAt: Date | null;
  areaId: string;
  areaArchivedAt: Date | null;
  repoId: string | null;
  repoArchivedAt: Date | null;
}

async function restoreContext(
  ctx: ServiceContext,
  itemId: string,
): Promise<RestoreContext | undefined> {
  const rows = await ctx.db.$queryRawUnsafe<RestoreContext[]>(
    `SELECT
       i."parentId"           AS "parentId",
       p."archivedAt"         AS "parentArchivedAt",
       i."area"               AS "areaId",
       a."archivedAt"         AS "areaArchivedAt",
       i."repo"               AS "repoId",
       r."archivedAt"         AS "repoArchivedAt"
     FROM "Item" i
     LEFT JOIN "Item" p ON p."id" = i."parentId"
     JOIN "Area" a ON a."id" = i."area"
     LEFT JOIN "Repo" r ON r."id" = i."repo"
     WHERE i."id" = $1`,
    itemId,
  );
  return rows[0];
}

/**
 * Every reason this row cannot be put back, as prose a caller can act on.
 *
 * Collected rather than thrown one at a time so the refusal names all of
 * them at once — see `restoreContext` above.
 */
function blockingContext(context: RestoreContext): string[] {
  const blockers: string[] = [];
  if (context.parentId !== null && context.parentArchivedAt !== null) {
    blockers.push(
      `its parent (${context.parentId}) is itself archived, so restoring this row would hang it under something no ordinary read returns — restore the parent first`,
    );
  }
  if (context.areaArchivedAt !== null) {
    blockers.push(
      `its area (${context.areaId}) has since been archived, so the restored row would not appear in any area-scoped read — move it to a live area first`,
    );
  }
  if (context.repoId !== null && context.repoArchivedAt !== null) {
    blockers.push(
      `its repo (${context.repoId}) has since been archived — clear or change the repo first`,
    );
  }
  return blockers;
}

function restoredOutcome(item: ItemRecord, restored: boolean, clearedReason: string | null) {
  return {
    item,
    restored,
    clearedReason,
    effect: restored
      ? "Restored. It appears in the board, list_items, search, get_projects and every other ordinary read again, in the state it held when it was archived."
      : "Already live — this item was not archived, so nothing changed.",
  };
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const restoreItem = defineOperation({
  name: "restore_item",
  kind: "write",
  summary:
    "Brings an archived item back, clearing archivedAt and archivedReason so it appears in the board, list_items, search and every other ordinary read again. It returns to the state it held when it was archived — a restore is not a transition and moves nothing. Refuses when the row would land somewhere no read reaches (an archived parent, area or repo), and refuses a row that was superseded by another unless acknowledgeSuperseded is passed.",
  contract: {
    rules: [
      {
        fields: ["id"],
        rule: "Restoring an item that is not archived is not an error — it reports restored false and changes nothing, so a retry or a second undo press is safe.",
      },
      {
        fields: ["acknowledgeSuperseded"],
        rule: "An item archived in favour of another (supersededById) is refused until acknowledgeSuperseded is true. Restoring it puts a second row for the same work back on the board, which is what superseding resolved; the refusal names the replacement so it can be looked at first.",
      },
      {
        fields: ["id"],
        rule: "An item whose parent, area or repo has since been archived is refused, because the restored row would not be reachable by any ordinary read. The refusal names every blocker at once, not just the first.",
      },
    ],
    example: {
      id: "01J000000000000000000000",
    },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: RestoreItemInput): Promise<RestoreItemOutput> {
    const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      input.id,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such item: ${input.id}.`, { fields: ["id"] });
    }

    // Not archived: report it and stop, rather than refusing. The caller
    // wanted this row live and it is live. Refusing would make the undo
    // path's retry — and an impatient second press — into an error a person
    // has to interpret, for an outcome that is already what they asked for.
    if (row.archivedAt === null) {
      return restoredOutcome(toItemRecord(row), false, null);
    }

    // Ordered before the context guard deliberately. Being superseded is a
    // fact about the caller's *intent* — they may not know this row was
    // replaced — while an archived parent is a fact about the world they can
    // go and fix. Surfacing the intent question first means a caller who
    // should not be restoring this row at all learns that before being sent
    // off to un-archive a parent in service of a restore they will then
    // decide against.
    if (row.supersededById !== null && !input.acknowledgeSuperseded) {
      throw new GuardRejectedError(
        RESTORE_SUPERSEDED_GUARD,
        `This item was not archived by accident — it was archived in favour of ${row.supersededById}, which is where its work was taken up. Restoring it puts a second row for the same work back on the board. If they are genuinely different work, pass acknowledgeSuperseded to restore it anyway.`,
        { fields: ["acknowledgeSuperseded"], details: { supersededById: row.supersededById } },
      );
    }

    const context = await restoreContext(ctx, input.id);
    if (!context) {
      throw new NotFoundError(`No such item: ${input.id}.`, { fields: ["id"] });
    }
    const blockers = blockingContext(context);
    if (blockers.length > 0) {
      throw new GuardRejectedError(
        RESTORE_CONTEXT_GUARD,
        `This item cannot be restored where it stands: ${blockers.join("; ")}.`,
        { fields: ["id"], details: { blockers } },
      );
    }

    // `supersededById` is deliberately NOT cleared.
    //
    // It records a judgement that was made — that this row's work was taken
    // up by another — and that judgement happened whatever is decided now.
    // Clearing it would erase the only durable trace of why the row was
    // archived in the first place, and a caller who passed
    // `acknowledgeSuperseded` has said the rows are different work, not that
    // the earlier decision was never taken. `archivedReason` is cleared
    // because it is scoped to the archive that is being undone; the
    // supersedes pointer outlives it, and the event below records the
    // restore beside it.
    const updatedRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `UPDATE "Item"
       SET "archivedAt" = NULL, "archivedReason" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "archivedAt" IS NOT NULL
       RETURNING ${ITEM_COLUMNS}`,
      input.id,
    );
    const updated = updatedRows[0];
    if (!updated) {
      // The row was archived when it was read and is not now — another
      // caller restored it in between. That is the outcome this call wanted,
      // so it reports the same "already live" result a no-op restore does
      // rather than inventing a conflict out of two callers agreeing.
      const currentRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
        `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
        input.id,
      );
      const current = currentRows[0];
      if (!current) {
        throw new NotFoundError(`No such item: ${input.id}.`, { fields: ["id"] });
      }
      return restoredOutcome(toItemRecord(current), false, null);
    }

    await appendEvent(ctx.db, {
      itemId: input.id,
      actor: callerEventActor(ctx.caller),
      type: "field_change",
      body: row.archivedReason ?? "restored",
      payload: {
        field: "archivedAt",
        from: "archived",
        to: null,
        clearedReason: row.archivedReason,
        supersededById: row.supersededById,
        acknowledgedSuperseded: input.acknowledgeSuperseded,
      },
    });

    return restoredOutcome(toItemRecord(updated), true, row.archivedReason);
  },
});
