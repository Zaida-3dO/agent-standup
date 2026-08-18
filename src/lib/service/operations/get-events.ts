// `get_events` — SCHEMA.md §19 `GET /events?since=`: "Since-your-last-visit.
// A **slice**, never the whole ledger." MILESTONES.md #38.
//
// **What "since your last visit" reads from, and why it is not a timestamp.**
// The obvious design — one `last_visited_at` per person, bumped on every
// load — is the one this schema deliberately does not have, and SCHEMA.md
// §8b says what it has instead: "Since-your-last-visit is `events LEFT JOIN
// event_seen` for the current profile. Unseen for one profile and seen for
// another is a normal, expected state." So read state is **per event, per
// person** — a composite-key row in `event_seen` — not a watermark.
//
// That difference is not cosmetic, and three properties fall out of it that
// a watermark cannot express:
//
//   - **Marking one thing read does not mark everything beneath it read.** A
//     watermark can only move forward over the whole ledger at once, so
//     acknowledging the newest event silently swallows everything below it
//     that you had not looked at. Per-event rows let you clear one and keep
//     the rest.
//   - **Two people never interfere.** §8b's "unseen for one profile and seen
//     for another is a normal, expected state" is a structural guarantee
//     here rather than a rule to remember, because a row is keyed by
//     `(event_id, person_id)` and one person's insert cannot touch another's.
//     SCHEMA.md §3 makes the same point from the other side: seen state
//     "cannot be a column [on events]: one person marking something read must
//     not clear it for another."
//   - **It is reconstructible.** The ledger is durable and append-only; read
//     state is a join against it. Nothing is lost or overwritten when
//     something is marked seen — a row is added.
//
// **The first visit is the boundary most likely to be got wrong, so it is
// worth being explicit about what happens.** A person who has never marked
// anything seen has *no rows at all* in `event_seen`. The `LEFT JOIN` then
// matches nothing for every event, so every event in the slice comes back
// `seen: false`. That is the intended answer, and it is intended in a
// specific direction: a first visit shows you the recent ledger, not an
// empty page.
//
// The tempting alternative — treat "no marker" as "seen everything up to
// now", so a new profile starts clean — is wrong here for a reason that
// outlives the first visit. It requires writing a marker at *read* time, so
// merely loading the page would mutate read state, and any load that raced a
// write would mark unseen work as seen without anyone having seen it. Making
// a read a write to avoid a busy first screen trades a cosmetic problem for
// a correctness one. A first visitor sees recent history and can clear it in
// one action; that is a better failure than silently swallowing events.
//
// **`seenByAnyone` is reported separately from `seen`.** `seen` is the
// current profile's own answer — the only one that decides what is unread
// *for you*. `seenByAnyone` says whether any profile has cleared it, which
// is what makes "someone else has already picked this up" legible without
// implying you have. Collapsing the two would make a teammate's attention
// look like your own.
//
// **Bounded, always.** Reads go through `readSinceBounded` — the same
// horizon-bounded slice `orientation` uses — so this inherits SCHEMA.md §3's
// "never skips a row" property rather than reimplementing it: `id > since`
// alone can permanently skip a row, because `id` is handed out before commit
// and a late commit can land a lower `id` after a reader already advanced
// past it. The `horizon` comes back with the rows so a caller can tell a
// healthy short delay from a stuck one.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { readSinceBounded, type EventRow } from "@/lib/events";

/**
 * The slice bound.
 *
 * Defaulted rather than optional, and capped rather than unbounded, because
 * §19 calls this "a **slice**, never the whole ledger" — an unbounded read
 * of an append-only table that nothing prunes gets slower forever, and the
 * board's own bare-read problem (MILESTONES.md #103) is the same mistake one
 * table over. 50 is a screenful; 200 is the most a caller may ask for.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    /**
     * Exclusive lower bound on `id` — "everything after this". A string
     * rather than a number because `events.id` is a `bigint`: past
     * 2^53 a JSON number silently loses precision, and a cursor that
     * quietly rounds is a cursor that skips or repeats rows.
     */
    since: z.string().regex(/^\d+$/, "since must be a non-negative integer").optional(),
    /**
     * Whose read state to report. Optional: with no profile chosen the
     * ledger is still readable, and every event comes back `seen: false`
     * — the honest answer, since "seen" is meaningless without a person to
     * have seen it. It is emphatically *not* the same as reporting another
     * profile's read state, which would show a stranger's inbox as yours.
     */
    personId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    /**
     * Drop everything the current profile has already marked seen. The
     * "what's new" view, as opposed to the "recent history" one.
     *
     * Filtered **after** the bounded slice rather than in its `WHERE`, so
     * the cursor a caller advances to still refers to a real position in
     * the ledger. Filtering inside the slice would let `unseenOnly` return
     * fewer rows *and* a cursor that skipped the seen ones, so a later call
     * without the filter would never see them again.
     */
    unseenOnly: z.boolean().default(false),
  })
  .strict();

export type GetEventsInput = z.infer<typeof inputSchema>;

