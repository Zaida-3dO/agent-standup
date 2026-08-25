// `get_activity` — the fleet-wide timeline. T19: "Every event, filterable by
// type, actor, item and area, with seen-state."
//
// Where `get_item_history` answers "what happened to this item" and
// `get_events` answers "what is new since I last looked", this answers "what
// happened across the fleet" — the diagnostic for a bad night, read by
// scrolling backwards through a filtered ledger.
//
// ── Why this is not `get_events` with more filters ──────────────────────
//
// It reads the same table, and adding four optional filters to `get_events`
// was the obvious move. It is not what this does, and the reason is that the
// two reads page in *opposite directions* over an append-only ledger.
//
// `get_events` is "since your last visit": an **exclusive lower bound**
// (`id > since`) that walks *forward*, bounded by the visibility horizon so
// it can never skip a row that commits late. That property is the whole
// point of it — a watermark that skipped a row would silently lose an event
// from someone's inbox forever — and it is what `readSinceBounded` exists to
// guarantee.
//
// A timeline scrolls the other way. It opens on the newest events and walks
// *backwards* into history, so its cursor is an upper bound (`id < cursor`)
// and it is ordered newest-first. Forcing both onto one operation would mean
// a `direction` flag changing the meaning of `since`, the sort order, and
// whether the horizon bound applies — three behaviours behind one parameter,
// where a caller passing the wrong combination gets a silently wrong page
// rather than a refusal.
//
// So this is the `get_item_history` shape (T24/#265), widened from one item
// to the fleet: keyset on `Event.id DESC`, one row fetched beyond the page
// so "there is more" is a fact rather than an inference, slim by default.
// **The seen-state and its writes are untouched** — `POST /events/{id}/seen`
// and `get_events` still own that, and this read reports the same state.
//
// ── Why the horizon bound is not carried over, and why that is safe ─────
//
// `readSinceBounded` withholds rows above the visibility horizon because a
// *forward* reader advances a watermark past them and would never come back.
// A backward reader has the opposite exposure: it walks down from a fixed
// cursor, so a row committing late lands **above** everything it will ever
// read, and cannot be skipped by any later page. The worst case is that the
// newest events take a moment to appear on a freshly-opened timeline, which
// a refresh fixes — as against the forward reader's permanent loss.
//
// ── Filtering by area is a join, because events do not carry one ────────
//
// `Event` has `itemId` but no `area`; the area lives on `Item`. So an area
// filter joins, and that join necessarily drops events with no item —
// `setting_change` is the obvious one. That is the correct reading of "show
// me this area": an event belonging to no item belongs to no area either, so
// including it would be answering a different question. Every other filter
// leaves item-less events reachable.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import type { EventRow } from "@/lib/events";

/**
 * The page bound — the same 200 ceiling every other paged read in the
 * product uses, so a caller learns one bound rather than one per operation.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * How many distinct values one filter may name at once.
 *
 * The filters are `= ANY($n)` over caller-supplied arrays, so an unbounded
 * array is an unbounded query parameter — a caller could paste ten thousand
 * item ids and turn a keyset read into something quite different. Small
 * because these are UI filters: a type picker has fewer than twenty options
 * in total, and a reader narrowing to fifty actors is not narrowing.
 */
const MAX_FILTER_VALUES = 50;

