// The one `INSERT INTO "Event"` statement in the system — SCHEMA.md §3.
//
// Split out of `events.ts` so that exactly two callers can exist and they
// differ in one respect only: whether a timestamp is supplied.
//
//   - `events.ts` `appendEvent` — the normal path. Passes `null`, always,
//     with no way for its own caller to influence that.
//   - `events-backfill.ts` `appendBackfillEvent` — the import path. Requires
//     a timestamp; that is its entire reason to exist.
//
// **Not a general-purpose export.** An unrestricted "append an event at a
// time of your choosing" is a way to forge history: the ledger is what every
// "what changed since I last looked" read slices on, and a row that claims to
// have happened before it did is invisible to a reader who already advanced
// past that point. The boundary is enforced three ways, none of them a
// comment: this module and `events-backfill.ts` are unimportable from the
// rest of `src/` (eslint.config.mjs's `import/no-restricted-paths` zone),
// `AppendEventInput` has no `ts` field to set, and `appendEvent` refuses at
// run time an input that carries one anyway.
import type { TransactionHandle } from "./service/context";

export type ActorType = "person" | "agent" | "system";

/** The event types this system knows how to append. Mirrors `EventType` in schema.prisma. */
export type EventType =
  | "field_change"
  | "state_change"
  | "claim"
  | "release"
  | "takeover"
  | "review_requested"
  | "review"
  | "merge"
  | "dispatch"
  | "dispatch_claimed"
  | "checkpoint"
  | "nudge"
  | "escalation"
  | "note"
  | "setting_change"
  | "open_loop"
  | "open_loop_closed";

/** Who is credited with an event — the same shape `Caller` carries through the service layer. */
export interface EventActor {
  readonly actorType: ActorType;
  /** Required unless `actorType` is `system` — null for `system`. */
  readonly actorId?: string | null;
  readonly sessionId?: string | null;
}

export interface EventFields {
  /** Null for a system-level event not scoped to one item. */
  readonly itemId?: string | null;
  readonly actor: EventActor;
  readonly assignmentId?: string | null;
  readonly type: EventType;
  /** Type-specific payload — a discriminated union keyed on `type`, per SCHEMA.md §3. */
  readonly payload: Record<string, unknown>;
  /** Prose for checkpoint/note/nudge/escalation. Never validated or indexed. */
  readonly body?: string | null;
}

export interface AppendedEvent {
  readonly id: bigint;
  readonly txId: bigint;
  readonly ts: Date;
}

/**
 * Inserts one `events` row, timestamping it either with Postgres's own
 * `now()` (when `ts` is `null`) or with the supplied instant.
 *
 * The two cases are one SQL statement with a coalesce rather than two
 * statements, so the column list, the casts and the `RETURNING` clause cannot
 * drift between the live path and the import path — the import is a one-shot
 * migration of thousands of rows, and "the backfill wrote a subtly different
 * row shape" is a class of bug that only surfaces long after the source is
 * gone.
 *
 * `txId` is always left to the column default (`txid_current()`): it records
 * which transaction wrote the row, which is a fact about this process right
 * now, not about the moment being described. Backfilling it would be a lie
 * with no upside — the visibility horizon reads it, and a fabricated value
 * would corrupt the one bound that makes `readSinceBounded` never skip a row.
 */
export async function insertEventRow(
  db: TransactionHandle,
  input: EventFields,
  ts: Date | null,
): Promise<AppendedEvent> {
  const rows = await db.$queryRawUnsafe<{ id: bigint; txId: bigint; ts: Date }[]>(
    `INSERT INTO "Event" ("itemId", "actorType", "actorId", "sessionId", "assignmentId", "type", "payload", "body", "ts")
     VALUES ($1, $2::"ActorType", $3, $4, $5, $6::"EventType", $7::jsonb, $8, COALESCE($9::timestamptz, CURRENT_TIMESTAMP))
     RETURNING "id", "txId", "ts"`,
    input.itemId ?? null,
    input.actor.actorType,
    input.actor.actorId ?? null,
    input.actor.sessionId ?? null,
    input.assignmentId ?? null,
    input.type,
    JSON.stringify(input.payload),
    input.body ?? null,
    ts === null ? null : ts.toISOString(),
  );
  const row = rows[0];
  if (!row) {
    // Unreachable in practice — `INSERT ... RETURNING` always returns the
    // row it just inserted, or the statement itself throws. Guarded rather
    // than asserted with `!`, so a driver that ever changed this contract
    // fails loudly here instead of on the first `.id` access downstream.
    throw new Error("insertEventRow: INSERT ... RETURNING produced no row.");
  }
  return { id: row.id, txId: row.txId, ts: row.ts };
}
