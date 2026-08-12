// `list_machines` — SCHEMA.md §19 `GET /machines`, §15. MILESTONES.md #92.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  MACHINE_SELECT,
  toMachineRecord,
  type RawMachineRow,
  type MachineRecord,
} from "../admin/machine-row";

const inputSchema = z.object({}).strict();

export type ListMachinesInput = z.infer<typeof inputSchema>;

export interface ListMachinesOutput {
  readonly machines: readonly MachineRecord[];
}

export const listMachines = defineOperation({
  name: "list_machines",
  kind: "read",
  summary: "Lists machines.",
  input: inputSchema,
  async handler(ctx: ServiceContext): Promise<ListMachinesOutput> {
    const rows = await ctx.db.$queryRawUnsafe<RawMachineRow[]>(
      `SELECT ${MACHINE_SELECT} FROM "Machine" ORDER BY "name" ASC`,
    );
    return { machines: rows.map(toMachineRecord) };
  },
});