const inputSchema = z
  .object({
    /**
     * Only events of these types. Absent means every type.
     *
     * Deliberately **not** a `z.enum` of `EventType`. The enum grows (four
     * open-loop types arrived after the ledger shipped), and a hard-coded
     * copy here would refuse a type the database happily stores the day it
     * is added — a filter that silently returns nothing for a real, current
     * event kind. The value reaches Postgres as a text array cast to the
     * enum, so an unknown name is refused by the cast rather than by a
     * stale list.
     */
    type: z.array(z.string().min(1)).min(1).max(MAX_FILTER_VALUES).optional(),
    /** Only events written by these kinds of actor. */
    actorType: z
      .array(z.enum(["person", "agent", "system"]))
      .min(1)
      .max(MAX_FILTER_VALUES)
      .optional(),
    /** Only events written by these specific actors — a person id or an agent id. */
    actorId: z.array(z.string().min(1)).min(1).max(MAX_FILTER_VALUES).optional(),
    /** Only events scoped to these items. */
    itemId: z.array(z.string().min(1)).min(1).max(MAX_FILTER_VALUES).optional(),
    /**
     * Only events whose item is in these areas. Joins `Item`, so events with
     * no item are excluded whenever this is set — see the module header.
     */
    area: z.array(z.string().min(1)).min(1).max(MAX_FILTER_VALUES).optional(),
    /** Only events from these sessions — the filter session detail reads through. */
    sessionId: z.array(z.string().min(1)).min(1).max(MAX_FILTER_VALUES).optional(),
    /**
     * Whose read state to report, and what `unseenOnly` filters against.
     * Optional for the same reason `get_events` makes it optional: with no
     * profile named the ledger is still readable and everything comes back
     * `seen: false`, which is the honest answer rather than a stranger's.
     */
    personId: z.string().min(1).optional(),
    /**
     * Drop what this profile has already seen.
     *
     * Unlike `get_events`, this **is** applied in the `WHERE` rather than
     * after the slice, and it is safe here for the same reason the horizon
     * bound could be dropped: a backward reader's cursor is the id of the
     * last row it *returned*, so filtering before the cut cannot strand a
     * row above the cursor the way it would for a forward watermark. Doing
     * it after the cut instead would make a page of "unseen only" shorter
     * than `limit` for a reason the caller cannot see, and `hasMore` would
     * then describe the unfiltered ledger rather than what they asked for.
     */
    unseenOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    /**
     * The `id` of the last event on the previous page. Keyset, not offset —
     * `OFFSET` over a table taking inserts silently repeats and drops rows.
     *
     * Digits are enforced here rather than left to the `::bigint` cast, so a
     * malformed cursor is `invalid_input` naming the field rather than an
     * internal error that reports a caller's typo as a server fault.
     */
    cursor: z
      .string()
      .regex(/^\d+$/, "cursor must be an event id — a whole number, as returned in nextCursor")
      .optional(),
    /**
     * Return each event's `payload` and `body`. Off by default: those two
     * columns measured ~95% of a realistic event, and a default page of 50
     * carrying them was large enough to be refused by the response-size
     * guard (see `get-events.ts`).
     */
    full: z.boolean().default(false),
  })
  .strict();

export type GetActivityInput = z.infer<typeof inputSchema>;

/** One event on the timeline — the slim default. */
export interface ActivityEvent {
  /** `bigint` stringified — `JSON.stringify` throws on one outright. */
  readonly id: string;
  readonly itemId: string | null;
  /** The item's title, resolved so a row reads as prose without a second call. */
  readonly itemTitle: string | null;
  /** The item's area, which is what an area filter matched on. */
  readonly itemArea: string | null;
  readonly ts: string;
  readonly actorType: EventRow["actorType"];
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly type: EventRow["type"];
  /** The one-line BLUF, when the event carries one. */
  readonly headline: string | null;
  /** Whether **this** profile has marked it seen. Always false when no profile was named. */
  readonly seen: boolean;
}

/** `ActivityEvent` plus the two unbounded columns — what `full: true` returns. */
export interface ActivityEventFull extends ActivityEvent {
  readonly payload: Record<string, unknown>;
  readonly body: string | null;
}

export interface GetActivityOutput {
  /** Newest first. */
  readonly events: readonly (ActivityEvent | ActivityEventFull)[];
  /**
   * The `id` to pass back as `cursor`. Null when this page is the last — a
   * fact established by fetching one row beyond the page, not inferred from
   * a page that happens to be exactly `limit` long.
   */
  readonly nextCursor: string | null;
}

interface RawActivityRow {
  id: bigint;
  itemId: string | null;
  ts: Date;
  actorType: EventRow["actorType"];
  actorId: string | null;
  sessionId: string | null;
  type: EventRow["type"];
  headline: string | null;
  itemTitle: string | null;
  itemArea: string | null;
  payload?: Record<string, unknown>;
  body?: string | null;
}

/**
 * The columns the slim shape selects — everything but `payload` and `body`.
 *
 * Exported so a test can assert what is actually asked of Postgres. The
 * handler builds the slim object field by field, so a query that selected
 * the two unbounded columns anyway would return the right *shape* while
 * paying the full transfer cost — a mistake no assertion on the response
 * can see. The same reasoning as `SLIM_HISTORY_COLUMNS`.
 */
export const SLIM_ACTIVITY_COLUMNS = `e."id", e."itemId", e."ts", e."actorType"::text AS "actorType",
              e."actorId", e."sessionId", e."type"::text AS "type", e."headline",
              i."title" AS "itemTitle", i."area" AS "itemArea"`;

