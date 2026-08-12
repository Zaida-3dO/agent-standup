// Shared shape for the `account` admin operations. See docs/plans/
// SCHEMA.md §15, §17.7, §23.2.
//
// `budgetWindows` needs no NULL-preserving workaround the way `machine-row`
// does for `sourceGlobs` — jsonb keeps its own null through a raw query
// (`../../settings/overrides.ts`'s own comment on `effectiveBudgetWindows`),
// so it reads straight off the row.

export interface AccountRecord {
  readonly id: string;
  readonly vendor: string;
  readonly displayName: string;
  readonly planType: "subscription" | "metered";
  readonly usage5h: string | null;
  readonly usageWeekly: string | null;
  readonly usageAt: string | null;
  /** Null = no override (inherits `budget.windows`). A value = an override. */
  readonly budgetWindows: unknown;
}

/** The raw shape `$queryRawUnsafe` returns for one `"Account"` row. */
export interface RawAccountRow {
  id: string;
  vendor: string;
  displayName: string;
  planType: string;
  usage5h: unknown;
  usageWeekly: unknown;
  usageAt: Date | string | null;
  budgetWindows: unknown;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toAccountRecord(row: RawAccountRow): AccountRecord {
  return {
    id: row.id,
    vendor: row.vendor,
    displayName: row.displayName,
    planType: row.planType as AccountRecord["planType"],
    // Prisma's raw driver returns NUMERIC as a string already; `String()` is
    // only a safety net if a future driver upgrade starts returning it some
    // other JS type — same reasoning as `../items/row.ts`'s `estimatedCost`.
    usage5h: row.usage5h === null ? null : String(row.usage5h),
    usageWeekly: row.usageWeekly === null ? null : String(row.usageWeekly),
    usageAt: isoOrNull(row.usageAt),
    budgetWindows: row.budgetWindows,
  };
}

export const ACCOUNT_COLUMNS = [
  "id",
  "vendor",
  '"displayName"',
  '"planType"',
  '"usage5h"',
  '"usageWeekly"',
  '"usageAt"',
  '"budget_windows" AS "budgetWindows"',
].join(", ");
