// The events ledger (SCHEMA.md §3) — append-only, one row per thing that
// happened. This module is the only place an `Event` row is written, so
// "every mutation appends a row" is a property of what operations call, not
// a convention they each have to remember.
//
// Every function here takes a `TransactionHandle`, never a `PrismaClient` —
// the same narrowing `ServiceContext.db` already enforces (context.ts). An
// operation appends inside the transaction its own body is already running
// in; there is no second boundary here to accidentally open. See
// `docs/plans/SCHEMA.md` §3 and `src/lib/service/context.ts`.
import type { TransactionHandle } from "./service/context";
import { insertEventRow, type EventFields } from "./events-insert";

export type { ActorType, AppendedEvent, EventActor, EventType } from "./events-insert";
import type { ActorType, AppendedEvent, EventActor, EventType } from "./events-insert";

/**
 * What a normal caller may say about an event. Structurally identical to
 * `EventFields` — and **deliberately has no `ts`**. That absence is the
 * primary boundary, not a comment about one: a caller writing
 * `appendEvent(db, { …, ts })` does not compile, because an object literal
 * with an unknown property fails assignment to this type.
 *
 * The run-time refusal in `appendEvent` covers the remaining hole, which is
 * real: a value that is not an object literal (built up dynamically, spread
 * from an untyped source, or cast) can carry a `ts` past the type system
 * without a diagnostic, and an import script written in a hurry is exactly
 * the caller that would do it.
 */
export type AppendEventInput = EventFields;

/**
 * Appends one row to `events`, timestamped `now()`.
 *
 * `ts` and `txId` are both left to Postgres's own column defaults rather
 * than computed here and passed in — the row is timestamped and tagged with
 * its writing transaction at the instant Postgres actually executes the
 * `INSERT`, inside whatever transaction the caller's `db` handle is bound
 * to. There is no window in which this function could compute a value
 * outside that transaction and hand it to a query running inside it.
 *
 * **`ts` is not overridable here, and that is a security property rather
 * than an omission.** Every "what has happened since I last looked" read in
 * this system slices the ledger by time and by id, so a row that claims to
 * have happened earlier than it did is a row a reader has already scrolled
 * past — writable history is unnoticeable history. There IS a path that sets
 * a timestamp, because a one-time import from an external file-based store
 * has to preserve the chronology it arrives with, and an import that stamped
 * `now()` on every row would flatten years of sequence into one instant. It
 * is a separate function in a separate module that the rest of `src/` cannot
 * import (`events-backfill.ts`, and eslint.config.mjs's zone for it).
 *
 * Because this takes a `TransactionHandle` — the same handle
 * `ServiceContext.db` narrows a Prisma transaction down to (see
 * `service/context.ts`) — a call from inside an operation's handler is
 * necessarily still inside the one transaction the service runtime opened
 * for that call. There is no second `$transaction` to reach here: the type
 * has no such method.
 */
export async function appendEvent(
  db: TransactionHandle,
  input: AppendEventInput,
): Promise<AppendedEvent> {
  if (Object.prototype.hasOwnProperty.call(input, "ts")) {
    throw new Error(
      "appendEvent: `ts` cannot be set on the normal append path — events are timestamped by " +
        "Postgres at the moment they are written. Backfilling historical events is a separate, " +
        "deliberately narrow path (appendBackfillEvent).",
    );
  }
  return insertEventRow(db, input, null);
}

/**
 * Compares `before` and `after` on `fields` and appends one `field_change`
 * row per field that actually changed — SCHEMA.md §3's `{field, from, to}`
 * payload. A field present in `fields` but equal in both snapshots is
 * skipped entirely: this is what keeps an edit that touches ten columns and
 * changes three from writing ten rows, and what stops a no-op save
 * (`update` called with the same values) from writing anything at all.
 *
 * Comparison is by `JSON.stringify` equality, not `===` — the fields this
 * runs over include plain values (`priority`, `area`) but nothing here
 * assumes primitives only, and a shallow reference comparison would treat
 * two structurally identical objects as "changed" on every call.
 *
 * Returns the rows actually written, so a caller that wants to know whether
 * anything changed (e.g. to skip bumping `updatedAt`) doesn't have to
 * recompute the diff itself.
 */
