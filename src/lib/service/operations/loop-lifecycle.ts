// `loop_edit` and `loop_delete` — the rest of a loop's lifecycle.
//
// ── Why these are appends, not updates ──────────────────────────────────
//
// A loop is a pair of events correlated by `payload.loopId` (SCHEMA.md §3a).
// There is no loop row, so there is nothing for an UPDATE or a DELETE to
// target, and the ledger is append-only regardless. Both operations
// therefore write a further event that `deriveLoops` understands: an edit
// supplies replacement text, a deletion retracts the loop. Every original
// row stays exactly where it was, so `get_events`, the item's history and
// every `assignmentId` attribution keep resolving.
//
// This is the same posture `delete_item` takes one level up — "it is called
// delete and it never deletes". The name matches what the caller is *doing*;
// the mechanism is stated plainly to anyone who looks and hidden from
// nobody.
//
// ── Why a deletion is not a close ───────────────────────────────────────
//
// A close says a real loose end was resolved. It belongs in the record, and
// `loop_list { includeClosed: true }` shows it. A deletion says the loop
// should never have existed — a duplicate, or one recorded by accident — and
// filing that as a close would make the record narrate a resolution nobody
// reached. Exactly the gap `delete_item` fills between `cancelled` (a
// decision someone made) and archived (a row that should not exist).
//
// A deleted loop is withheld from every ordinary read, including the one
// that returns closed loops, because a caller asking to see resolved loose
// ends is not thereby asking to see retracted ones.
//
// ── What deletion deliberately does NOT do ──────────────────────────────
//
// **It does not free the `loopId` for reuse.** That rule is load-bearing and
// not an inconvenience to route around: `deriveLoops` collects every close
// into a map over the whole stream and resolves each open against it, with
// no pairing and no ordering, which is what makes the fold correct when a
// close is read before its own open (`Event.id` is allocated before commit,
// so sequence order is not commit order — SCHEMA.md §3). Re-opening a
// retired id would produce a loop the fold reports with the *old* loop's
// terminal state. `loop_add`'s own note works through the same argument for
// closed ids. Ids are free; correctness under out-of-order reads is not.
import { z } from "zod";
import { GuardRejectedError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent, type AppendedEvent } from "@/lib/events";
import { deriveLoops, LOOP_KINDS, type DerivedLoop, type LoopKind } from "@/lib/open-loops";
import { loopEventsFor, requireItemExists } from "./loop-shared";

const ACTOR_TYPES = ["person", "agent", "system"] as const;

interface LiveAssignmentRow {
  id: string;
  holderType: "person" | "agent";
  holderId: string;
}

/**
 * Resolves the actor and assignment to credit from the caller's live claim.
 *
 * A second copy of `open-loops.ts`'s helper rather than an import, matching
 * how `commands-ownership.ts` and `commands-loops.ts` treat the same
 * situation in the CLI: these are separate concurrently-edited modules, and
 * the shape is six lines. Optional rather than required, for the reason the
 * write path already records — a loose end can be spotted by someone who
 * never claimed the item.
 */
async function resolveActor(
  ctx: ServiceContext,
  args: {
    itemId: string;
    sessionId?: string | null;
    actorType?: (typeof ACTOR_TYPES)[number];
    actorId?: string | null;
  },
) {
  let assignmentId: string | null = null;
  let actorType: (typeof ACTOR_TYPES)[number] = args.actorType ?? "system";
  let actorId: string | null = args.actorId ?? null;

  if (args.sessionId) {
    const rows = await ctx.db.$queryRawUnsafe<LiveAssignmentRow[]>(
      `SELECT "id", "holderType", "holderId" FROM "Assignment"
        WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
        LIMIT 1`,
      args.itemId,
      args.sessionId,
    );
    const live = rows[0];
    if (live) {
      assignmentId = live.id;
      if (args.actorType === undefined) actorType = live.holderType;
      if (args.actorId == null) actorId = live.holderId;
    }
  }

  return { actorType, actorId, assignmentId };
}

/** Finds the loop, or refuses in the way that says which of the two things went wrong. */
async function requireLoop(
  ctx: ServiceContext,
  itemId: string,
  loopId: string,
): Promise<DerivedLoop> {
  const loop = deriveLoops(await loopEventsFor(ctx, itemId)).find(
    (candidate) => candidate.loopId === loopId,
  );
  if (loop === undefined) {
    throw new NotFoundError(`No loop ${loopId} on item ${itemId} — it was never opened.`, {
      fields: ["loopId"],
    });
  }
  return loop;
}

