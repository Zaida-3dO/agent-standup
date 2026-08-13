// The one path that may write an `events` row with a timestamp of its own —
// SCHEMA.md §3.
//
// It exists for exactly one job: a one-time import from an external
// file-based store into an empty ledger. Such a store arrives with its own
// chronology, and that chronology is the entire value of importing it — "what changed since I last
// looked", the review-round history, and every "how long did this take"
// question read the ledger by time. An import that let `now()` stamp every
// row would collapse the whole history into the instant the import ran, and
// the source it came from is not going to be there to do it again.
//
// **Why this is not just an optional argument on `appendEvent`.** A
// general-purpose timestamp override is a way to forge history: because every
// "since I last looked" read advances a cursor, a row inserted with a
// timestamp earlier than the cursor is a row the reader has already scrolled
// past, and it is therefore never shown to anyone. That is not a hypothetical misuse — it
// is what the feature does, used casually. So the capability is a separate
// function, in a separate module, that the rest of `src/` is not permitted to
// import (eslint.config.mjs's `import/no-restricted-paths` zone). The normal
// path additionally has no `ts` in its input type and refuses one at run time
// if it arrives anyway (`events.ts`).
import type { TransactionHandle } from "./service/context";
import { insertEventRow, type AppendedEvent, type EventFields } from "./events-insert";

export interface BackfillEventInput extends EventFields {
  /**
   * When this event actually happened, in the source being imported.
   * **Required** — an optional timestamp here would make the backfill path
   * silently degrade into the normal one on the rows where a caller forgot,
   * which is the failure this whole split exists to make impossible. A
   * backfill with no timestamp is not a backfill.
   */
  readonly ts: Date;
}

export class InvalidBackfillTimestampError extends Error {
  constructor(reason: string) {
    super(`appendBackfillEvent: ${reason}`);
    this.name = "InvalidBackfillTimestampError";
  }
}

/**
 * Appends one historical `events` row, stamped with the instant it happened
 * in the source rather than the instant of the import.
 *
 * Rejects an unusable timestamp rather than passing it through: an `Invalid
 * Date` (what `new Date("")` and `new Date(undefined as never)` produce)
 * would otherwise reach Postgres as the string `"Invalid Date"` and fail
 * there with an error naming a column rather than the row that caused it —
 * across thousands of rows, at the one moment the source data is still
 * available to check, that difference is the difference between fixing the
 * mapping and re-running the whole import blind.
 *
 * `txId` is still Postgres's own `txid_current()`, deliberately: it records
 * which transaction wrote the row, which is a true fact about the import
 * process, and it is what `readSinceBounded`'s visibility horizon relies on.
 * A backfilled `txId` would break the one guarantee that read makes.
 */
export async function appendBackfillEvent(
  db: TransactionHandle,
  input: BackfillEventInput,
): Promise<AppendedEvent> {
  if (!(input.ts instanceof Date) || Number.isNaN(input.ts.getTime())) {
    throw new InvalidBackfillTimestampError(
      `ts must be a valid Date, received ${JSON.stringify(String(input.ts))}`,
    );
  }
  return insertEventRow(db, input, input.ts);
}
