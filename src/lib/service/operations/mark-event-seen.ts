// `mark_event_seen` — SCHEMA.md §19 `POST /events/{id}/seen`: "Mark read."
// §8b `event_seen`. MILESTONES.md #38.
//
// **Idempotent by construction, not by checking first.** The insert is
// `ON CONFLICT ("eventId", "personId") DO NOTHING` against the composite
// primary key SCHEMA.md §8b already declares, so marking something seen
// twice is a no-op that succeeds — not an error, and not a row that moves
// `seen_at` forward.
//
// Both halves of that matter, and they are separate decisions:
//
//   - **Not an error**, because the caller has no way to avoid it. Two
//     browser tabs, a double-click, a retried request after a timeout that
//     actually succeeded — all produce a second call, and in every one of
//     them the user's intent ("this is read") is already satisfied. A
//     conflict error here would be a failure report for an outcome that is
//     exactly what was asked for, and the caller's only sane response would
//     be to ignore it, which is an error nobody should have raised.
//   - **`seen_at` is not bumped** on the repeat. `DO NOTHING` rather than
//     `DO UPDATE`: §8b's `seen_at` is when this person *first* saw it, and
//     that is the more useful fact — it is the one an "unread for three
//     days" or "acknowledged within the hour" reading depends on. An upsert
//     would silently rewrite history to say every event was seen the last
//     time anyone happened to re-click it. `alreadySeen` in the result
//     reports which happened, so a caller can tell the two apart without
//     the write having to differ.
//
// **Marking seen is not an item mutation and appends nothing to the ledger.**
// Every mutating call appends an `events` row (SCHEMA.md §3) — this one
// does not, and the exception is principled rather than an omission. Read
// state is a per-person annotation *on* the ledger, so appending an event
// for it would make the act of reading the ledger grow the ledger, which
// every reader then has to read. Worse, it recurses: the new row is itself
// unseen by every other profile, so acknowledging your inbox would create
// work in everyone else's. `event_seen` exists precisely so this fact lives
// beside the ledger instead of in it — §3 says so directly, in explaining
// why seen state cannot be a column on `events`: "one person marking
// something read must not clear it for another."
//
// **Both foreign keys are checked before the insert** so the refusal names
// which one was wrong. `event_seen` references both `events` and `people`,
// and a bare insert would surface a Postgres constraint name — accurate,
// and useless to a caller trying to work out whether they sent a stale
// event id or an unknown profile.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";

const inputSchema = z
  .object({
    /**
     * The event to mark. A string rather than a number because `events.id`
     * is a `bigint` — past 2^53 a JSON number loses precision silently, and
     * an id that rounds marks the wrong row read.
     */
    eventId: z.string().regex(/^\d+$/, "eventId must be a non-negative integer"),
    /** Whose read state. Required — there is no such thing as "seen by nobody in particular". */
    personId: z.string().min(1),
  })
  .strict();

export type MarkEventSeenInput = z.infer<typeof inputSchema>;

export interface MarkEventSeenOutput {
  readonly eventId: string;
  readonly personId: string;
  /** When this person first saw it — unchanged on a repeat call. */
  readonly seenAt: string;
  /** True when the row already existed, so nothing was written. See the module header. */
  readonly alreadySeen: boolean;
}

interface RawSeenRow {
  seenAt: Date;
}

export const markEventSeen = defineOperation({
  name: "mark_event_seen",
  kind: "write",
  summary:
    "Marks one event read for one profile. Idempotent — marking it again succeeds and does not move the original seen-at.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: MarkEventSeenInput): Promise<MarkEventSeenOutput> {
    const eventId = BigInt(input.eventId);

    const eventRows = await ctx.db.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT "id" FROM "Event" WHERE "id" = $1`,
      eventId,
    );
    if (eventRows.length === 0) {
      throw new NotFoundError(`No such event: ${input.eventId}.`, { fields: ["eventId"] });
    }

    const personRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Person" WHERE "id" = $1`,
      input.personId,
    );
    if (personRows.length === 0) {
      throw new NotFoundError(`No such profile: ${input.personId}.`, { fields: ["personId"] });
    }

    // `RETURNING` fires only for a row this statement actually inserted, so
    // an empty result *is* the "already seen" signal — no second query, and
    // no read-then-write race between checking and inserting.
    const inserted = await ctx.db.$queryRawUnsafe<RawSeenRow[]>(
      `INSERT INTO "EventSeen" ("eventId", "personId")
       VALUES ($1, $2)
       ON CONFLICT ("eventId", "personId") DO NOTHING
       RETURNING "seenAt"`,
      eventId,
      input.personId,
    );

    if (inserted.length > 0) {
      return {
        eventId: input.eventId,
        personId: input.personId,
        seenAt: inserted[0]!.seenAt.toISOString(),
        alreadySeen: false,
      };
    }

    // Already there. Read back the original `seenAt` rather than returning
    // `now()`: the whole point of `DO NOTHING` is that the first sighting is
    // the one on record, and a caller that displays what this returns should
    // show that same instant on every call.
    const existing = await ctx.db.$queryRawUnsafe<RawSeenRow[]>(
      `SELECT "seenAt" FROM "EventSeen" WHERE "eventId" = $1 AND "personId" = $2`,
      eventId,
      input.personId,
    );
    const seenAt = existing[0]?.seenAt;
    if (seenAt === undefined) {
      // The insert conflicted, so a row existed a moment ago; it is gone
      // now. Nothing in this system deletes read state, so this is a data
      // problem rather than a caller error — the same posture `get_board`
      // takes on a state outside the vocabulary.
      throw new NotFoundError(
        `Read state for event ${input.eventId} and profile ${input.personId} vanished between insert and read.`,
        { fields: ["eventId", "personId"] },
      );
    }

    return {
      eventId: input.eventId,
      personId: input.personId,
      seenAt: seenAt.toISOString(),
      alreadySeen: true,
    };
  },
});
