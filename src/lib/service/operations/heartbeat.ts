// `heartbeat` — SCHEMA.md §2, §18, §19. "Still alive." Stamps `lastActive`
// on the caller's own live assignment.
//
// SCHEMA.md §2 documents `last_active` as "stamped by the hook on every tool
// call — free, no agent effort", and as of the liveness-signals work that is
// true: `record_tool_calls` stamps the column on the same statement that
// resolves the session's live assignment, so any session whose hook is
// flushing telemetry is seen without calling this operation at all.
//
// **That was not true before, and the correction is why this comment is
// long.** For most of this tree's history this operation was the *only*
// writer of `lastActive` anywhere in the source, while its own summary told
// callers it was "usually unnecessary — the hook does it". The hook did
// not. Any session that believed the summary left the column frozen at the
// instant of its claim, which made every threshold computed from it a
// measure of claim age wearing an activity column's name.
//
// So this operation is now genuinely the fallback it always described
// itself as — for the case the hook does not cover: a session running **no
// hook** (nothing spools, so nothing flushes, so nothing stamps), or one
// that wants to say "still here" across a long stretch with no tool call
// the hook would see. Those sessions are exactly the ones the eviction path
// cannot otherwise distinguish from a crash, so for them this call is not a
// courtesy — it is the whole signal.
//
// No event is appended. `events` is the ledger of things that *happened*
// (SCHEMA.md §3-4); a heartbeat is not an event in that sense; it is a
// liveness signal on the assignment row itself, and every heartbeat between
// two real actions would otherwise flood the per-item history with rows
// nobody reads. `lastActive` is itself already visible on the assignment.
import { z } from "zod";
import { ConflictError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import type { Assignment } from "@/lib/claims";
import { resolveItemId } from "../items/resolve-id";

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type HeartbeatOperationInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const heartbeat = defineOperation({
  name: "heartbeat",
  kind: "write",
  summary:
    "Still alive. Unnecessary if your hook is flushing tool calls — that stamps it. " +
    "Call it if you run no hook and are working a long stretch, or your claim can look idle.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: HeartbeatOperationInput): Promise<Assignment> {
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

    const rows = await ctx.db.$queryRawUnsafe<Assignment[]>(
      `UPDATE "Assignment" SET "lastActive" = CURRENT_TIMESTAMP
       WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
       RETURNING *`,
      input.itemId,
      input.sessionId,
    );
    const assignment = rows[0];
    if (!assignment) {
      throw new ConflictError(
        `Session ${input.sessionId} does not hold a live assignment on ${input.itemId}.`,
        { fields: ["itemId", "sessionId"] },
      );
    }
    return assignment;
  },
});
