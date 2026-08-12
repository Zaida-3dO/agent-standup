// `list_accounts` — SCHEMA.md §19 `GET /accounts`, §15. MILESTONES.md #92.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ACCOUNT_COLUMNS,
  toAccountRecord,
  type RawAccountRow,
  type AccountRecord,
} from "../admin/account-row";

const inputSchema = z.object({}).strict();

export type ListAccountsInput = z.infer<typeof inputSchema>;

export interface ListAccountsOutput {
  readonly accounts: readonly AccountRecord[];
}

export const listAccounts = defineOperation({
  name: "list_accounts",
  kind: "read",
  summary: "Lists accounts.",
  input: inputSchema,
  async handler(ctx: ServiceContext): Promise<ListAccountsOutput> {
    const rows = await ctx.db.$queryRawUnsafe<RawAccountRow[]>(
      `SELECT ${ACCOUNT_COLUMNS} FROM "Account" ORDER BY "id" ASC`,
    );
    return { accounts: rows.map(toAccountRecord) };
  },
});
