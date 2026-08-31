// `takeover` — displacing a session that holds an item (MILESTONES.md #99,
// SCHEMA.md §2).
//
// A thin wrapper around `takeoverAssignment` (src/lib/takeover.ts), following
// `claim.ts`'s own shape exactly: the rules live in the library module, and
// what this file adds is the schema every adapter shares, an explicit
// item-existence check so a bad id is a typed `not_found` rather than a raw
// constraint violation, and registration so every adapter reaches the same
// write through the same door.
//
// **The two paths this exposes, because a reader of the schema alone would
// see only one.** Taking over from a holder the liveness ladder judges *dead*
// needs nothing but the two session ids — no force, no reason, no ceremony,
// because nothing is being interrupted. Taking over from a holder that may
// still be alive is allowed, but costs `force: true` **and** a written
// `reason`, and is refused with the warning quoted in full if either is
// missing. That asymmetry is the design; see the library module's header.
//
// **What this does not do.** It records the displacement and releases the
// assignment. It does not stop the displaced session — nothing yet refuses
// that session's tool calls, and the result carries a note saying so rather
// than leaving the caller to assume otherwise.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { takeoverAssignment, type TakeoverResult } from "@/lib/takeover";
import { resolveItemId } from "../items/resolve-id";

const HOLDER_TYPES = ["person", "agent"] as const;

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    /** The session being displaced. */
    fromSessionId: z.string().min(1),
    /** The session taking over. */
    bySessionId: z.string().min(1),
    holderType: z.enum(HOLDER_TYPES),
    holderId: z.string().min(1),
    /**
     * Why. **Required when the holder may still be alive** — enforced inside
     * `takeoverAssignment`, not here, because whether it is required depends
     * on how quiet the holder has been, which is a fact about the database
     * rather than about the input. Optional in the schema and mandatory in
     * the case that matters is the honest encoding of that.
     */
    reason: z.string().min(1).nullable().optional(),
    /** Acknowledges the warning. Only meaningful when the holder may be alive. */
    force: z.boolean().optional(),
  })
  .strict();

export type TakeoverOperationInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const takeover = defineOperation({
  name: "takeover",
  kind: "write",
  summary:
    "Takes an item from another session. Free if that session is dead; requires force plus a written reason if it may be alive. Releases the holder's claim but does NOT assign the item to you — call claim next — and does not stop the displaced session.",
  contract: {
    rules: [
      {
        fields: ["itemId"],
        rule: "A takeover RELEASES the previous assignment; it does NOT assign the item to the caller. Call `claim` immediately afterwards, through the front door — until you do, you hold nothing, and a checkpoint will not attribute to you. Claiming is deliberately not folded in: it has its own guards, and a takeover that also claimed would be two operations wearing one name.",
      },
      {
        fields: ["fromSessionId"],
        rule: "This does NOT stop the displaced session. Nothing refuses its tool calls, so it keeps its context, its running subagents and its write access — it simply stops appearing as the holder. If it may still be running, TELL IT DIRECTLY; the board will otherwise show one crew where two are working.",
      },
      {
        fields: ["force", "reason"],
        rule: "Both are required when the holder may still be alive (liveness `running` or `stalled`) and neither is needed when it is judged dead. Whether the holder is alive is a fact about the database, not about the input, which is why the schema cannot mark them required.",
      },
    ],
    example: {
      itemId: "b1f0c3d2-0000-4000-8000-000000000000",
      fromSessionId: "cd1575a9",
      bySessionId: "725c8167",
      holderType: "agent",
      holderId: "poe-3f1",
      force: true,
      reason: "Ope asked me to take this item; the holder has not checkpointed in two hours.",
    },
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: TakeoverOperationInput): Promise<TakeoverResult> {
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

    // Checked ahead of the assignment read for the same reason `claim` checks
    // it: a bad item id would otherwise be indistinguishable from "that
    // session holds nothing here", and the two need different fixes.
    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    if (itemRows.length === 0) {
      throw new NotFoundError(`No such item: ${input.itemId}.`, { fields: ["itemId"] });
    }

    return takeoverAssignment(
      ctx.db,
      {
        staleAfterSeconds: ctx.settings.values["liveness.stale_after_seconds"],
        deadAfterSeconds: ctx.settings.values["liveness.dead_after_seconds"],
      },
      {
        itemId: input.itemId,
        fromSessionId: input.fromSessionId,
        bySessionId: input.bySessionId,
        byHolderType: input.holderType,
        byHolderId: input.holderId,
        reason: input.reason ?? null,
        force: input.force ?? false,
      },
    );
  },
});
