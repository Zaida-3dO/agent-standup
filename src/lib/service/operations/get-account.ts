// `get_account` — SCHEMA.md §19 `GET /accounts/{id}`. MILESTONES.md #92.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ACCOUNT_COLUMNS,
  toAccountRecord,
  type RawAccountRow,
  type AccountRecord,
} from "../admin/account-row";

const inputSchema = z.object({ id: z.string().min(1) }).strict();

export type GetAccountInput = z.infer<typeof inputSchema>;

export const getAccount = defineOperation({
  name: "get_account",
  kind: "read",
  summary: "Reads one account by id.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetAccountInput): Promise<AccountRecord> {
    const rows = await ctx.db.$queryRawUnsafe<RawAccountRow[]>(
      `SELECT ${ACCOUNT_COLUMNS} FROM "Account" WHERE "id" = $1`,
      input.id,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No such account: ${input.id}.`, { fields: ["id"] });
    }
    return toAccountRecord(row);
  },
});
