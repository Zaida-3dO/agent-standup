// `note` — SCHEMA.md §7, §18, §19. Leaves a timestamped remark on an item.
//
// SCHEMA.md §7: "Timestamped remarks are already `events` with `type =
// note` — who said it, when, on which item." Unlike `checkpoint`, a note is
// not scoped to one agent's resume point — §7 gives the example of a
// person's remark, and both `caller.actor` (a person or an agent, holding
// nothing) and a session mid-crew can leave one. So this does not require a
// live assignment the way `checkpoint`/`release`/`heartbeat` do; it only
// requires the item to exist. `assignmentId` is set when the caller happens
// to hold one, purely for the same "which agent said this" attribution
// `checkpoint` gets structurally — never required for the write to succeed.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent, type AppendedEvent } from "@/lib/events";
import { resolveItemId } from "../items/resolve-id";

const ACTOR_TYPES = ["person", "agent", "system"] as const;

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    body: z.string().trim().min(1, "note body is required"),
    /** Who is leaving the note. Defaults to `system` when the caller carries no actor. */
    actorType: z.enum(ACTOR_TYPES).optional(),
    actorId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type NoteOperationInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const note = defineOperation({
  name: "note",
  kind: "write",
  summary: "Leaves a timestamped remark on an item.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: NoteOperationInput): Promise<AppendedEvent> {
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

    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    if (itemRows.length === 0) {
      throw new NotFoundError(`No such item: ${input.itemId}.`, { fields: ["itemId"] });
    }

    // If the caller names a session that holds a live assignment on this
    // item, attribute the note to it — same courtesy `checkpoint` gets
    // structurally, but optional here rather than required: SCHEMA.md §7's
    // whole point is that a note can come from someone who never claimed
    // anything (a person leaving a remark from the board).
    let assignmentId: string | null = null;
    let actorType: (typeof ACTOR_TYPES)[number] = input.actorType ?? "system";
    let actorId: string | null = input.actorId ?? null;

    if (input.sessionId) {
      const liveRows = await ctx.db.$queryRawUnsafe<
        { id: string; holderType: "person" | "agent"; holderId: string }[]
      >(
        `SELECT "id", "holderType", "holderId" FROM "Assignment"
         WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
         LIMIT 1`,
        input.itemId,
        input.sessionId,
      );
      const live = liveRows[0];
      if (live) {
        assignmentId = live.id;
        // The assignment's own holder is the more specific answer when the
        // caller didn't say otherwise — mirrors `checkpoint`'s attribution
        // without *requiring* the assignment the way checkpoint does.
        if (input.actorType === undefined) actorType = live.holderType;
        if (input.actorId == null) actorId = live.holderId;
      }
    }

    return appendEvent(ctx.db, {
      itemId: input.itemId,
      actor: {
        actorType,
        actorId,
        sessionId: input.sessionId ?? null,
      },
      assignmentId,
      type: "note",
      payload: {},
      body: input.body,
    });
  },
});