export async function recordFieldChanges(
  db: TransactionHandle,
  args: {
    readonly itemId: string;
    readonly actor: EventActor;
    readonly assignmentId?: string | null;
    readonly before: Readonly<Record<string, unknown>>;
    readonly after: Readonly<Record<string, unknown>>;
    readonly fields: readonly string[];
  },
): Promise<AppendedEvent[]> {
  const changed = args.fields.filter(
    (field) => JSON.stringify(args.before[field]) !== JSON.stringify(args.after[field]),
  );

  const appended: AppendedEvent[] = [];
  for (const field of changed) {
    appended.push(
      await appendEvent(db, {
        itemId: args.itemId,
        actor: args.actor,
        assignmentId: args.assignmentId,
        type: "field_change",
        payload: { field, from: args.before[field] ?? null, to: args.after[field] ?? null },
      }),
    );
  }
  return appended;
}

/**
 * The oldest transaction id that could still be concurrent with any
 * transaction still open at the moment this runs — the **visibility
 * horizon** SCHEMA.md §3 describes. Any `events` row whose `txId` is
 * strictly below this value was
 * written by a transaction that has definitely finished (committed or
 * rolled back), so a reader bounding itself to `txId < horizon` can never
 * observe a row from a transaction still in progress, and — the property
 * that actually matters — can never *permanently* skip a row the way
 * `id > since` alone can (§3: `id` is allocated before commit, so a late
 * commit can land a lower `id` after a reader already advanced past it).
 *
 * Backed by `pg_snapshot_xmin(pg_current_snapshot())`: `xmin` of the
 * current transaction's snapshot is exactly "the oldest txid not yet known
 * to be complete as of now" — Postgres's own definition of the horizon, not
 * a reimplementation of it. Cast `::text::bigint` — Postgres returns
 * `xmin`/`pg_snapshot_xmin` as `xid8`, a type Prisma's raw-query
 * deserializer does not know how to decode on its own (it throws
 * `P2010` / "Failed to deserialize column of type 'xid8'" without the
 * cast); `txId` is stored as `BigInt` for the same reason (schema.prisma).
 */
export async function visibilityHorizon(db: TransactionHandle): Promise<bigint> {
  const rows = await db.$queryRawUnsafe<{ horizon: bigint }[]>(
    `SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS "horizon"`,
  );
  const horizon = rows[0]?.horizon;
  if (horizon === undefined) {
    throw new Error("visibilityHorizon: pg_snapshot_xmin query produced no row.");
  }
  return horizon;
}

export interface EventRow {
  readonly id: bigint;
  readonly txId: bigint;
  readonly itemId: string | null;
  readonly ts: Date;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly assignmentId: string | null;
  readonly type: EventType;
  readonly payload: Record<string, unknown>;
  readonly body: string | null;
}

/**
 * Reads events with `id > since`, bounded to the visibility horizon and
 * ordered by `id` — the read SCHEMA.md §3 says is the one that "never skips
 * a row": everything returned was written by a transaction that has
 * already finished, so nothing still-in-flight with a lower `id` can commit
 * later and be missed by a subsequent call with a higher `since`.
 *
 * The cost, stated in the same paragraph, is real: a row is held back from
 * this read until the oldest transaction concurrent with it finishes. A
 * long-running transaction elsewhere holds every row written after it
 * started, which is exactly why `horizon` is returned alongside the rows —
 * a caller (or a monitor) can watch how far behind `horizon` sits relative
 * to `now()` and tell a healthy short delay apart from a stuck one.
 */
export async function readSinceBounded(
  db: TransactionHandle,
  args: { readonly since: bigint; readonly limit?: number },
): Promise<{ events: EventRow[]; horizon: bigint }> {
  const horizon = await visibilityHorizon(db);
  const limit = args.limit ?? 500;
  const rows = await db.$queryRawUnsafe<
    {
      id: bigint;
      txId: bigint;
      itemId: string | null;
      ts: Date;
      actorType: ActorType;
      actorId: string | null;
      sessionId: string | null;
      assignmentId: string | null;
      type: EventType;
      payload: Record<string, unknown>;
      body: string | null;
    }[]
  >(
    `SELECT "id", "txId", "itemId", "ts", "actorType", "actorId", "sessionId", "assignmentId", "type", "payload", "body"
     FROM "Event"
     WHERE "id" > $1 AND "txId" < $2
     ORDER BY "id" ASC
     LIMIT $3`,
    args.since,
    horizon,
    limit,
  );
  return { events: rows, horizon };
}
