// `register_process` — MILESTONES.md #45, DECISIONS.md §4 ("Requires agents
// to register processes they start").
//
// The declaration half of the kill guard. Without it the guard has nothing
// to check ownership *against* and every kill is refused as unregistered,
// so this operation is not an optional convenience — it is the input the
// check reads.
//
// **Re-registering a live pid is a conflict, not an update.** A second
// session claiming a pid another session already holds is either a mistake
// or a reused pid whose first owner never declared it ended, and silently
// overwriting the owner would let any session take ownership of any process
// by asserting it — which is the guard's whole premise, undone by its own
// registration path. The partial unique index enforces the same thing at
// the database, so the refusal holds under a race as well as a sequence.
import { z } from "zod";
import { ConflictError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { normaliseExecutable } from "@/lib/kill/parse";

const inputSchema = z
  .object({
    machine: z.string().trim().min(1),
    /**
     * A pid, as the operating system issued it. Positive by definition —
     * `0` and negatives are process *groups* on POSIX, which name something
     * wider than one process and are not what this registry models.
     */
    pid: z.number().int().positive(),
    executable: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    /**
     * The root of the registering session's tree. Defaulted to the session
     * itself, because a root session is its own root (SCHEMA.md §2) and a
     * caller with no crew above it should not have to say so twice.
     */
    rootSessionId: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

export type RegisterProcessInput = z.infer<typeof inputSchema>;

export interface RegisteredProcessRecord {
  readonly id: string;
  readonly machine: string;
  readonly pid: number;
  readonly executable: string;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly description: string | null;
  readonly registeredAt: string;
  readonly endedAt: string | null;
}

interface RawProcessRow {
  id: string;
  machine: string;
  pid: number;
  executable: string;
  sessionId: string;
  root_session_id: string;
  description: string | null;
  registeredAt: Date;
  endedAt: Date | null;
}

export const PROCESS_COLUMNS = `"id", "machine", "pid", "executable", "sessionId", "root_session_id", "description", "registeredAt", "endedAt"`;

export function toProcessRecord(row: RawProcessRow): RegisteredProcessRecord {
  return {
    id: row.id,
    machine: row.machine,
    pid: row.pid,
    executable: row.executable,
    sessionId: row.sessionId,
    rootSessionId: row.root_session_id,
    description: row.description,
    registeredAt: row.registeredAt.toISOString(),
    endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
  };
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const registerProcess = defineOperation({
  name: "register_process",
  kind: "write",
  summary:
    "Declares a process this session started, so the kill guard can tell it from another crew's.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: RegisterProcessInput,
  ): Promise<RegisteredProcessRecord> {
    const executable = normaliseExecutable(input.executable);
    const rootSessionId = input.rootSessionId ?? input.sessionId;

    const existing = await ctx.db.$queryRawUnsafe<{ root_session_id: string }[]>(
      `SELECT "root_session_id" FROM "registered_processes"
       WHERE "machine" = $1 AND "pid" = $2 AND "endedAt" IS NULL`,
      input.machine,
      input.pid,
    );
    if (existing.length > 0) {
      throw new ConflictError(
        `Process ${input.pid} on ${input.machine} is already registered and still live. ` +
          `End the existing registration first if the process has exited.`,
        { fields: ["machine", "pid"] },
      );
    }

    const rows = await ctx.db.$queryRawUnsafe<RawProcessRow[]>(
      `INSERT INTO "registered_processes"
         ("id", "machine", "pid", "executable", "sessionId", "root_session_id", "description")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)
       RETURNING ${PROCESS_COLUMNS}`,
      input.machine,
      input.pid,
      executable,
      input.sessionId,
      rootSessionId,
      input.description ?? null,
    );
    return toProcessRecord(rows[0]!);
  },
});
