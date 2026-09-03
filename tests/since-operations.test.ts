// `get_events` and `mark_event_seen` against a real Postgres — SCHEMA.md
// §19 (`GET /events?since=`, `POST /events/{id}/seen`), §8b (`event_seen`,
// per-person read state). MILESTONES.md #38.
//
// A real database rather than a model of one, for the same reason
// `tests/board-operations.test.ts` needs one: the behaviour under test is a
// LEFT-JOIN-shaped read and an `ON CONFLICT DO NOTHING` insert against a
// composite primary key. Both are properties of Postgres, and an in-memory
// stand-in would be asserting that the stand-in works.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { GetEventsOutput } from "@/lib/service/operations/get-events";
import type { MarkEventSeenOutput } from "@/lib/service/operations/mark-event-seen";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("since your last visit, against Postgres", () => {
  const dbName = scratchDatabaseName("since_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** A profile to own read state. Two of them is what makes the per-person assertions meaningful. */
  async function createPerson(id: string): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      id,
      id,
    );
    return id;
  }

  async function createItem(title: string): Promise<string> {
    const item = (await runtime.call("create_item", {
      title,
      body: "x",
      area: "since-tests",
      originType: "auto",
    })) as { id: string };
    return item.id;
  }

  /**
   * Appends an event the same way the application does — through a real
   * operation — and waits for it to clear the visibility horizon.
   *
   * **The wait is not incidental and must not be removed.** `get_events`
   * reads through `readSinceBounded`, which bounds itself to `txId <
   * horizon` so it can never permanently skip a row (SCHEMA.md §3). The
   * horizon is `pg_snapshot_xmin` — a property of the whole Postgres
   * server, not of this database — so *any* transaction open anywhere on
   * that server holds back every row written after it started. This suite
   * shares a server with the rest of the DB-backed suites, one of which
   * deliberately parks an open transaction to prove that very bound, and
   * vitest runs test files in parallel. Without this wait, a write here is
   * legitimately invisible to the read that follows it, and the test fails
   * for a reason that has nothing to do with the code under test.
   *
   * This is the behaviour working, not a workaround for a bug: it waits for
   * the guarantee rather than defeating it, and any assertion below still
   * fails for real if the row never becomes visible.
   */
  async function appendNote(itemId: string, body: string): Promise<string> {
    const appended = (await runtime.call("note", { itemId, body })) as { id: bigint | string };
    const id = String(appended.id);
    await waitForVisibility(id);
    return id;
  }

  /** Polls until `eventId` is inside the horizon a bounded read would use, or gives up loudly. */
  async function waitForVisibility(eventId: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const feed = (await runtime.call("get_events", {
        since: String(BigInt(eventId) - 1n),
        limit: 1,
      })) as GetEventsOutput;
      if (feed.events.some((event) => event.id === eventId)) return;
      if (Date.now() > deadline) {
        throw new Error(
          `Event ${eventId} never became visible to a horizon-bounded read within ${timeoutMs}ms.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function getEvents(input: Record<string, unknown> = {}): Promise<GetEventsOutput> {
    return runtime.call("get_events", input) as Promise<GetEventsOutput>;
  }

  async function markSeen(eventId: string, personId: string): Promise<MarkEventSeenOutput> {
    return runtime.call("mark_event_seen", { eventId, personId }) as Promise<MarkEventSeenOutput>;
  }

  describe("the first visit — no marker at all", () => {
    it("returns every event as unseen, rather than an empty page", async () => {
      const person = await createPerson("first-visitor");
      const itemId = await createItem("First visit item");
      const eventId = await appendNote(itemId, "something happened");

      // Anchored just below our own event. A read from the start of the
      // ledger returns the OLDEST slice, and this suite shares its ledger
      // with every other DB-backed file — so with a page size of 50 and a
      // busy shared table, our own event can sit beyond the end of the
      // first page. That would fail this test for a paging reason rather
      // than the read-state reason it exists to check.
      const feed = await getEvents({ personId: person, since: String(BigInt(eventId) - 1n) });
      expect(feed.events.some((event) => event.id === eventId)).toBe(true);

      // The boundary the whole design turns on: no rows in EventSeen means
      // the LEFT JOIN matches nothing, so everything is unseen. If this
      // ever returned an empty list, a new profile would be shown a blank
      // page and told they were up to date.
      expect(feed.events.length).toBeGreaterThan(0);
      expect(feed.events.every((event) => event.seen === false)).toBe(true);
      expect(feed.unseenCount).toBe(feed.events.length);
    }, 30_000);

    it("reports firstVisit true for a profile that has never marked anything", async () => {
      const person = await createPerson("never-marked");
      const feed = await getEvents({ personId: person });
      expect(feed.firstVisit).toBe(true);
    }, 30_000);

    it("reports firstVisit false once that profile has marked anything at all", async () => {
      const person = await createPerson("has-marked");
      const itemId = await createItem("Marks something");
      const eventId = await appendNote(itemId, "note");
      await markSeen(eventId, person);

      const feed = await getEvents({ personId: person });
      expect(feed.firstVisit).toBe(false);
    }, 30_000);

    it("keeps firstVisit false even when nothing in the current slice is seen", async () => {
      // The distinction the module header is about: someone who cleared
      // their history and came back to new events has an empty
      // intersection with this slice, and is NOT a first visitor. Asked as
      // an existence check over all their read state, not over the slice.
      const person = await createPerson("cleared-then-new");
      const itemId = await createItem("Old then new");
      const oldEvent = await appendNote(itemId, "old");
      await markSeen(oldEvent, person);

      // Everything after the event they marked — so the slice contains
      // nothing they have seen.
      const feed = await getEvents({ personId: person, since: oldEvent });
      expect(feed.events.some((event) => event.seen)).toBe(false);
      expect(feed.firstVisit).toBe(false);
    }, 30_000);

    it("reports firstVisit false when no profile was named, rather than claiming a visit", async () => {
      // With no personId there is no person to be on a first visit.
      const feed = await getEvents({});
      expect(feed.firstVisit).toBe(false);
    }, 30_000);
  });

  describe("nothing new since last visit", () => {
    it("returns an empty slice when the cursor is already at the newest event", async () => {
      const person = await createPerson("caught-up");
      const itemId = await createItem("Caught up item");
      const eventId = await appendNote(itemId, "one");

      // Anchored below our own event — see the first-visit test above on
      // why a read from the start of a shared ledger is not a reliable way
      // to get hold of the row this test is about.
      const first = await getEvents({ personId: person, since: String(BigInt(eventId) - 1n) });
      expect(first.events.length).toBeGreaterThan(0);

      // Ask again from where that slice ended: nothing has happened since,
      // as far as this item is concerned. Scoped to our own item rather than
      // asserting the whole slice is empty, because another test file
      // writing to the shared ledger between these two reads is a legal
      // thing to happen and has nothing to do with the cursor.
      //
      // Still able to fail for the real reason: if the cursor did not
      // advance past our event, that event comes back here and this fails.
      const second = await getEvents({ personId: person, since: first.cursor });
      expect(second.events.filter((event) => event.itemId === itemId)).toEqual([]);
      expect(second.events.some((event) => event.id === eventId)).toBe(false);
    }, 30_000);

    it("returns the caller's own cursor unchanged when the slice is empty", async () => {
      // Otherwise a caller polling an idle system would have its cursor
      // reset to 0 and re-read the whole ledger on the next call.
      //
      // Polled from a cursor far beyond anything the shared ledger holds,
      // so the slice is empty for a reason this test controls rather than
      // one another test file could disturb by writing a row.
      const person = await createPerson("idle-poller");
      const beyond = await prisma.$queryRawUnsafe<{ max: bigint | null }[]>(
        `SELECT MAX("id") AS "max" FROM "Event"`,
      );
      const cursor = String((beyond[0]?.max ?? 0n) + 1_000_000n);

      const feed = await getEvents({ personId: person, since: cursor });
      expect(feed.events).toEqual([]);
      // The caller's own cursor comes back, NOT 0 — a single-character
      // change to `since.toString()` returning "0" would fail here.
      expect(feed.cursor).toBe(cursor);
    }, 30_000);

    it("returns nothing under unseenOnly when everything in the slice is seen", async () => {
      const person = await createPerson("all-seen");
      const itemId = await createItem("All seen item");
      const eventId = await appendNote(itemId, "the only note");

      // Anchored to our own event, and every assertion below is scoped to
      // the same window — another test file writing an unseen row to the
      // shared ledger mid-test is legal and says nothing about `unseenOnly`.
      const since = String(BigInt(eventId) - 1n);

      const before = await getEvents({ personId: person, since });
      for (const event of before.events) await markSeen(event.id, person);

      const after = await getEvents({ personId: person, since, unseenOnly: true });
      // Everything we marked is gone from the unseen view — including,
      // specifically, our own event.
      expect(after.events.some((event) => event.id === eventId)).toBe(false);
      expect(after.events.every((event) => !event.seen)).toBe(true);

      // But the events still exist — this is "nothing NEW", not "nothing".
      const unfiltered = await getEvents({ personId: person, since });
      expect(unfiltered.events.some((event) => event.id === eventId)).toBe(true);
      expect(unfiltered.events.find((event) => event.id === eventId)?.seen).toBe(true);
    }, 30_000);
  });

  describe("the seen action is idempotent", () => {
    it("succeeds the second time rather than erroring", async () => {
      const person = await createPerson("double-marker");
      const itemId = await createItem("Double marked");
      const eventId = await appendNote(itemId, "note");

      const first = await markSeen(eventId, person);
      const second = await markSeen(eventId, person);

      expect(first.alreadySeen).toBe(false);
      expect(second.alreadySeen).toBe(true);
    }, 30_000);

    it("does not move the original seenAt on a repeat", async () => {
      // DO NOTHING rather than DO UPDATE: seen_at is when this person
      // FIRST saw it, which is what an "unread for three days" reading
      // depends on. An upsert would rewrite history on every re-click.
      const person = await createPerson("seen-at-stable");
      const itemId = await createItem("Stable seenAt");
      const eventId = await appendNote(itemId, "note");

      const first = await markSeen(eventId, person);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second = await markSeen(eventId, person);

      expect(second.seenAt).toBe(first.seenAt);
    }, 30_000);

    it("writes exactly one row however many times it is called", async () => {
      const person = await createPerson("one-row-only");
      const itemId = await createItem("One row");
      const eventId = await appendNote(itemId, "note");

      await markSeen(eventId, person);
      await markSeen(eventId, person);
      await markSeen(eventId, person);

      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "EventSeen" WHERE "eventId" = $1 AND "personId" = $2`,
        BigInt(eventId),
        person,
      );
      expect(Number(rows[0]!.count)).toBe(1);
    }, 30_000);

    it("appends nothing to the ledger — reading does not grow what must be read", async () => {
      // Marking seen is a per-person annotation ON the ledger, not an
      // entry in it. An event here would be unseen by every other profile,
      // so acknowledging your own inbox would create work in everyone
      // else's.
      const person = await createPerson("no-ledger-growth");
      const itemId = await createItem("No ledger growth");
      const eventId = await appendNote(itemId, "note");

      const before = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "Event"`,
      );
      await markSeen(eventId, person);
      const after = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "Event"`,
      );

      expect(Number(after[0]!.count)).toBe(Number(before[0]!.count));
    }, 30_000);
  });

  describe("read state is per person", () => {
    it("one profile marking something read leaves it unread for another", async () => {
      // SCHEMA.md §8b: "Unseen for one profile and seen for another is a
      // normal, expected state." §3: seen state "cannot be a column [on
      // events]: one person marking something read must not clear it for
      // another."
      const reader = await createPerson("the-reader");
      const other = await createPerson("the-other");
      const itemId = await createItem("Two readers");
      const eventId = await appendNote(itemId, "note");

      await markSeen(eventId, reader);

      // Anchored just below this test's own event, per this file's
      // convention. An unanchored `since=0` read relies on fewer rows
      // existing than the 50-row default page holds — a margin that shrinks
      // with every test added, and one whose loss surfaces as a confusing
      // paging error rather than a read-state one (#122).
      const from = String(BigInt(eventId) - 1n);
      const readerFeed = await getEvents({ personId: reader, since: from });
      const otherFeed = await getEvents({ personId: other, since: from });

      expect(readerFeed.events.find((e) => e.id === eventId)?.seen).toBe(true);
      expect(otherFeed.events.find((e) => e.id === eventId)?.seen).toBe(false);
    }, 30_000);

    it("reports seenByAnyone separately from your own seen", async () => {
      // "Someone else has already picked this up" must be legible without
      // implying you have.
      const reader = await createPerson("anyone-reader");
      const other = await createPerson("anyone-other");
      const itemId = await createItem("Seen by someone else");
      const eventId = await appendNote(itemId, "note");

      await markSeen(eventId, reader);

      const otherFeed = await getEvents({
        personId: other,
        since: String(BigInt(eventId) - 1n),
      });
      const row = otherFeed.events.find((e) => e.id === eventId)!;
      expect(row.seen).toBe(false);
      expect(row.seenByAnyone).toBe(true);
    }, 30_000);

    it("shows everything as unseen when no profile is named", async () => {
      // Not "another profile's read state" — that would show a stranger's
      // inbox as yours.
      const reader = await createPerson("nameless-reader");
      const itemId = await createItem("No profile named");
      const eventId = await appendNote(itemId, "note");
      await markSeen(eventId, reader);

      const feed = await getEvents({ since: String(BigInt(eventId) - 1n) });
      expect(feed.events.find((e) => e.id === eventId)?.seen).toBe(false);
    }, 30_000);

    it("counts unseen for the named profile only", async () => {
      const a = await createPerson("counter-a");
      const b = await createPerson("counter-b");
      const itemId = await createItem("Counted separately");
      const one = await appendNote(itemId, "one");
      await appendNote(itemId, "two");

      await markSeen(one, a);

      const feedA = await getEvents({ personId: a });
      const feedB = await getEvents({ personId: b });
      expect(feedB.unseenCount).toBe(feedA.unseenCount + 1);
    }, 30_000);
  });

  describe("the slice is bounded", () => {
    it("returns no more than the requested limit", async () => {
      const itemId = await createItem("Many events");
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push(await appendNote(itemId, `note ${i}`));

      // Anchored just below our own first event rather than reading from the
      // start of a ledger this suite shares with every other DB-backed file
      // — see `appendNote` on why rows down there can legitimately be held
      // back. Anchoring keeps this assertion about the limit alone.
      const feed = await getEvents({ since: String(BigInt(ids[0]!) - 1n), limit: 3 });
      expect(feed.events).toHaveLength(3);
    }, 30_000);

    it("pages forward without repeating or skipping", async () => {
      const itemId = await createItem("Paged events");
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await appendNote(itemId, `paged ${i}`));

      // Start just before the first of ours, then walk forward in twos.
      let cursor = String(BigInt(ids[0]!) - 1n);
      const collected: string[] = [];
      for (let page = 0; page < 5; page++) {
        const feed = await getEvents({ since: cursor, limit: 2 });
        if (feed.events.length === 0) break;
        collected.push(...feed.events.map((e) => e.id));
        cursor = feed.cursor;
      }

      const ours = collected.filter((id) => ids.includes(id));
      expect(ours).toEqual(ids);
      expect(new Set(collected).size).toBe(collected.length);
    }, 30_000);

    it("refuses a limit above the cap rather than silently serving it", async () => {
      await expect(getEvents({ limit: 5000 })).rejects.toThrow();
    }, 30_000);

    it("refuses a non-numeric cursor", async () => {
      await expect(getEvents({ since: "not-a-number" })).rejects.toThrow();
    }, 30_000);

    it("keeps the cursor at the slice's high-water mark even under unseenOnly", async () => {
      // Filtering after the slice rather than inside its WHERE is what
      // keeps the cursor referring to a real ledger position. If
      // unseenOnly filtered in SQL, the cursor would skip the seen rows and
      // a later unfiltered call would never see them again.
      const person = await createPerson("cursor-under-filter");
      const itemId = await createItem("Cursor under filter");
      const first = await appendNote(itemId, "will be seen");
      const second = await appendNote(itemId, "stays unseen");

      await markSeen(second, person);

      const feed = await getEvents({
        personId: person,
        unseenOnly: true,
        since: String(BigInt(first) - 1n),
      });
      // The cursor covers BOTH events, including the seen one it filtered out.
      expect(BigInt(feed.cursor)).toBeGreaterThanOrEqual(BigInt(second));
    }, 30_000);
  });

  describe("what the slice carries", () => {
    it("resolves the item title so a row reads as prose", async () => {
      const itemId = await createItem("A recognisable title");
      const eventId = await appendNote(itemId, "note");
      const feed = await getEvents({ since: String(BigInt(eventId) - 1n) });
      expect(feed.events.find((e) => e.id === eventId)?.itemTitle).toBe("A recognisable title");
    }, 30_000);

    it("stringifies the bigint id, which JSON cannot carry as a number", async () => {
      const itemId = await createItem("Bigint ids");
      const eventId = await appendNote(itemId, "note");
      // Anchored so `events[0]` is *this* test's event rather than whichever
      // row happens to sit first in a shared, unanchored page.
      const feed = await getEvents({ since: String(BigInt(eventId) - 1n) });
      expect(typeof feed.events[0]!.id).toBe("string");
      // And the whole response survives a JSON boundary — `JSON.stringify`
      // throws outright on a bigint, which is what the HTTP route would hit.
      expect(() => JSON.stringify(feed)).not.toThrow();
    }, 30_000);

    it("reports a horizon so a caller can tell a short delay from a stuck one", async () => {
      const feed = await getEvents({});
      expect(BigInt(feed.horizon)).toBeGreaterThan(0n);
    }, 30_000);
  });

  describe("rejections name what was wrong", () => {
    it("refuses an unknown event, naming eventId", async () => {
      const person = await createPerson("unknown-event-marker");
      await expect(markSeen("999999999", person)).rejects.toThrow(/No such event/);
    }, 30_000);

    it("refuses an unknown profile, naming personId", async () => {
      const itemId = await createItem("Unknown profile");
      const eventId = await appendNote(itemId, "note");
      await expect(markSeen(eventId, "nobody-by-that-name")).rejects.toThrow(/No such profile/);
    }, 30_000);

    it("refuses a non-numeric event id", async () => {
      const person = await createPerson("bad-id-marker");
      await expect(markSeen("not-a-number", person)).rejects.toThrow();
    }, 30_000);

    it("writes nothing when the profile is unknown", async () => {
      // The foreign keys are checked before the insert, so a bad call
      // leaves no partial state.
      const itemId = await createItem("No partial write");
      const eventId = await appendNote(itemId, "note");
      await expect(markSeen(eventId, "still-nobody")).rejects.toThrow();

      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "EventSeen" WHERE "eventId" = $1`,
        BigInt(eventId),
      );
      expect(Number(rows[0]!.count)).toBe(0);
    }, 30_000);
  });
});
