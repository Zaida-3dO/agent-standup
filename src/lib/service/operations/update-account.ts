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
//
// **One atomic statement, race-free — same shape as `update_machine`.** The
// existence check below decides only whether the three required fields must
// be present in *this* request (a clean `invalid_input` for a genuinely new
// row with a missing field, rather than a raw NOT NULL violation); the
// write itself is a single `INSERT … ON CONFLICT DO UPDATE`, so two
// concurrent calls creating the same new id race to a deterministic
// last-write-wins update rather than one of them throwing an unhandled
// unique-constraint error. This is safe against the one race that matters
// here — the existence check going stale between it and the write — because
// `Account` rows are never deleted: if the check saw "exists", the row is
// still there when the statement runs (so the ON CONFLICT branch fires, and
// the CASE below leaves any field this call did not supply untouched); if
// the check saw "does not exist" and lost a race to a concurrent creator,
// this call already validated all three required fields as a precondition
// of that same "does not exist" branch, so the values it supplies remain
// legal whichever branch the statement actually takes.
//
// **The one Postgres subtlety that makes this harder than `update_machine`'s
// version, found the hard way (CI, not read-review): `ON CONFLICT DO UPDATE`
// still validates NOT NULL against the row the VALUES clause constructs,
// even on a call that will end up routed to the UPDATE branch.** A bare `$2`
// for `vendor` — null on a call that is only touching `budgetWindows` on an
// *existing* row — makes Postgres reject the statement before it ever gets
// to notice the id conflicts, with a raw `23502` violation naming a column
// this call never touched. Each NOT NULL column's VALUES expression is
// therefore `COALESCE(<supplied value>, (SELECT <column> FROM "Account"
// WHERE "id" = $1))` — if the row exists, the subquery supplies its current
// value so the constructed row is never actually null in a NOT NULL column;
// if the row does not exist, the two `missing`-field checks above already
// guarantee the supplied value is non-null, so the subquery (which would
// find nothing) is never reached. `budget_windows` has no such constraint
// and needs no COALESCE — a real, storable null is exactly what "no
// override" means for it.
import { z } from "zod";
import { InvalidInputError } from "../errors";
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

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const updateAccount = defineOperation({
  name: "update_account",
  kind: "write",
  summary: "Edits an account, or creates one if the id is new.",
  // Stryker restore all
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
    }

    const vendorProvided = input.vendor !== undefined;
    const displayNameProvided = input.displayName !== undefined;
    const planTypeProvided = input.planType !== undefined;

    const rows = await ctx.db.$queryRawUnsafe<RawAccountRow[]>(
      `INSERT INTO "Account" ("id", "vendor", "displayName", "planType", "budget_windows")
       VALUES (
         $1,
         COALESCE($2, (SELECT "vendor" FROM "Account" WHERE "id" = $1)),
         COALESCE($3, (SELECT "displayName" FROM "Account" WHERE "id" = $1)),
         COALESCE($4::"PlanType", (SELECT "planType" FROM "Account" WHERE "id" = $1)),
         $5::jsonb
       )
       ON CONFLICT ("id") DO UPDATE
         SET "vendor" = CASE WHEN $6::boolean THEN $2 ELSE "Account"."vendor" END,
             "displayName" = CASE WHEN $7::boolean THEN $3 ELSE "Account"."displayName" END,
             "planType" = CASE WHEN $8::boolean THEN $4::"PlanType" ELSE "Account"."planType" END,
             "budget_windows" = CASE WHEN $9::boolean THEN $5::jsonb ELSE "Account"."budget_windows" END
       RETURNING ${ACCOUNT_COLUMNS}`,
      input.id,
      input.vendor ?? null,
      input.displayName ?? null,
      input.planType ?? null,
      // `JSON.stringify(null)` is the three-character *string* `"null"`, not
      // a SQL NULL — passing that through `$5::jsonb` would store the JSON
      // scalar null inside a non-null column instead of clearing the
      // override the way `overrides.ts`'s "Null = no override" actually
      // means. Guarded explicitly so "clear the override" writes a real
      // column NULL, not a stored `null` value that merely reads back the
      // same in JS.
      budgetWindowsProvided
        ? validatedBudgetWindows === null
          ? null
          : JSON.stringify(validatedBudgetWindows)
        : null,
      vendorProvided,
      displayNameProvided,
      planTypeProvided,
      budgetWindowsProvided,
    );
    return toAccountRecord(rows[0]!);
  },
});
