// `orientation` — SCHEMA.md §19 `GET /items/{id}/orientation`, MILESTONES.md
// #28. "Catch me up": the latest checkpoint, the item's current state, what
// changed since that checkpoint, open loops, and who is on the crew.
//
// This is a **read**, and a bounded one. It reads `events` (row #20 —
// `readSinceBounded`/`visibilityHorizon`) and `assignments` (row #23 —
// `liveAssignments`) but writes nothing: the checkpoint and note *write*
// path is row #29's territory, not this one's (MILESTONES.md #28's own
// text: "#28 delivers orientation, which only *reads* checkpoints").
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { ITEM_COLUMNS, toItemRecord, type ItemRecord, type RawItemRow } from "../items/row";
import { readSinceBounded, type EventRow } from "../../events";
import { liveAssignments, type Assignment } from "../../claims";

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    /**
     * Bound "what changed" to events with `id > since`. Omitted means
     * "since the latest checkpoint" (or the beginning of the ledger for
     * this item if there is no checkpoint yet) — the resume case a fresh
     * session actually has: it does not know a cursor of its own, only
     * that it wants everything since whatever was last recorded.
     */
    since: z.string().regex(/^\d+$/, "since must be a decimal integer string").optional(),
  })
  .strict();

export type OrientationInput = z.infer<typeof inputSchema>;

export interface OrientationCheckpoint {
  readonly eventId: string;
  readonly ts: string;
  readonly assignmentId: string | null;
  readonly body: string | null;
}

/** One entry from `Summary.notDone` (SCHEMA.md §5a), as stored — never re-validated here. */
export interface OpenLoopNotDone {
  readonly text: string;
  readonly reason: string;
  readonly itemId?: string;
}

/** A child of this item that still needs attention — actionable, or waiting (SCHEMA.md §5a, guard hierarchy.ts). */
export interface OpenLoopChild {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  /** `true` for the states `hierarchy.no_finish_with_actionable_child` treats as "more to do". */
  readonly actionable: boolean;
}

/**
 * One `events` row as `whatChanged` returns it — `EventRow` (events.ts) with
 * `id`/`txId` stringified. `bigint` cannot cross a JSON boundary at all
 * (`JSON.stringify`/`NextResponse.json` throw on one outright, rather than
 * silently truncating it), so every bigint column this operation returns is
 * stringified before it leaves the handler — the same choice `checkpoint`,
 * `changedSince` and `horizon` already make below.
 */
export interface OrientationChangedEvent {
  readonly id: string;
  readonly txId: string;
  readonly itemId: string | null;
  readonly ts: string;
  readonly actorType: EventRow["actorType"];
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly assignmentId: string | null;
  readonly type: EventRow["type"];
  readonly payload: Record<string, unknown>;
  readonly body: string | null;
}

export interface OrientationOutput {
  readonly item: ItemRecord;
  /** Null if this item has never had a checkpoint recorded against it. */
  readonly checkpoint: OrientationCheckpoint | null;
  /**
   * Events with `id > since`, bounded to the visibility horizon
   * (`readSinceBounded` — SCHEMA.md §3), for this item. Empty when nothing
   * changed — the "nothing happened" case is a real, distinct answer from
   * "I don't know", not an error.
   */
  readonly whatChanged: readonly OrientationChangedEvent[];
  /** The cursor `whatChanged` was read from — hand back as `since` on the next orientation call. */
  readonly changedSince: string;
  /** The horizon `whatChanged` was bounded to (SCHEMA.md §3) — how far "what changed" can be trusted. */
  readonly horizon: string;
  readonly openLoops: {
    readonly notDone: readonly OpenLoopNotDone[];
    readonly children: readonly OpenLoopChild[];
  };
  /** Live assignments on this item — who is on it and in what role (SCHEMA.md §2). */
  readonly crew: readonly Assignment[];
}

interface RawCheckpointRow {
  id: bigint;
  ts: Date;
  assignmentId: string | null;
  body: string | null;
}

interface RawSummaryRow {
  notDone: unknown;
}

interface RawChildRow {
  id: string;
  title: string;
  state: string;
}

/**
 * The states `hierarchy.no_finish_with_actionable_child` (guards/hierarchy.ts)
 * treats as "more to do" — re-declared here for the same reason that guard
 * re-declares it rather than importing `NON_ACTIONABLE_STATES`: this
 * question ("does orientation still owe attention to this child") is a
 * different cut of the vocabulary than the guard's own, and the two
 * happening to want the same set is a fact about the vocabulary, not a
 * coupling either module should carry.
 */
