// `release` — SCHEMA.md §2, §18, §19. Gives up ownership of an item.
//
// The mirror of `claim`: sets `releasedAt` on the caller's own live
// assignment row and appends a `release` event, in the transaction the
// runtime already opened. Deliberately narrow in what it accepts —
// `itemId` + `sessionId`, not an assignment id — because a session can only
// ever release *its own* live row (SCHEMA.md §2's uniqueness section: "one
// session can't hold two rows on one item"), so there is nothing a caller
// could usefully disambiguate by supplying the row id instead.
import { z } from "zod";
import { ConflictError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent } from "@/lib/events";
import type { Assignment } from "@/lib/claims";
import { resolveItemId } from "../items/resolve-id";

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type ReleaseOperationInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const release = defineOperation({
  name: "release",
  kind: "write",
  summary: "Gives up ownership of an item.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ReleaseOperationInput): Promise<Assignment> {
    // A full UUID passes straight through untouched; a short id becomes
    // the one item it identifies, or refuses when it names more than
    // one. Rebinding `input` rather than threading a separate variable
    // is what makes this safe: every read of the id below this line —
    // including the ones inside the guards and the event rows — sees the
    // canonical id, so a short id cannot survive into a stored value.
    input = {
      ...input,
      itemId: await resolveItemId(ctx.db, input.itemId, "itemId"),
    };

    // The live row this session holds on this item — at most one, by the
    // partial unique index `Assignment_one_live_row_per_session_per_item`
    // (SCHEMA.md §2), so `LIMIT 1` never has to pick between rows.
    const rows = await ctx.db.$queryRawUnsafe<Assignment[]>(
      `SELECT * FROM "Assignment"
       WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
       LIMIT 1`,
      input.itemId,
      input.sessionId,
    );
    const live = rows[0];
    if (!live) {
      // Distinguishing "no such item" from "not held by this session" would
      // need a second query for a case a caller can already tell apart
      // itself — it knows whether it ever claimed. Both report as a
      // conflict: the caller asked to give up something it does not hold.
      throw new ConflictError(
        `Session ${input.sessionId} does not hold a live assignment on ${input.itemId}.`,
        { fields: ["itemId", "sessionId"] },
      );
    }

    const released = await ctx.db.$queryRawUnsafe<Assignment[]>(
      `UPDATE "Assignment" SET "releasedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1
       RETURNING *`,
      live.id,
    );
    const assignment = released[0];
    if (!assignment) {
      // Unreachable in practice — the row was just read inside this same
      // transaction and nothing else can have removed it. Guarded rather
      // than asserted, per the same reasoning `claimItem`'s sibling
      // functions use for an `UPDATE ... RETURNING` that "always" returns.
      throw new NotFoundError(`Assignment ${live.id} disappeared mid-release.`, { fields: [] });
    }

    await appendEvent(ctx.db, {
      itemId: assignment.itemId,
      actor: {
        actorType: assignment.holderType,
        actorId: assignment.holderId,
        sessionId: assignment.sessionId,
      },
      assignmentId: assignment.id,
      type: "release",
      payload: {
        assignmentId: assignment.id,
        role: assignment.role,
        holderId: assignment.holderId,
      },
    });

    return assignment;
  },
});
