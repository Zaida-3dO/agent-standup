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
import { releaseNameIfSessionIdle } from "@/lib/agent-names";
import type { Assignment } from "@/lib/claims";
import { resolveItemId } from "../items/resolve-id";
import { assignmentRequiredRule, refuseForMissingAssignment } from "../items/assignment-refusal";

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
  contract: {
    rules: [
      assignmentRequiredRule("a release"),
      {
        fields: ["itemId", "sessionId"],
        rule: 'A session can only give up its OWN live row, which is why this takes an item plus your session rather than an assignment id. To end somebody else\'s hold you want `ownership` with `action: "takeover"`, which carries its own guards — and it frees the holder without assigning the item to you, so it is not a way to do both in one call.',
      },
    ],
    example: {
      itemId: "b1f0c3d2-0000-4000-8000-000000000000",
      sessionId: "725c8167",
    },
  },
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
      // Still one conflict — the caller asked to give up something it does
      // not hold — but which of three situations produced it decides what
      // they should do next, so the refusal names the case.
      //
      // "No such item" is deliberately still not distinguished here: a
      // caller can already tell that apart itself, because it knows whether
      // it ever claimed. The split below is a different question, and it is
      // one the caller cannot answer alone — whether somebody else holds
      // this item *now* is a fact only the database has.
      //
      // That distinction matters most for `release` of all three callers.
      // A session told merely "you do not hold this" may reasonably re-claim
      // in order to release cleanly, and in the taken-over case that takes
      // the item from a session that is working on it — the exact harmful
      // recovery the refusal exists to warn against.
      const refusal = await refuseForMissingAssignment(ctx.db, {
        itemId: input.itemId,
        sessionId: input.sessionId,
        action: "a release",
        // A release does append an event, so the default "nothing to
        // attribute to" is not false here — but it names the wrong
        // obstacle. The caller's problem is that the ownership it asked to
        // give up is already gone, which is also the fact that makes the
        // `never_held` advice below correct.
        consequence: "has no live claim of yours to give up",
        // A releaser is carrying nothing to write down, so the default
        // "use note to record what you have" would invent content it does
        // not have. What it needs is the fact that the outcome it wanted
        // already holds.
        takenOverAdvice:
          "You are not the holder, so there is nothing here for you to give up — leave it alone " +
          "and check with whoever dispatched you.",
        neverHeldAlternative:
          ", but if you are simply making sure you hold nothing, that is already true and this " +
          "call is unnecessary — do not claim the item in order to release it",
      });
      throw new ConflictError(refusal.message, {
        fields: ["itemId", "sessionId"],
        details: { refusalCase: refusal.case },
      });
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

    // Give the crew name back once this session is holding nothing else.
    // A name is drawn as a side effect of registering and claiming, so
    // without a return path the roster is a consumable — see
    // `releaseNameIfSessionIdle`, which also explains why this waits for the
    // session's *last* claim rather than firing on any release.
    //
    // Deliberately after the event: the release is the thing that happened
    // and must be recorded whatever the pool does. This adds no failure mode
    // of its own — it returns `undefined` rather than throwing when there is
    // nothing to free.
    await releaseNameIfSessionIdle(ctx.db, input.sessionId);

    return assignment;
  },
});
