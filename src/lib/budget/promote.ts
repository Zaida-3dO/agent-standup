// Promoting a usage snapshot onto the account it belongs to.
// MILESTONES.md #56; SCHEMA.md §15.
//
// Two things report usage and they are the two halves of the row title —
// "from the hook, and from polling". The hook carries a snapshot on every
// tool call it flushes (`ToolCall.usage5h`, kept per call so the history is
// not lost); the poll carries one per machine. Both end up here, because
// where the number goes and what makes it trustworthy are the same question
// whichever door it arrived through, and two writers with two rules would
// disagree about the ordering rule below within a week.
//
// **Usage belongs to the account, not the machine** (§15: "Machines are
// compute; limits are billing"). A reporter names a machine, so this module
// resolves machine to account through `machine_accounts` — the join table
// that exists for exactly this. A machine mapped to no account is not an
// error: an installation that has not wired one up yet still reports tool
// calls, and refusing the flush would lose the telemetry over a
// configuration gap. It writes nothing and says so.
//
// **The write never moves a reading backwards in time.** Two machines drive
// one account in the ordinary case (§15), their polls interleave, and
// nothing orders the arrival of two HTTP requests. Without the guard the
// stored reading would be whichever request happened to land last rather
// than whichever snapshot was taken last, so a slow reporter with an old
// snapshot could overwrite a fresh one and the column would flap between
// two values with no way to tell which was current. The `WHERE` clause
// makes it last-*taken*-wins rather than last-*written*-wins, decided in
// the database so two concurrent statements cannot both read-then-write.
import type { TransactionHandle } from "../service/context";

/** A snapshot as a reporter supplies it. Both figures are optional. */
export interface UsageSnapshot {
  /** Percent of the 5-hour window consumed. */
  readonly usage5h?: number | null;
  /** Percent of the weekly window consumed. */
  readonly usageWeekly?: number | null;
  /** When the reporter took it. */
  readonly takenAt: Date;
}

/** What a promotion did, so a caller can say so rather than guess. */
export type PromotionOutcome =
  | { readonly status: "written"; readonly accountIds: readonly string[] }
  /** The snapshot carried neither figure, so there was nothing to store. */
  | { readonly status: "empty" }
  /** The machine maps to no account. Not an error — see the header. */
  | { readonly status: "no-account" }
  /**
   * Every candidate account already holds a reading taken at or after this
   * one. The write was correctly declined rather than silently lost.
   */
  | { readonly status: "superseded" };

/**
 * Writes a snapshot to every account the named machine can dispatch against.
 *
 * **Every account, not one.** `machine_accounts` is many-to-many and §15
 * says a machine may be wired to more than one; there is nothing in a hook
 * flush that says which of them served a given call, and picking one
 * arbitrarily would attribute usage to an account that did not incur it.
 * Writing the snapshot the machine reported to each account the machine is
 * mapped to is the honest reading of what the reporter actually knows. In
 * the overwhelmingly common single-account case the two are the same thing.
 */
export async function promoteUsage(
  db: TransactionHandle,
  machine: string,
  snapshot: UsageSnapshot,
): Promise<PromotionOutcome> {
  const has5h = snapshot.usage5h !== undefined && snapshot.usage5h !== null;
  const hasWeekly = snapshot.usageWeekly !== undefined && snapshot.usageWeekly !== null;
  // A flush from a session whose agent tool reports no usage at all is the
  // ordinary case, not a fault: `usage_at` would otherwise advance while
  // both figures stayed null, which is a timestamp claiming a measurement
  // that never happened.
  if (!has5h && !hasWeekly) return { status: "empty" };

  const rows = await db.$queryRawUnsafe<{ accountId: string }[]>(
    `SELECT "accountId" FROM "MachineAccount" WHERE "machineName" = $1 ORDER BY "accountId" ASC`,
    machine,
  );
  if (rows.length === 0) return { status: "no-account" };

  const written: string[] = [];
  for (const row of rows) {
    // COALESCE on each figure so a reporter that knows only one of them
    // updates that one and leaves the other as it was, rather than
    // blanking a figure it never claimed to measure.
    //
    // The WHERE is the ordering rule: write only when this snapshot is
    // newer than what is stored, or when nothing is stored at all.
    const updated = await db.$executeRawUnsafe(
      `UPDATE "Account"
          SET "usage5h" = COALESCE($2, "usage5h"),
              "usageWeekly" = COALESCE($3, "usageWeekly"),
              "usageAt" = $4
        WHERE "id" = $1
          AND ("usageAt" IS NULL OR "usageAt" < $4)`,
      row.accountId,
      has5h ? snapshot.usage5h : null,
      hasWeekly ? snapshot.usageWeekly : null,
      snapshot.takenAt,
    );
    if (updated > 0) written.push(row.accountId);
  }

  // Distinguished from `written` with an empty list, because "the machine
  // has accounts and every one of them already knew something newer" and
  // "the write landed" are different answers to the caller.
  if (written.length === 0) return { status: "superseded" };
  return { status: "written", accountIds: written };
}
