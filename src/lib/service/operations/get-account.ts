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

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getAccount = defineOperation({
  name: "get_account",
  kind: "read",
  summary: "Reads one account by id.",
  // Stryker restore all
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
