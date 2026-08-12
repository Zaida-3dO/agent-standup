// `checkpoint` — SCHEMA.md §4, §18, §19. "Record what you tried, what you
// ruled out, what's next."
//
// SCHEMA.md §4: "No `checkpoints` table. A checkpoint is `events` with
// `type = 'checkpoint'` and `assignment_id` set." This operation is the
// write side of that — #28 (orientation) is documented as the row that
// *reads* the latest checkpoint; nothing else owns the write. Per-agent,
// not just per-item: `assignmentId` carries that, so a stalled builder still
// has its own resume point (§4) — which is why this requires the caller's
// live assignment rather than accepting a bare `itemId`.
import { z } from "zod";
import { ConflictError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent, type AppendedEvent } from "@/lib/events";
import type { Assignment } from "@/lib/claims";

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    sessionId: z.string().min(1),
    /** The checkpoint prose — SCHEMA.md §3: "prose is in `body`, agent is in `assignment_id`". */
    body: z.string().trim().min(1, "checkpoint body is required"),
  })
  .strict();

export type CheckpointOperationInput = z.infer<typeof inputSchema>;

export const checkpoint = defineOperation({
  name: "checkpoint",
  kind: "write",
  summary: "Records what you tried, what you ruled out, what's next.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: CheckpointOperationInput): Promise<AppendedEvent> {
    // A checkpoint is per AGENT, not just per item (§4) — it needs the
    // caller's own live assignment to attribute it to, the same lookup
    // `release` and `heartbeat` make for the same reason.
    const rows = await ctx.db.$queryRawUnsafe<Assignment[]>(
      `SELECT * FROM "Assignment"
       WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
       LIMIT 1`,
      input.itemId,
      input.sessionId,
    );
    const assignment = rows[0];
    if (!assignment) {
      throw new ConflictError(
        `Session ${input.sessionId} does not hold a live assignment on ${input.itemId} — a checkpoint needs one to attribute to.`,
        { fields: ["itemId", "sessionId"] },
      );
    }

    // "(none — prose is in `body`, agent is in `assignment_id`)" — SCHEMA.md
    // §3's payload table for `checkpoint`. The payload is deliberately {}.
    return appendEvent(ctx.db, {
      itemId: assignment.itemId,
      actor: {
        actorType: assignment.holderType,
        actorId: assignment.holderId,
        sessionId: assignment.sessionId,
      },
      assignmentId: assignment.id,
      type: "checkpoint",
      payload: {},
      body: input.body,
    });
  },
});
