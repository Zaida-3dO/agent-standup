// `list_processes` — MILESTONES.md #45.
//
// The registry, readable. Two callers want it and they want different
// slices: an agent asking "what am I still running?" (its own crew, live),
// and a person diagnosing a refusal asking "what is on this machine?".
//
// Defaults to **live rows only**, because that is the set the guard reads
// and therefore the set a refusal is explained by. Ended rows are available
// behind a switch rather than being the default: on a long-running
// installation they are the large majority and nothing routine wants them.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { PROCESS_COLUMNS, toProcessRecord, type RegisteredProcessRecord } from "./register-process";

const inputSchema = z
  .object({
    machine: z.string().trim().min(1).optional(),
    /** Narrow to one crew. Matched against the root, so it returns the whole tree's processes. */
    rootSessionId: z.string().trim().min(1).optional(),
    /** Include rows whose process has ended. Off by default. */
    includeEnded: z.boolean().default(false),
  })
  .strict();

export type ListProcessesInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const listProcesses = defineOperation({
  name: "list_processes",
  kind: "read",
  summary: "Lists registered processes, live by default, optionally narrowed to a machine or crew.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: ListProcessesInput,
  ): Promise<readonly RegisteredProcessRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (!input.includeEnded) conditions.push(`"endedAt" IS NULL`);
    if (input.machine !== undefined) {
      values.push(input.machine);
      conditions.push(`"machine" = $${values.length}`);
    }
    if (input.rootSessionId !== undefined) {
      values.push(input.rootSessionId);
      conditions.push(`"root_session_id" = $${values.length}`);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = await ctx.db.$queryRawUnsafe<Parameters<typeof toProcessRecord>[0][]>(
      `SELECT ${PROCESS_COLUMNS} FROM "registered_processes" ${where}
       ORDER BY "registeredAt" DESC, "pid" ASC`,
      ...values,
    );
    return rows.map(toProcessRecord);
  },
});
