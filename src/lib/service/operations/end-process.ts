// `end_process` — the other half of `register_process` (MILESTONES.md #45).
//
// A registry that only ever grows answers the ownership question wrongly
// within an hour: pids are reused, so a stale live row eventually claims a
// pid belonging to something else entirely, and the guard would refuse a
// kill on the strength of a process that exited yesterday.
//
// **The row is closed, never deleted.** `endedAt` is set. A deleted row and
// a never-registered one are indistinguishable, and they want different
// answers — "that was yours and it has exited" is a useful thing to be able
// to say, and it is also the audit trail for what a crew was running.
//
// **Only the owning crew may close a registration.** Otherwise closing one
// is a way to launder ownership: end another crew's row, register the same
// pid as your own, kill it. The refusal is `forbidden` rather than
// `not_found`, because telling a caller the row does not exist when it does
// would send them to register a pid that is already held and get a
// conflict, which is a worse read of the same situation.
import { z } from "zod";
import { ForbiddenError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { PROCESS_COLUMNS, toProcessRecord, type RegisteredProcessRecord } from "./register-process";

const inputSchema = z
  .object({
    machine: z.string().trim().min(1),
    pid: z.number().int().positive(),
    /** The session closing it. Its crew must be the one that registered it. */
    sessionId: z.string().trim().min(1),
    rootSessionId: z.string().trim().min(1).optional(),
  })
  .strict();

export type EndProcessInput = z.infer<typeof inputSchema>;

interface OwnerRow {
  id: string;
  root_session_id: string;
}

export const endProcess = defineOperation({
  name: "end_process",
  kind: "write",
  summary: "Marks a registered process as ended, so its process id can be reused.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: EndProcessInput): Promise<RegisteredProcessRecord> {
    const rootSessionId = input.rootSessionId ?? input.sessionId;

    const owners = await ctx.db.$queryRawUnsafe<OwnerRow[]>(
      `SELECT "id", "root_session_id" FROM "registered_processes"
       WHERE "machine" = $1 AND "pid" = $2 AND "endedAt" IS NULL`,
      input.machine,
      input.pid,
    );
    const owner = owners[0];
    if (owner === undefined) {
      throw new NotFoundError(
        `No live registration for process ${input.pid} on ${input.machine}.`,
        { fields: ["machine", "pid"] },
      );
    }
    if (owner.root_session_id !== rootSessionId) {
      throw new ForbiddenError(
        `Process ${input.pid} on ${input.machine} was registered by another session's crew, ` +
          `so this session may not end its registration.`,
        { fields: ["sessionId"] },
      );
    }

    const rows = await ctx.db.$queryRawUnsafe<Parameters<typeof toProcessRecord>[0][]>(
      `UPDATE "registered_processes" SET "endedAt" = now()
       WHERE "id" = $1
       RETURNING ${PROCESS_COLUMNS}`,
      owner.id,
    );
    return toProcessRecord(rows[0]!);
  },
});
