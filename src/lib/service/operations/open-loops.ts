// `loop_add` and `loop_close` — SCHEMA.md §3a. The write half of open loops.
//
// A loop is a pair of events, not a row in a table: it opens (`open_loop`,
// payload `{loopId, text}`) and it closes (`open_loop_closed`, payload
// `{loopId}`). The payload validators, the pairing fold and `orientation`'s
// read path all exist in `src/lib/open-loops.ts`; these two operations are
// the only thing missing, which is why `orientation` could display a loop
// that nothing was able to record.
//
// **Neither operation decides whether a loop is open.** That is
// `deriveOpenLoops`'s job and it derives it from the pair, per §3a's "store
// facts, derive volatiles". `loop_close` therefore does not look up the
// opening event to mark it closed — there is nothing to mark. It appends the
// closing fact and the fold does the rest, which is what keeps the two events
// independent and the ledger append-only.
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent, type AppendedEvent } from "@/lib/events";
import { deriveOpenLoops, type LoopEventLike } from "@/lib/open-loops";

const ACTOR_TYPES = ["person", "agent", "system"] as const;

interface LiveAssignmentRow {
  id: string;
  holderType: "person" | "agent";
  holderId: string;
}

/**
 * Resolves the actor and assignment to credit, from the caller's live claim
 * where it holds one.
 *
 * Optional rather than required, the same shape `note` uses and deliberately
 * not `checkpoint`'s: SCHEMA.md §3a's loops are "the loose ends a session is
 * carrying", and a person reading the board can perfectly well spot one
 * without ever having claimed the item. Requiring an assignment would mean
 * the only people who can record a loose end are the ones already holding
 * the work.
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

async function requireItem(ctx: ServiceContext, itemId: string): Promise<void> {
  const rows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "Item" WHERE "id" = $1`,
    itemId,
  );
  if (rows.length === 0) {
    throw new NotFoundError(`No such item: ${itemId}.`, { fields: ["itemId"] });
  }
}

/**
 * Whether `loopId` appears in any loop event for the item — open or closed.
 *
 * Deliberately reads the raw payloads rather than asking `deriveOpenLoops`.
 * The fold answers "which loops are open", and a closed loop is invisible to
 * it by design — which is exactly the question this must not ask, because a
 * closed id is precisely the one that must not be reused.
 *
 * Malformed payloads are skipped, matching the fold's tolerance: a row the
 * fold cannot read is a row that can never make a loop visible, so it is not
 * a collision with anything.
 */
function usesLoopId(events: readonly LoopEventLike[], loopId: string): boolean {
  return events.some((event) => {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    return (payload as Record<string, unknown>).loopId === loopId;
  });
}

/** Every loop event for an item, oldest first — the same slice `orientation` folds. */
async function loopEvents(ctx: ServiceContext, itemId: string): Promise<LoopEventLike[]> {
  return ctx.db.$queryRawUnsafe<LoopEventLike[]>(
    `SELECT "id", "ts", "type", "payload" FROM "Event"
      WHERE "itemId" = $1 AND "type" IN ('open_loop'::"EventType", 'open_loop_closed'::"EventType")
      ORDER BY "id" ASC`,
    itemId,
  );
}

