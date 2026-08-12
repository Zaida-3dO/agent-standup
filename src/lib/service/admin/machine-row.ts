// Shared shape for the `machine` admin operations. See docs/plans/
// SCHEMA.md §15, §17.7, §23.2.
//
// `sourceGlobs` needs the same NULL-preserving read `../../settings/
// overrides.ts` (`readMachineSourceGlobs`) already established for the
// dispatch-facing reader: NULL means "this machine does not override
// `minting.source_globs`", `{}` means "this machine overrides, and scans
// nothing" — and Prisma's generated client cannot tell the two apart
// (coalesces both to `[]`), so the raw `overridden` flag has to travel with
// the row rather than be inferred from the array's length.

export interface MachineRecord {
  readonly name: string;
  readonly lastPollAt: string | null;
  readonly liveSessions: number;
  /** Null = no override (inherits `minting.source_globs`). An array, including `[]`, = an override. */
  readonly sourceGlobs: readonly string[] | null;
}

/** The raw shape `$queryRawUnsafe` returns for one `"Machine"` row, with the NULL-vs-override flag. */
export interface RawMachineRow {
  name: string;
  lastPollAt: Date | string | null;
  liveSessions: number;
  sourceGlobs: string[] | null;
  overridden: boolean;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toMachineRecord(row: RawMachineRow): MachineRecord {
  return {
    name: row.name,
    lastPollAt: isoOrNull(row.lastPollAt),
    liveSessions: row.liveSessions,
    sourceGlobs: row.overridden ? (row.sourceGlobs ?? []) : null,
  };
}

/** Selects every `"Machine"` column plus the NULL-preserving override flag. */
export const MACHINE_SELECT = `"name", "lastPollAt", "liveSessions", "source_globs" AS "sourceGlobs", ("source_globs" IS NOT NULL) AS "overridden"`;