/** The slim columns plus the two unbounded ones. */
export const FULL_ACTIVITY_COLUMNS = `${SLIM_ACTIVITY_COLUMNS}, e."payload", e."body"`;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const getActivity = defineOperation({
  name: "get_activity",
  kind: "read",
  summary:
    "The fleet-wide timeline, newest first and paged. Filterable by type, actor, item, area and session, with per-profile seen state. Returns each event without its payload and body; pass full for those.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetActivityInput): Promise<GetActivityOutput> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // `= ANY($n)` rather than an interpolated `IN (...)`: the values are
    // caller-supplied, so they travel as one bound array parameter and
    // never as SQL text. The `::text[]` casts are explicit because an
    // empty array has no inferrable element type in Postgres — though the
    // schema's `.min(1)` means an empty one never arrives.
    if (input.type) conditions.push(`e."type" = ANY(${bind(input.type)}::text[]::"EventType"[])`);
    if (input.actorType)
      conditions.push(`e."actorType" = ANY(${bind(input.actorType)}::text[]::"ActorType"[])`);
    if (input.actorId) conditions.push(`e."actorId" = ANY(${bind(input.actorId)}::text[])`);
    if (input.itemId) conditions.push(`e."itemId" = ANY(${bind(input.itemId)}::text[])`);
    if (input.sessionId) conditions.push(`e."sessionId" = ANY(${bind(input.sessionId)}::text[])`);
    // An area filter reaches through the join, so it also requires the event
    // to have an item at all — see the module header on why that is the
    // right reading rather than an omission.
    if (input.area) conditions.push(`i."area" = ANY(${bind(input.area)}::text[])`);

    // `NOT EXISTS` rather than a `LEFT JOIN ... IS NULL`: the question is
    // existence of one row in a table keyed exactly on the pair being
    // asked about, and it cannot duplicate the outer row the way a join
    // can. Only applied with a profile named — "unseen" with nobody to
    // have seen it would filter nothing while looking like it filtered.
    if (input.unseenOnly && input.personId !== undefined) {
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM "EventSeen" s
                     WHERE s."eventId" = e."id" AND s."personId" = ${bind(input.personId)})`,
      );
    }

    if (input.cursor !== undefined) {
      // `id < cursor` on a single monotonic bigint — no tie-break column is
      // needed because `id` is the primary key and therefore already
      // unique. Ordering by `id` rather than `ts` is deliberate: two events
      // can share a millisecond, so `ts` is not a total order and a cursor
      // over it could repeat or skip.
      conditions.push(`e."id" < ${bind(input.cursor)}::bigint`);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;

    // One row beyond the page, so "there is more" is a fact rather than an
    // inference — the same trick `get_item_history` and `list_items` use.
    const rows = await ctx.db.$queryRawUnsafe<RawActivityRow[]>(
      `SELECT ${input.full ? FULL_ACTIVITY_COLUMNS : SLIM_ACTIVITY_COLUMNS}
       FROM "Event" e
       LEFT JOIN "Item" i ON i."id" = e."itemId"
       ${where}
       ORDER BY e."id" DESC
       LIMIT ${bind(input.limit + 1)}`,
      ...params,
    );

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;

    // Read state for exactly the rows on this page — one query keyed on the
    // ids already in hand. Skipped entirely with no profile named, because
    // every row's answer is then `false` without asking.
    const seen = new Set<bigint>();
    if (input.personId !== undefined && page.length > 0) {
      const seenRows = await ctx.db.$queryRawUnsafe<{ eventId: bigint }[]>(
        `SELECT "eventId" FROM "EventSeen"
         WHERE "personId" = $1 AND "eventId" = ANY($2::bigint[])`,
        input.personId,
        page.map((row) => row.id),
      );
      for (const row of seenRows) seen.add(row.eventId);
    }

    const events = page.map((row) => {
      const slim: ActivityEvent = {
        id: row.id.toString(),
        itemId: row.itemId,
        itemTitle: row.itemTitle,
        itemArea: row.itemArea,
        ts: row.ts.toISOString(),
        actorType: row.actorType,
        actorId: row.actorId,
        sessionId: row.sessionId,
        type: row.type,
        headline: row.headline,
        seen: seen.has(row.id),
      };
      if (!input.full) return slim;
      return { ...slim, payload: row.payload ?? {}, body: row.body ?? null };
    });

    return {
      events,
      nextCursor: hasMore ? (events[events.length - 1]?.id ?? null) : null,
    };
  },
});
