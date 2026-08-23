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
import {
  ITEM_COLUMNS,
  toItemRecord,
  toItemWriteRecord,
  type ItemRecord,
  type ItemWriteRecord,
  type RawItemRow,
} from "../items/row";
import {
  applyTransition,
  rehearseTransition,
  type TransitionOutcome,
} from "../state-machine/transition";
import { RehearsalRollback } from "./rehearsal-rollback";
import { callerEventActor, liveAssignmentId } from "../items/event-attribution";
import { appendEvent } from "@/lib/events";
import { evaluateNotifications, snapshotOf, type NotificationOutcome } from "../notify-on-change";

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
    /**
     * Return the whole `items` row rather than the slim default — the same
     * flag, spelled the same way, that `get_item`/`list_items`/`get_board`
     * already take (MILESTONES.md #107). Off by default: a state change is
     * the write least likely to want the record back, because the caller
     * just supplied everything that changed. See `ItemWriteRecord`.
     */
    full: z.boolean().default(false),
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
  /**
   * The item as it now stands — slim by default, the whole record under
   * `full: true`. The key stays `item` in both shapes so a caller reading
   * `result.item.state` keeps working; what changes is how much rides
   * beside it.
   */
  readonly item: ItemRecord | ItemWriteRecord;
  readonly outcome: AppliedTransitionOutcome;
  /**
   * Who the notification rules say to tell about this move — MILESTONES.md
   * #101. Absent when notifications are off (`notify.doc` unset), which is
   * distinguishable from "on, and nobody matched" (an outcome with an empty
   * `recipients`). Delivery is not this operation's job: SCHEMA.md §1.1b
   * hands over a doc path and never knows what the chat app is.
   */
  readonly notifications?: NotificationOutcome;
}

async function loadItemRecord(ctx: ServiceContext, id: string): Promise<ItemRecord> {
  const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
    `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
    id,
  );
  return toItemRecord(rows[0]!);
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const transitionItem = defineOperation({
  name: "transition_item",
  kind: "write",
  summary: "Moves an item to a new state, validating what that state requires. Supports dry_run.",
  // Stryker restore all
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

    // The before snapshot has to be read *before* the transition writes, and
    // is only needed when notifications are on — SCHEMA.md §17.2's "null
    // means notifications off", so an installation that has not configured
    // the capability pays nothing for this.
    const notifyDoc = ctx.settings.values["notify.doc"];
    const before = notifyDoc === null ? null : await loadItemRecord(ctx, input.id);

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

    // The notification evaluator's caller — MILESTONES.md #101. `assignee`
    // is passed as null on both sides because a transition does not touch
    // assignments, so it cannot be what changed; `snapshotOf` documents why
    // that is the right value rather than a missing one.
    const notifications =
      before === null
        ? undefined
        : await evaluateNotifications(
            ctx.db,
            notifyDoc,
            snapshotOf(before, null),
            snapshotOf(item, null),
          );

    const outcome: AppliedTransitionOutcome = {
      itemId: applied.itemId,
      from: applied.from,
      to: applied.to,
      allowed: true,
      rehearsed: false,
    };
    return {
      // `outcome` was already the compact shape this row wanted — `dryRun`
      // has always returned it and nothing else. What overflowed was the
      // whole record sitting beside it, which is what `full` now gates.
      item: input.full ? item : toItemWriteRecord(item),
      outcome,
      ...(notifications ? { notifications } : {}),
    };
  },
});