const editInput = z
  .object({
    itemId: z.string().min(1),
    loopId: z.string().trim().min(1),
    text: z.string().trim().min(1, "loop text is required"),
    /**
     * Reclassify the loop, for one filed under the wrong kind.
     *
     * **Optional, and omitting it PRESERVES the current kind** — it does not
     * reset to `work`. JSON cannot distinguish "not supplied" from
     * "cleared", so the fold treats an absent kind as "no statement made"
     * and only a kind actually sent changes anything (see `deriveLoops`).
     * Reclassifying to `work` is therefore an explicit `kind: "work"`.
     *
     * This is how a note-shaped loop is corrected without deleting it: the
     * loose end stays in the record, it just stops counting as work.
     */
    kind: z.enum(LOOP_KINDS).optional(),
    actorType: z.enum(ACTOR_TYPES).optional(),
    actorId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type LoopEditInput = z.infer<typeof editInput>;

export interface LoopEdited {
  readonly loopId: string;
  /** The text the loop had before this edit — returned so the change is legible in the response. */
  readonly previousText: string;
  /** The kind the loop had before this edit. Unchanged when the edit did not supply one. */
  readonly previousKind: LoopKind;
  /** The kind the loop carries after this edit. */
  readonly kind: LoopKind;
  readonly event: AppendedEvent;
}

/** The guard id a refusal to edit a retracted loop carries. */
export const LOOP_EDIT_DELETED_GUARD = "loops.edit_deleted_loop";

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const loopEdit = defineOperation({
  name: "loop_edit",
  kind: "write",
  summary:
    "Rewrites an open loop's text, for a loose end whose wording has been refined, and optionally reclassifies it with kind. Keeps the loop's original openedAt; the previous wording stays in the ledger. Omitting kind leaves the loop's current kind alone.",
  contract: {
    rules: [
      {
        fields: ["loopId"],
        rule: "The loop must exist on the item and must not have been deleted. A closed loop may be edited — correcting the record of something resolved is legitimate.",
      },
      {
        fields: ["kind"],
        rule: 'Omitting `kind` PRESERVES the loop\'s current kind rather than resetting it to `work` — only a kind actually sent changes the classification. Reclassify to work by sending `kind: "work"` explicitly.',
      },
    ],
  },
  // Stryker restore all
  input: editInput,
  async handler(ctx: ServiceContext, input: LoopEditInput): Promise<LoopEdited> {
    await requireItemExists(ctx, input.itemId, "itemId");
    const loop = await requireLoop(ctx, input.itemId, input.loopId);

    // A deleted loop is not editable. It has been retracted, so no ordinary
    // read serves it, and an edit would write a row that changes text nobody
    // can see — a silent no-op, which is the outcome a write should never
    // have. A *closed* loop is editable on purpose: fixing the wording of a
    // resolved loose end is a correction to the record, not a reopening, and
    // the status is unaffected either way.
    if (loop.status === "deleted") {
      throw new GuardRejectedError(
        LOOP_EDIT_DELETED_GUARD,
        `Loop ${input.loopId} was deleted and cannot be edited — a deleted loop is served by no ordinary read, so the new text would be invisible. Open a new loop with loop_add if the loose end is real.`,
        { fields: ["loopId"] },
      );
    }

    const actor = await resolveActor(ctx, input);

    const event = await appendEvent(ctx.db, {
      itemId: input.itemId,
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        sessionId: input.sessionId ?? null,
      },
      assignmentId: actor.assignmentId,
      type: "open_loop_edited",
      // `{loopId, text}` — the same shape as the opening event, so the fold
      // substitutes one for the other without a second parser. `kind` is
      // included only when the caller supplied one: an absent key is what
      // the fold reads as "this edit made no statement about the kind", and
      // writing the resolved kind unconditionally would turn every reword
      // into a kind assertion.
      payload: {
        loopId: input.loopId,
        text: input.text,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
      },
    });

    return {
      loopId: input.loopId,
      previousText: loop.text,
      previousKind: loop.kind,
      kind: input.kind ?? loop.kind,
      event,
    };
  },
});

/**
 * The shortest deletion reason accepted.
 *
 * The same 20 characters `delete_item` requires, and for its reason: the
 * point is not the count, it is that a caller has to name *which* duplicate
 * or *which* accident. That sentence is what makes a mistaken deletion
 * reviewable later, and it is the sentence during which a caller often
 * notices they actually meant `loop_close`.
 */
export const LOOP_DELETE_REASON_MIN_CHARS = 20;

/** The guard id a reason-shaped refusal carries, so a caller can match on it rather than on prose. */
export const LOOP_DELETE_REASON_GUARD = "loops.delete_reason_is_not_a_closure";

/** The guard id a repeat-deletion refusal carries. */
export const LOOP_DELETE_ALREADY_GUARD = "loops.delete_already_deleted";

/**
 * Reason wordings that describe a closure rather than a retraction.
 *
 * The distinction is the same one `delete_item` enforces between `cancelled`
 * and archived: a deletion is for a loop that should never have existed,
 * and every phrase here describes a loop that legitimately existed and was
 * then dealt with. Overwhelmingly a caller reaching for delete wants
 * `loop_close` and has reached past it, so the steering is built into the
 * refusal rather than into documentation the wrong callers will not read.
 *
 * Deliberately a short list of decisive phrases. A false positive refuses a
 * caller who is right, and the only way past is to reword an accurate
 * reason — which teaches callers to write worse reasons to satisfy a
 * matcher.
 */
const CLOSURE_REASON_PHRASES: readonly string[] = Object.freeze([
  "resolved",
  "fixed",
  "done",
  "not relevant",
  "sorted",
  "handled",
  "completed",
  "finished",
  "addressed",
]);

/** Whether a deletion reason is really describing a closure. Exported for its own test. */
export function readsAsClosure(reason: string): string | null {
  const normalised = reason.toLowerCase();
  return CLOSURE_REASON_PHRASES.find((phrase) => normalised.includes(phrase)) ?? null;
}

const deleteInput = z
  .object({
    itemId: z.string().min(1),
    loopId: z.string().trim().min(1),
    /** Why this loop should never have existed. See `LOOP_DELETE_REASON_MIN_CHARS`. */
    reason: z.string().trim().min(1, "reason is required"),
    actorType: z.enum(ACTOR_TYPES).optional(),
    actorId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type LoopDeleteInput = z.infer<typeof deleteInput>;

export interface LoopDeleted {
  readonly loopId: string;
  /** The text the deleted loop carried — returned so the response records what was retracted. */
  readonly text: string;
  /** What the loop's status was before it was deleted. */
  readonly previousStatus: DerivedLoop["status"];
  readonly event: AppendedEvent;
}

// Stryker disable all : see the note on `loopEdit` above.
export const loopDelete = defineOperation({
  name: "loop_delete",
  kind: "write",
  summary:
    "Retracts a loop that should never have existed — a duplicate, or one recorded by accident. Requires a reason. Use loop_close instead for a real loose end that has been resolved; that is almost always the right call. The events stay in the ledger; the loop stops being served.",
  contract: {
    rules: [
      {
        fields: ["reason"],
        rule: `A reason is required, must be at least ${LOOP_DELETE_REASON_MIN_CHARS} characters, and must not describe a resolution — a loose end that was real and has been dealt with is closed with loop_close, not deleted here.`,
      },
      {
        fields: ["loopId"],
        rule: "The loop must exist on the item and must not already have been deleted.",
      },
    ],
  },
  // Stryker restore all
  input: deleteInput,
  async handler(ctx: ServiceContext, input: LoopDeleteInput): Promise<LoopDeleted> {
    await requireItemExists(ctx, input.itemId, "itemId");
    const loop = await requireLoop(ctx, input.itemId, input.loopId);

    // Refused rather than treated as idempotent. A second deletion would
    // append a row that changes nothing, and returning success for it would
    // tell a caller who has confused two loop ids that they retracted the
    // one they named — when they retracted nothing.
    if (loop.status === "deleted") {
      throw new GuardRejectedError(
        LOOP_DELETE_ALREADY_GUARD,
        `Loop ${input.loopId} was already deleted${loop.deletedAt === null ? "" : ` at ${loop.deletedAt}`}.`,
        { fields: ["loopId"] },
      );
    }

    if (input.reason.length < LOOP_DELETE_REASON_MIN_CHARS) {
      throw new GuardRejectedError(
        LOOP_DELETE_REASON_GUARD,
        `A reason of at least ${LOOP_DELETE_REASON_MIN_CHARS} characters is required — name which duplicate or which accident, so this stays reviewable. If the loose end was real and has been dealt with, use loop_close instead.`,
        { fields: ["reason"] },
      );
    }

    const closureWord = readsAsClosure(input.reason);
    if (closureWord !== null) {
      throw new GuardRejectedError(
        LOOP_DELETE_REASON_GUARD,
        `That reason ("${closureWord}") describes a loose end that was resolved, which is loop_close, not loop_delete. Deleting is for a loop that should never have existed — a duplicate, or one recorded by accident. If this loop was real and is now dealt with, call loop_close.`,
        { fields: ["reason"] },
      );
    }

    const actor = await resolveActor(ctx, input);

    const event = await appendEvent(ctx.db, {
      itemId: input.itemId,
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        sessionId: input.sessionId ?? null,
      },
      assignmentId: actor.assignmentId,
      type: "open_loop_deleted",
      payload: { loopId: input.loopId, reason: input.reason },
    });

    return { loopId: input.loopId, text: loop.text, previousStatus: loop.status, event };
  },
});