const NON_ACTIONABLE_STATES: ReadonlySet<string> = new Set([
  "blocked",
  "paused",
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

export const orientation = defineOperation({
  name: "orientation",
  kind: "read",
  summary:
    "Catch me up: latest checkpoint, current state, what changed since, open loops, and crew.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: OrientationInput): Promise<OrientationOutput> {
    const itemRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    const itemRow = itemRows[0];
    if (!itemRow) {
      throw new NotFoundError(`No such item: ${input.itemId}.`, { fields: ["itemId"] });
    }
    const item = toItemRecord(itemRow);

    // The latest checkpoint (an `events` row of type `checkpoint` —
    // SCHEMA.md §4: "No checkpoints table... latest is `WHERE
    // type='checkpoint' AND assignment_id=A ORDER BY ts DESC LIMIT 1`").
    // Orientation is item-scoped rather than assignment-scoped, so this
    // reads the newest checkpoint against *this item* across every
    // assignment that has held it — the resume point any fresh session on
    // this item wants, not just one prior holder's.
    const checkpointRows = await ctx.db.$queryRawUnsafe<RawCheckpointRow[]>(
      `SELECT "id", "ts", "assignmentId", "body" FROM "Event"
       WHERE "itemId" = $1 AND "type" = 'checkpoint'::"EventType"
       ORDER BY "id" DESC LIMIT 1`,
      input.itemId,
    );
    const checkpointRow = checkpointRows[0];
    const checkpoint: OrientationCheckpoint | null = checkpointRow
      ? {
          eventId: checkpointRow.id.toString(),
          ts: checkpointRow.ts.toISOString(),
          assignmentId: checkpointRow.assignmentId,
          body: checkpointRow.body,
        }
      : null;

    // "What changed" defaults to since the latest checkpoint (or the
    // beginning, 0, if there has never been one) — a fresh session's actual
    // question is "what happened since the last thing I know about", and a
    // checkpoint is the one thing recorded specifically to answer it.
    const since = input.since !== undefined ? BigInt(input.since) : (checkpointRow?.id ?? 0n);
    const { events: allEvents, horizon } = await readSinceBounded(ctx.db, { since });
    // `readSinceBounded` reads the ledger table-wide (it has no `itemId`
    // filter of its own — SCHEMA.md §3's cross-item "since your last visit"
    // view and this item-scoped one are "the same rows, sliced
    // differently"). Slice to this item here, and stringify every bigint
    // column on the way out — `id`/`txId` cannot survive a JSON boundary as
    // `bigint` (`JSON.stringify` throws on one outright), which is exactly
    // what the HTTP route (`NextResponse.json`) would hit on the first
    // call if this operation returned `EventRow`s unmapped.
    const whatChanged: OrientationChangedEvent[] = allEvents
      .filter((event) => event.itemId === input.itemId)
      .map((event) => ({
        id: event.id.toString(),
        txId: event.txId.toString(),
        itemId: event.itemId,
        ts: event.ts.toISOString(),
        actorType: event.actorType,
        actorId: event.actorId,
        sessionId: event.sessionId,
        assignmentId: event.assignmentId,
        type: event.type,
        payload: event.payload,
        body: event.body,
      }));

    // Open loops, part one: this item's own recorded deferrals (SCHEMA.md
    // §5a `not_done`), if it has ever been completed with a Summary. Most
    // in-progress items have none yet — that's an empty list, not an error.
    const summaryRows = await ctx.db.$queryRawUnsafe<RawSummaryRow[]>(
      `SELECT "notDone" FROM "Summary" WHERE "itemId" = $1`,
      input.itemId,
    );
    const notDone = (summaryRows[0]?.notDone as OpenLoopNotDone[] | undefined) ?? [];

    // Open loops, part two: direct children that still need attention — the
    // same query and the same actionable/non-actionable split
    // `hierarchy.no_finish_with_actionable_child` enforces (guards/hierarchy.ts),
    // read here rather than imported because a guard module exports guard
    // objects, not a reusable query.
    const childRows = await ctx.db.$queryRawUnsafe<RawChildRow[]>(
      `SELECT "id", "title", "state" FROM "Item" WHERE "parentId" = $1 ORDER BY "createdAt" ASC`,
      input.itemId,
    );
    const children: OpenLoopChild[] = childRows.map((child) => ({
      id: child.id,
      title: child.title,
      state: child.state,
      actionable: !NON_ACTIONABLE_STATES.has(child.state),
    }));

    const crew = await liveAssignments(ctx.db, input.itemId);

    return {
      item,
      checkpoint,
      whatChanged,
      changedSince: since.toString(),
      horizon: horizon.toString(),
      openLoops: { notDone, children },
      crew,
    };
  },
});
