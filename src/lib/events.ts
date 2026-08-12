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

/** The event types this module knows how to append. Mirrors `EventType` in schema.prisma. */
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
  | "setting_change";

export type ActorType = "person" | "agent" | "system";

/** Who is credited with an event — the same shape `Caller` carries through the service layer. */
export interface EventActor {
  readonly actorType: ActorType;
  /** Required unless `actorType` is `system` — null for `system`. */
  readonly actorId?: string | null;
  readonly sessionId?: string | null;
}

export interface AppendEventInput {
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
 * Appends one row to `events`.
 *
 * `ts` and `txId` are both left to Postgres's own column defaults
 * (`CURRENT_TIMESTAMP` and `txid_current()`) rather than computed here and
 * passed in — the row is timestamped and tagged with its writing
 * transaction at the instant Postgres actually executes the `INSERT`,
 * inside whatever transaction the caller's `db` handle is bound to. There
 * is no window in which this function could compute a value outside that
 * transaction and hand it to a query running inside it.
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
  const rows = await db.$queryRawUnsafe<{ id: bigint; txId: bigint; ts: Date }[]>(
    `INSERT INTO "Event" ("itemId", "actorType", "actorId", "sessionId", "assignmentId", "type", "payload", "body")
     VALUES ($1, $2::"ActorType", $3, $4, $5, $6::"EventType", $7::jsonb, $8)
     RETURNING "id", "txId", "ts"`,
    input.itemId ?? null,
    input.actor.actorType,
    input.actor.actorId ?? null,
    input.actor.sessionId ?? null,
    input.assignmentId ?? null,
    input.type,
    JSON.stringify(input.payload),
    input.body ?? null,
  );
  const row = rows[0];
  if (!row) {
    // Unreachable in practice — `INSERT ... RETURNING` always returns the
    // row it just inserted, or the statement itself throws. Guarded rather
    // than asserted with `!`, so a driver that ever changed this contract
    // fails loudly here instead of on the first `.id` access downstream.
    throw new Error("appendEvent: INSERT ... RETURNING produced no row.");
  }
  return { id: row.id, txId: row.txId, ts: row.ts };
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
