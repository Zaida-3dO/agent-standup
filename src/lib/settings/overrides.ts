// Reading the two per-entity override columns without losing the one
// distinction they exist to carry.
//
// `machines.source_globs` is `text[]` NULL, and the two states mean
// different things: NULL is "this machine does not override — use
// minting.source_globs", `{}` is "this machine overrides, and scans
// nothing". Under a COALESCE those are opposites.
//
// The generated client cannot express that. A Prisma scalar list is typed
// `string[]` and a SQL NULL is surfaced as `[]`, so a read through
// `machine.findMany` reports both states identically — which would make
// every non-overriding machine look like a deliberate empty override, and
// a deliberate empty override unreachable. The column is correct; the
// client's mapping of it is lossy, so the read that needs the distinction
// asks for it explicitly.
import type { SettingsSnapshot } from "./resolve";
import { resolveOverride, validateOverrideColumn } from "./validate";
import type { BudgetWindows } from "./budget-windows";

/**
 * A minimal query interface, so this is testable without a live database
 * and usable with either a client or a transaction handle.
 */
export interface RawQuery {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface MachineSourceGlobs {
  name: string;
  /** Null = no override. An array, including an empty one, = an override. */
  sourceGlobs: string[] | null;
}

/**
 * Reads `machines.source_globs` preserving NULL.
 *
 * The `CASE` is what does the work: it asks Postgres the null question
 * directly rather than inferring it from an array that arrived empty.
 */
export async function readMachineSourceGlobs(
  db: RawQuery,
  machineName: string,
): Promise<MachineSourceGlobs | null> {
  const rows = await db.$queryRawUnsafe<
    { name: string; source_globs: string[] | null; overridden: boolean }[]
  >(
    `SELECT "name",
            "source_globs",
            ("source_globs" IS NOT NULL) AS "overridden"
     FROM "Machine"
     WHERE "name" = $1`,
    machineName,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    sourceGlobs: row.overridden ? (row.source_globs ?? []) : null,
  };
}

/**
 * The globs minting should scan on one machine: the machine's own when it
 * overrides, the global setting otherwise.
 *
 * The single `COALESCE` §17.7 says this mechanism costs — and the reason
 * that sentence is affordable is that it appears exactly here, rather than
 * at each of minting's read sites.
 */
export function effectiveSourceGlobs(
  machine: Pick<MachineSourceGlobs, "sourceGlobs"> | null,
  snapshot: SettingsSnapshot,
): readonly string[] {
  return resolveOverride(machine?.sourceGlobs ?? null, snapshot.values["minting.source_globs"]);
}

/**
 * The budget windows for one account: the account's own when it overrides,
 * the global setting otherwise.
 *
 * `jsonb` keeps its own null, so this column needs no raw-SQL workaround —
 * only the same validation. An override stored before its schema tightened
 * is treated exactly as a bad `settings` row is (§17.3): the global value
 * is used and the failure is reported, rather than the account being
 * refused service or silently given a coerced value nobody chose.
 */
export function effectiveBudgetWindows(
  accountValue: unknown,
  snapshot: SettingsSnapshot,
): { windows: BudgetWindows; rejected: string[] | null } {
  if (accountValue === null || accountValue === undefined) {
    return { windows: snapshot.values["budget.windows"], rejected: null };
  }
  const parsed = validateOverrideColumn("accounts.budget_windows", accountValue);
  if (!parsed.ok) {
    return { windows: snapshot.values["budget.windows"], rejected: parsed.errors };
  }
  return {
    windows: (parsed.value ?? snapshot.values["budget.windows"]) as BudgetWindows,
    rejected: null,
  };
}