/** One event in the slice, with this profile's read state resolved against it. */
export interface SinceEvent {
  /** `bigint` stringified — `JSON.stringify` throws on a `bigint` outright. */
  readonly id: string;
  readonly txId: string;
  readonly itemId: string | null;
  /** The item's title, when the event is scoped to one — so a row reads as prose without a second call. */
  readonly itemTitle: string | null;
  readonly ts: string;
  readonly actorType: EventRow["actorType"];
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly assignmentId: string | null;
  readonly type: EventRow["type"];
  readonly payload: Record<string, unknown>;
  readonly body: string | null;
  /** Whether **this** profile has marked it seen. Always `false` when no profile was named. */
  readonly seen: boolean;
  /** Whether *any* profile has — see the module header on why this is separate from `seen`. */
  readonly seenByAnyone: boolean;
}

export interface GetEventsOutput {
  readonly events: readonly SinceEvent[];
  /** The cursor to pass as `since` next time — the highest `id` in this slice, or the caller's own `since` when it was empty. */
  readonly cursor: string;
  /** SCHEMA.md §3's visibility horizon, so a caller can tell a short delay from a stuck one. */
  readonly horizon: string;
  /** How many of the returned events this profile has not seen. */
  readonly unseenCount: number;
  /** Whether this profile has ever marked anything seen — false on a genuine first visit. See the module header. */
  readonly firstVisit: boolean;
}

interface RawSeenRow {
  eventId: bigint;
  personId: string;
}

interface RawTitleRow {
  id: string;
  title: string;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getEvents = defineOperation({
  name: "get_events",
  kind: "read",
  summary:
    "Since your last visit: a bounded slice of the events ledger with per-profile read state. Pass since to page, personId to resolve whose read state, unseenOnly for just what is new.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetEventsInput): Promise<GetEventsOutput> {
    const since = input.since !== undefined ? BigInt(input.since) : 0n;
    const { events, horizon } = await readSinceBounded(ctx.db, { since, limit: input.limit });

    // Read state for exactly the events in this slice — one query keyed on
    // the ids already in hand, rather than a join inside `readSinceBounded`.
    // Keeping it out of that function is deliberate: `readSinceBounded` is
    // the shared, horizon-bounded ledger read that `orientation` also uses
    // (SCHEMA.md §3: "the same rows, sliced differently"), and threading a
    // person through it would put a per-profile concern inside the one
    // primitive that must stay person-agnostic.
    const eventIds = events.map((event) => event.id);
    const seenByThisPerson = new Set<bigint>();
    const seenBySomeone = new Set<bigint>();
    if (eventIds.length > 0) {
      const seenRows = await ctx.db.$queryRawUnsafe<RawSeenRow[]>(
        `SELECT "eventId", "personId" FROM "EventSeen" WHERE "eventId" = ANY($1::bigint[])`,
        eventIds,
      );
      for (const row of seenRows) {
        seenBySomeone.add(row.eventId);
        if (input.personId !== undefined && row.personId === input.personId) {
          seenByThisPerson.add(row.eventId);
        }
      }
    }

    // Titles for the items these events touch — one lookup for the whole
    // slice. An event carries `itemId` but not the title, and a "since your
    // last visit" list that shows opaque identifiers is not readable; doing
    // it per row would be N round trips for a screenful.
    const itemIds = [
      ...new Set(events.map((e) => e.itemId).filter((id): id is string => id !== null)),
    ];
    const titles = new Map<string, string>();
    if (itemIds.length > 0) {
      const titleRows = await ctx.db.$queryRawUnsafe<RawTitleRow[]>(
        `SELECT "id", "title" FROM "Item" WHERE "id" = ANY($1::text[])`,
        itemIds,
      );
      for (const row of titleRows) titles.set(row.id, row.title);
    }

    // A genuine first visit: this profile has no read state *anywhere*, not
    // merely none within this slice. Asked as its own existence check
    // because the distinction is exactly the one the module header is about
    // — someone who has cleared their history and come back to new events
    // has an empty intersection with this slice too, and they are not a
    // first visitor. `LIMIT 1` because the question is existence.
    let firstVisit = false;
    if (input.personId !== undefined) {
      const anySeen = await ctx.db.$queryRawUnsafe<{ one: number }[]>(
        `SELECT 1 AS "one" FROM "EventSeen" WHERE "personId" = $1 LIMIT 1`,
        input.personId,
      );
      firstVisit = anySeen.length === 0;
    }

    const mapped: SinceEvent[] = events.map((event) => ({
      id: event.id.toString(),
      txId: event.txId.toString(),
      itemId: event.itemId,
      itemTitle: event.itemId !== null ? (titles.get(event.itemId) ?? null) : null,
      ts: event.ts.toISOString(),
      actorType: event.actorType,
      actorId: event.actorId,
      sessionId: event.sessionId,
      assignmentId: event.assignmentId,
      type: event.type,
      payload: event.payload,
      body: event.body,
      seen: seenByThisPerson.has(event.id),
      seenByAnyone: seenBySomeone.has(event.id),
    }));

    // The cursor is the slice's own high-water mark, taken **before**
    // `unseenOnly` filters anything — see that field's comment. `events` is
    // ordered by `id` ascending, so the last one is the highest.
    const lastId = events.length > 0 ? events[events.length - 1]!.id.toString() : since.toString();

    const visible = input.unseenOnly ? mapped.filter((event) => !event.seen) : mapped;

    return {
      events: visible,
      cursor: lastId,
      horizon: horizon.toString(),
      // Counted over the whole slice, not over `visible` — with
      // `unseenOnly` on those are the same number, and without it the
      // count still means "how much of this is new to you".
      unseenCount: mapped.reduce((count, event) => (event.seen ? count : count + 1), 0),
      firstVisit,
    };
  },
});
