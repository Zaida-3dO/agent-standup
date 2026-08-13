// `backfill` — bulk-loads an existing body of work into an empty
// installation (docs/plans/BACKFILL.md, SCHEMA.md §1, §2, §3, §6).
//
// One call takes a whole payload of already-shaped tasks and lands them as
// items, events, assignments and artifacts. It exists because the ordinary
// write path cannot express history: an item that finished last March
// cannot be created and then walked through eleven transitions to reach the
// state it is already in, and doing so would stamp every event with today's
// timestamp and today's actor.
//
// ── It bypasses the state machine. Here is what keeps that from being a
//    hole that bypasses every guard ────────────────────────────────────
//
// Being honest about the shape of the risk first: this operation writes
// `items.state` directly, so a caller can produce an item in a state the
// transition guards would never have allowed it to reach. That is not a
// side effect to be tidied away — it is the point of an import, and any
// design that pretended otherwise would just be doing it less visibly.
// Four things bound it:
//
//   1. **The surface does not exist unless it was deliberately opened.**
//      `ENABLE_BACKFILL` is an environment variable, checked fail-closed
//      (`../../backfill/enabled.ts`), so the intended posture is a window:
//      open it, run one import, close it. During normal operation there is
//      nothing here to call. The toggle lives in the deployment layer, so
//      no caller of this API — over HTTP, MCP or the command line — can
//      flip it on for itself.
//   2. **It cannot reach a state the state machine does not have.** The
//      state is not taken from the caller; it is resolved through the same
//      remap table the importers use (`mapSourceStatus`), which refuses a
//      status it does not recognise. So an import can produce an unusual
//      *history*, but never an item in a state no rule has heard of.
//   3. **It is not a general-purpose write.** It creates; it never updates.
//      A task already imported is skipped, not overwritten — so this
//      operation cannot be used to move an existing item into a state a
//      guard would have refused, which is the escalation that would matter.
//      Re-running it against a database where items have since been
//      claimed, transitioned or annotated changes nothing.
//   4. **It is transactional.** Everything lands or nothing does, so a
//      failure partway through cannot leave a half-imported graph for the
//      guards to reason about afterwards.
//
// What that leaves is a real, named residual: while the window is open, a
// caller who can reach the API can insert history. That is why the window
// is meant to be short, announced loudly at startup, visible on the health
// endpoint, and — as the contract document says — opened when nothing else
// is running.
import { z } from "zod";
import { backfillPayloadSchema, BACKFILL_CONTRACT_VERSION } from "@/lib/backfill/contract";
import { BACKFILL_DISABLE_REMINDER, isBackfillEnabled } from "@/lib/backfill/enabled";
import { backfillTasks, type BackfillCounts } from "@/lib/backfill/run";
import { transactionBackedClient } from "@/lib/backfill/transaction-client";
import { ForbiddenError, InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";

export interface BackfillResult extends BackfillCounts {
  readonly contractVersion: number;
  /** Returned on every successful call, because the realistic failure is forgetting to close the window. */
  readonly reminder: string;
}

/**
 * Refused with `forbidden`, **not** `guard_rejected`, and that is a
 * deliberate choice rather than a shrug at which code to use.
 *
 * §22 forbids an adapter that exposes any write from waiving an operation
 * *a registered guard can reject*, and the MCP adapter waives this one
 * (`../../adapters/waivers.ts`). Refusing here with a registered guard
 * would make that waiver illegal. It is also the more accurate code: no
 * rule about the work being imported was violated — this build simply does
 * not offer the operation right now.
 */
function assertEnabled(): void {
  if (!isBackfillEnabled()) {
    throw new ForbiddenError(
      "Backfill is disabled. It is opened deliberately, for one import, by setting " +
        "ENABLE_BACKFILL=true in the deployment environment and restarting.",
    );
  }
}

export const backfill = defineOperation({
  name: "backfill",
  kind: "write",
  summary:
    "Bulk-loads an existing body of work — items, history, claims and artifacts — in one call.",
  input: z.object({ payload: backfillPayloadSchema }).strict(),
  async handler(ctx: ServiceContext, input: { payload: unknown }): Promise<BackfillResult> {
    assertEnabled();

    // Parsed again here rather than trusted from the erased input type:
    // the registry hands the handler what the schema produced, and this
    // narrows it back to the contract type without an assertion.
    const parsed = backfillPayloadSchema.safeParse((input as { payload: unknown }).payload);
    if (!parsed.success) {
      throw new InvalidInputError("The backfill payload did not match the contract.", {
        fields: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
    }

    const counts = await backfillTasks(transactionBackedClient(ctx.db), parsed.data);
    return {
      ...counts,
      contractVersion: BACKFILL_CONTRACT_VERSION,
      reminder: BACKFILL_DISABLE_REMINDER,
    };
  },
});
