// `heartbeat` — SCHEMA.md §2, §18, §19. "Still alive." Stamps `lastActive`
// on the caller's own live assignment.
//
// SCHEMA.md §2 documents `last_active` as "stamped by the hook on every tool
// call — free, no agent effort", so in the ordinary case nothing ever calls
// this operation directly. It exists for the case the hook doesn't cover —
// a session that wants to say "still here" without making a tool call the
// hook would see (MILESTONES.md #18's own listing: "Usually unnecessary —
// the hook does it").
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
  summary: "Still alive. (Usually unnecessary — the hook does it.)",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: HeartbeatOperationInput): Promise<Assignment> {
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
