// `get_machine` — SCHEMA.md §19 `GET /machines/{name}`. MILESTONES.md #92.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  MACHINE_SELECT,
  toMachineRecord,
  type RawMachineRow,
  type MachineRecord,
} from "../admin/machine-row";

const inputSchema = z.object({ name: z.string().min(1) }).strict();

export type GetMachineInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getMachine = defineOperation({
  name: "get_machine",
  kind: "read",
  summary: "Reads one machine by name.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetMachineInput): Promise<MachineRecord> {
    const rows = await ctx.db.$queryRawUnsafe<RawMachineRow[]>(
      `SELECT ${MACHINE_SELECT} FROM "Machine" WHERE "name" = $1`,
      input.name,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such machine: ${input.name}.`, { fields: ["name"] });
    }
    return toMachineRecord(row);
  },
});