const addInput = z
  .object({
    itemId: z.string().min(1),
    text: z.string().trim().min(1, "loop text is required"),
    /**
     * The correlation key the closing event will name. Generated when the
     * caller does not supply one, which is the ordinary case.
     *
     * Accepted from the caller at all because the id has to be *knowable* to
     * whoever will close the loop: a caller recording a loop it already
     * tracks under its own identifier can use that identifier and close it
     * later without having to store the mapping. It is deliberately not
     * derived from the text (`open-loops.ts`'s own note) — that would make
     * closing depend on quoting the wording back exactly, and would silently
     * merge two different loops that happened to be phrased identically.
     */
    loopId: z.string().trim().min(1).optional(),
    actorType: z.enum(ACTOR_TYPES).optional(),
    actorId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type LoopAddInput = z.infer<typeof addInput>;

export interface LoopAdded {
  readonly loopId: string;
  readonly event: AppendedEvent;
}

export const loopAdd = defineOperation({
  name: "loop_add",
  kind: "write",
  summary: "Records a loose end on an item — something unresolved that is not itself a work item.",
  input: addInput,
  async handler(ctx: ServiceContext, input: LoopAddInput): Promise<LoopAdded> {
    await requireItem(ctx, input.itemId);

    const loopId = input.loopId ?? crypto.randomUUID();

    // A loopId may be used **once per item**, ever — not once at a time.
    //
    // The narrower "is this id open right now" reading is the one that looks
    // right, and it is wrong, because of how the fold decides what is open.
    // `deriveOpenLoops` collects every close into a set over the whole stream
    // and filters every open against it (`open-loops.ts`), with no pairing
    // and no ordering. So one close suppresses *every* open of that id, past
    // and future: re-opening a closed id writes a row, returns success, and
    // produces a loop that orientation never reports and `loop_close` refuses
    // to close, because it is not open. A permanently invisible, unclosable
    // loop — strictly worse than the already-open case, which at least stays
    // visible.
    //
    // That global-set behaviour is not a defect to route around. It is what
    // makes the fold order-independent, which SCHEMA.md §3 requires: event
    // ids are handed out before commit, so a close genuinely can be read
    // before its own open, and a sequence-pairing fold would report a closed
    // loop as open in exactly that case. Reuse is the cheaper thing to give
    // up — ids are free, and `loop_add` mints one when the caller does not
    // care.
    //
    // Checked against every loop event for the id rather than the open ones,
    // and applied whether or not the caller supplied the id: a generated UUID
    // cannot collide, so the extra query costs nothing in the ordinary case
    // and the guard cannot be bypassed by omitting the field.
    const events = await loopEvents(ctx, input.itemId);
    if (usesLoopId(events, loopId)) {
      throw new InvalidInputError(
        `Loop ${loopId} has already been used on this item — a loopId cannot be reused, ` +
          "even after the loop it named was closed. Use a different loopId, or omit it " +
          "and one will be generated.",
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
      type: "open_loop",
      payload: { loopId, text: input.text },
    });

    // The generated id is returned because the caller otherwise has no way to
    // learn it, and without it the loop it just opened can never be closed.
    return { loopId, event };
  },
});

const closeInput = z
  .object({
    itemId: z.string().min(1),
    loopId: z.string().trim().min(1),
    actorType: z.enum(ACTOR_TYPES).optional(),
    actorId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type LoopCloseInput = z.infer<typeof closeInput>;

export const loopClose = defineOperation({
  name: "loop_close",
  kind: "write",
  summary: "Closes an open loop on an item.",
  input: closeInput,
  async handler(ctx: ServiceContext, input: LoopCloseInput): Promise<AppendedEvent> {
    await requireItem(ctx, input.itemId);

    // Refused when no such loop is open. The read path deliberately *ignores*
    // a close naming an unknown loopId — it reads a bounded slice of the
    // ledger and the open may simply be older than the window, so raising
    // there would break "catch me up" on an ordinary read. The write path has
    // no such excuse: it can see the item's whole loop history, and a close
    // for a loop that is not open is a caller mistake (a typo, or a loop
    // already closed) that would otherwise land as a permanently inert row.
    // Same split in posture the payload parsers already make between guarding
    // the write and tolerating the read.
    const open = deriveOpenLoops(await loopEvents(ctx, input.itemId));
    if (!open.some((loop) => loop.loopId === input.loopId)) {
      throw new NotFoundError(
        `No open loop ${input.loopId} on this item — it was never opened, or is already closed.`,
        { fields: ["loopId"] },
      );
    }

    const actor = await resolveActor(ctx, input);

    // `{loopId}` only. The text is not repeated: the opening event carries it,
    // and a second copy is a second thing that can disagree.
    return appendEvent(ctx.db, {
      itemId: input.itemId,
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        sessionId: input.sessionId ?? null,
      },
      assignmentId: actor.assignmentId,
      type: "open_loop_closed",
      payload: { loopId: input.loopId },
    });
  },
});
