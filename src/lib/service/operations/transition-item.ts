// `transition` — SCHEMA.md §19 `POST /items/{id}/transition?dry_run=`,
// §18 "Move to a new state. Validates required fields. `dry_run` to preview
// a rejection." See MILESTONES.md #27.
//
// A thin operation over row #15's state machine (`../state-machine/`): this
// module owns the adapter-facing shape (input schema, event row, rehearsal
// rollback) and calls straight into `applyTransition`/`rehearseTransition`
// for the actual guard evaluation and write. It does not reimplement any of
// that mechanism.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";
import {
  applyTransition,
  rehearseTransition,
  type TransitionOutcome,
} from "../state-machine/transition";
import { RehearsalRollback } from "./rehearsal-rollback";
import { callerEventActor, liveAssignmentId } from "../items/event-attribution";
import { appendEvent } from "@/lib/events";

const inputSchema = z
  .object({
    id: z.string().min(1),
    to: z.string().min(1),
    /**
     * Extra fields the guards for the target state need — `blocked_reason`
     * entering `blocked`, `summary` entering a completed state, and so on.
     * Passed straight through to the guard layer unchanged (SCHEMA.md §16);
     * this operation does not interpret them.
     */
    fields: z.record(z.string(), z.unknown()).optional(),
    /**
     * `dry_run=true` reports what *would* happen and guarantees nothing is
     * written — see `rehearsal-rollback.ts` for how that guarantee is
     * enforced rather than merely assumed.
     */
    dryRun: z.boolean().default(false),
  })
  .strict();

export type TransitionItemInput = z.infer<typeof inputSchema>;

/**
 * What a real (non-rehearsed) move reports about itself. Deliberately its
 * own shape rather than `TransitionOutcome & { rehearsed: false }` —
 * `TransitionOutcome.rehearsed` is typed `readonly true` (`transition.ts`:
 * "Always true here — rehearseTransition never writes"), so that
 * intersection is `never` by construction, not merely unused. A real
 * `applyTransition` call, unlike rehearsal, never returns a rejection either
 * — it throws instead (see that function's own doc for why) — so `allowed`
 * has nothing to be but `true` here.
 */
export interface AppliedTransitionOutcome {
  readonly itemId: string;
  readonly from: TransitionOutcome["from"];
  readonly to: TransitionOutcome["to"];
  readonly allowed: true;
  readonly rehearsed: false;
}

/** What `transition_item` returns on a real (non-rehearsed) move. */
export interface TransitionItemResult {
  readonly item: ItemRecord;
  readonly outcome: AppliedTransitionOutcome;
}

async function loadItemRecord(ctx: ServiceContext, id: string): Promise<ItemRecord> {
  const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
    `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
    id,
  );
  return toItemRecord(rows[0]!);
}

export const transitionItem = defineOperation({
  name: "transition_item",
  kind: "write",
  summary: "Moves an item to a new state, validating what that state requires. Supports dry_run.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: TransitionItemInput): Promise<TransitionItemResult> {
    if (input.dryRun) {
      // Evaluate for real — same guard path a real transition takes,
      // `rehearseTransition`'s whole point — then abandon this transaction
      // unconditionally by throwing, so anything a guard wrote through
      // `ctx.db` while deciding never survives to commit. See
      // `rehearsal-rollback.ts` for the full reasoning and the two things
      // this alone would not catch.
      const outcome = await rehearseTransition(ctx, {
        itemId: input.id,
        to: input.to,
        fields: input.fields,
      });
      throw new RehearsalRollback(outcome);
    }

    const applied = await applyTransition(ctx, {
      itemId: input.id,
      to: input.to,
      fields: input.fields,
    });

    // "Every mutating call appends a row" (SCHEMA.md §3) — `state-change`
    // is the dedicated event type for this (§3's payload-shapes table),
    // distinct from the `field-change` an ordinary `update_item` edit
    // writes.
    // Through `appendEvent` (#102) — that module's stated invariant, and
    // what gets `sessionId` and `assignmentId` onto the row. A state change
    // is the mutation most worth attributing and was the one losing its
    // session: "who moved this" had no answer for exactly the events people
    // ask it about.
    await appendEvent(ctx.db, {
      itemId: input.id,
      actor: callerEventActor(ctx.caller),
      assignmentId: await liveAssignmentId(ctx.db, input.id, ctx.caller),
      type: "state_change",
      payload: { from: applied.from, to: applied.to },
    });

    const item = await loadItemRecord(ctx, input.id);
    const outcome: AppliedTransitionOutcome = {
      itemId: applied.itemId,
      from: applied.from,
      to: applied.to,
      allowed: true,
      rehearsed: false,
    };
    return { item, outcome };
  },
});
