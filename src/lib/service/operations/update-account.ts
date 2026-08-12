// `update_account` — SCHEMA.md §19 `PATCH /accounts/{id}`, §15, §17.7,
// §23.2: "`accounts.vendor` is checked against the registered adapter list
// on write; a vendor with no adapter is a setting nobody can act on."
// MILESTONES.md #92.
//
// **Upsert, not edit-only** — same reasoning as `update_machine`: SCHEMA.md
// §19 lists only `GET`/`PATCH` for `/accounts`, and unlike `repos`
// (deliberate `POST`) there is no separate creation verb, yet an
// installation genuinely does need to add a second account (the seed
// creates exactly one — `prisma/seed.mjs`). Unlike `Machine`, `Account`
// has three NOT NULL columns with no default (`vendor`, `displayName`,
// `planType`), so creating one is only valid once all three are supplied —
// checked in application code rather than left to the database, so a
// caller creating an account with a missing field gets `invalid_input`
// naming it rather than a raw constraint violation.
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { validateOverrideColumn } from "@/lib/settings";
import { isRegisteredVendor } from "../usage-adapters";
import {
  ACCOUNT_COLUMNS,
  toAccountRecord,
  type RawAccountRow,
  type AccountRecord,
} from "../admin/account-row";

const inputSchema = z
  .object({
    id: z.string().min(1),
    vendor: z.string().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    planType: z.enum(["subscription", "metered"]).optional(),
    /** Omitted = no change. `null` = clear the override. A value = set it. Validated below (§17.7). */
    budgetWindows: z.unknown().optional(),
  })
  .strict();

export type UpdateAccountInput = z.infer<typeof inputSchema>;

export const updateAccount = defineOperation({
  name: "update_account",
  kind: "write",
  summary: "Edits an account, or creates one if the id is new.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: UpdateAccountInput): Promise<AccountRecord> {
    if (input.vendor !== undefined && !isRegisteredVendor(input.vendor)) {
      throw new InvalidInputError(
        `Unrecognised vendor: ${input.vendor}. No usage adapter is registered for it.`,
        { fields: ["vendor"] },
      );
    }

    const budgetWindowsProvided = input.budgetWindows !== undefined;
    let validatedBudgetWindows: unknown = null;
    if (budgetWindowsProvided) {
      const validated = validateOverrideColumn("accounts.budget_windows", input.budgetWindows);
      if (!validated.ok) {
        throw new InvalidInputError(`Invalid budgetWindows: ${validated.errors.join("; ")}`, {
          fields: ["budgetWindows"],
        });
      }
      validatedBudgetWindows = validated.value;
    }

    const existingRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Account" WHERE "id" = $1`,
      input.id,
    );
    const exists = existingRows.length > 0;

    if (!exists) {
      const missing = (["vendor", "displayName", "planType"] as const).filter(
        (field) => input[field] === undefined,
      );
      if (missing.length > 0) {
        throw new InvalidInputError(
          `Creating a new account requires vendor, displayName and planType. Missing: ${missing.join(", ")}.`,
          { fields: missing },
        );
      }

      const rows = await ctx.db.$queryRawUnsafe<RawAccountRow[]>(
        `INSERT INTO "Account" ("id", "vendor", "displayName", "planType", "budget_windows")
         VALUES ($1, $2, $3, $4::"PlanType", $5::jsonb)
         RETURNING ${ACCOUNT_COLUMNS}`,
        input.id,
        input.vendor,
        input.displayName,
        input.planType,
        budgetWindowsProvided ? JSON.stringify(validatedBudgetWindows) : null,
      );
      return toAccountRecord(rows[0]!);
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.vendor !== undefined) {
      setClauses.push(`"vendor" = $${paramIndex}`);
      values.push(input.vendor);
      paramIndex++;
    }
    if (input.displayName !== undefined) {
      setClauses.push(`"displayName" = $${paramIndex}`);
      values.push(input.displayName);
      paramIndex++;
    }
    if (input.planType !== undefined) {
      setClauses.push(`"planType" = $${paramIndex}::"PlanType"`);
      values.push(input.planType);
      paramIndex++;
    }
    if (budgetWindowsProvided) {
      setClauses.push(`"budget_windows" = $${paramIndex}::jsonb`);
      values.push(validatedBudgetWindows === null ? null : JSON.stringify(validatedBudgetWindows));
      paramIndex++;
    }

    if (setClauses.length === 0) {
      const currentRows = await ctx.db.$queryRawUnsafe<RawAccountRow[]>(
        `SELECT ${ACCOUNT_COLUMNS} FROM "Account" WHERE "id" = $1`,
        input.id,
      );
      const current = currentRows[0];
      if (!current) {
        throw new NotFoundError(`No such account: ${input.id}.`, { fields: ["id"] });
      }
      return toAccountRecord(current);
    }

    values.push(input.id);
    const rows = await ctx.db.$queryRawUnsafe<RawAccountRow[]>(
      `UPDATE "Account" SET ${setClauses.join(", ")} WHERE "id" = $${paramIndex} RETURNING ${ACCOUNT_COLUMNS}`,
      ...values,
    );
    const updated = rows[0];
    if (!updated) {
      throw new NotFoundError(`No such account: ${input.id}.`, { fields: ["id"] });
    }
    return toAccountRecord(updated);
  },
});
