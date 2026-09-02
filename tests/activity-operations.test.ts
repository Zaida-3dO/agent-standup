// `get_activity` — the fleet-wide timeline, against a real Postgres. T19.
//
// A real database rather than a model of one, for the reason the sibling
// suites give: every property under test is a property of the SQL. The
// filters are `= ANY` over enum-cast arrays, the area filter is a join, the
// paging is a keyset over `id DESC`, and `unseenOnly` is a `NOT EXISTS`
// against a composite primary key. A stand-in would be asserting that the
// stand-in works.
//
// **No visibility wait here, unlike `since-operations.test.ts`.** That suite
// polls because `get_events` reads through `readSinceBounded`, which
// withholds rows above the visibility horizon. This operation deliberately
// does not carry that bound — a backward reader cannot skip a late commit,
// because such a row lands above the cursor rather than below it (see the
// operation's header). The absence of the wait is therefore part of what is
// being asserted, not an oversight: if someone adds a horizon bound here,
// these tests start failing intermittently, which is the correct signal.
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
import type { GetActivityOutput } from "@/lib/service/operations/get-activity";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_activity — the fleet timeline, against Postgres", () => {
  const dbName = scratchDatabaseName("activity_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let seq = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    await prisma.area.createMany({
      data: [
        { id: "area-web", displayName: "Web" },
        { id: "area-infra", displayName: "Infra" },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createPerson(id: string): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      id,
      id,
    );
    return id;
  }

  async function createItem(title: string, area: string): Promise<string> {
    seq += 1;
    const id = `activity-item-${seq}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title,
        body: "b",
        state: "executing",
        originType: "auto",
        area,
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /**
   * Writes one event directly.
   *
   * Direct rather than through an operation because the cases here need to
   * pin `type`, `actorType`, `actorId` and `sessionId` independently, and
   * no single operation produces every combination — `note` always writes a
   * `note`. The columns are the ones the filters read, so writing them
   * literally is what makes each filter's assertion about the filter rather
   * than about which operation happened to be called.
   */
  async function writeEvent(fields: {
    itemId?: string | null;
    type?: string;
    actorType?: "person" | "agent" | "system";
    actorId?: string | null;
    sessionId?: string | null;
    headline?: string | null;
    body?: string | null;
  }): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `INSERT INTO "Event" ("itemId", "type", "actorType", "actorId", "sessionId", "headline", "payload", "body")
       VALUES ($1, $2::"EventType", $3::"ActorType", $4, $5, $6, '{"k":"v"}'::jsonb, $7)
       RETURNING "id"`,
      fields.itemId ?? null,
      fields.type ?? "note",
      fields.actorType ?? "agent",
      fields.actorId ?? null,
      fields.sessionId ?? null,
      fields.headline ?? null,
      fields.body ?? null,
    );
    return rows[0]!.id.toString();
  }

  async function activity(input: Record<string, unknown> = {}): Promise<GetActivityOutput> {
    return (await runtime.call("get_activity", input)) as GetActivityOutput;
  }

  describe("filtering", () => {
    it("narrows to the named event types and excludes the others", async () => {
      const itemId = await createItem("types", "area-web");
      const noteId = await writeEvent({ itemId, type: "note" });
      const checkpointId = await writeEvent({ itemId, type: "checkpoint" });
      const claimId = await writeEvent({ itemId, type: "claim" });

      const result = await activity({ itemId: [itemId], type: ["note", "claim"] });
      const ids = result.events.map((e) => e.id);
      expect(ids).toContain(noteId);
      expect(ids).toContain(claimId);
      // The assertion that makes this about filtering rather than ordering:
      // a filter dropped entirely would still return the two above.
      expect(ids).not.toContain(checkpointId);
    });

    it("narrows by actor type and by actor id independently", async () => {
      const itemId = await createItem("actors", "area-web");
      const byAgent = await writeEvent({ itemId, actorType: "agent", actorId: "crew-a" });
      const byOtherAgent = await writeEvent({ itemId, actorType: "agent", actorId: "crew-b" });
      const bySystem = await writeEvent({ itemId, actorType: "system", actorId: "sweeper" });

      const agents = await activity({ itemId: [itemId], actorType: ["agent"] });
      expect(agents.events.map((e) => e.id).sort()).toEqual([byAgent, byOtherAgent].sort());
      expect(agents.events.map((e) => e.id)).not.toContain(bySystem);

      // `actorId` cuts *within* one actor type, so this proves the two
      // filters are separate conditions rather than one doing both jobs.
      const one = await activity({ itemId: [itemId], actorId: ["crew-a"] });
      expect(one.events.map((e) => e.id)).toEqual([byAgent]);
    });

    it("narrows by the item's area, which lives on the item and not the event", async () => {
      const webItem = await createItem("web work", "area-web");
      const infraItem = await createItem("infra work", "area-infra");
      const webEvent = await writeEvent({ itemId: webItem, actorId: "area-probe" });
      const infraEvent = await writeEvent({ itemId: infraItem, actorId: "area-probe" });

      const result = await activity({ actorId: ["area-probe"], area: ["area-web"] });
      const ids = result.events.map((e) => e.id);
      expect(ids).toContain(webEvent);
      expect(ids).not.toContain(infraEvent);
      // The area is reported back, so a reader can see what matched without
      // resolving the item themselves.
      expect(result.events[0]!.itemArea).toBe("area-web");
    });

    it("excludes item-less events when an area is named, and includes them otherwise", async () => {
      // The documented consequence of the area filter being a join. An
      // event with no item belongs to no area, so "show me this area" must
      // not include it — but nothing else should exclude it.
      const orphan = await writeEvent({ itemId: null, actorId: "orphan-probe" });

      const unfiltered = await activity({ actorId: ["orphan-probe"] });
      expect(unfiltered.events.map((e) => e.id)).toContain(orphan);
      expect(unfiltered.events[0]!.itemId).toBeNull();
      expect(unfiltered.events[0]!.itemArea).toBeNull();

      const byArea = await activity({ actorId: ["orphan-probe"], area: ["area-web"] });
      expect(byArea.events.map((e) => e.id)).not.toContain(orphan);
    });

    it("narrows by session, which is what session detail reads through", async () => {
      const itemId = await createItem("sessions", "area-web");
      const mine = await writeEvent({ itemId, sessionId: "sess-mine" });
      const theirs = await writeEvent({ itemId, sessionId: "sess-theirs" });

      const result = await activity({ sessionId: ["sess-mine"] });
      const ids = result.events.map((e) => e.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
    });

    it("applies two filters together as a conjunction, not a union", async () => {
      // A filter builder that appended with OR, or that let the last
      // condition overwrite the first, would pass every single-filter case
      // above and fail only here.
      const itemId = await createItem("conjunction", "area-web");
      const both = await writeEvent({ itemId, type: "note", actorId: "conj-a" });
      const typeOnly = await writeEvent({ itemId, type: "note", actorId: "conj-b" });
      const actorOnly = await writeEvent({ itemId, type: "claim", actorId: "conj-a" });

      const result = await activity({ type: ["note"], actorId: ["conj-a"] });
      const ids = result.events.map((e) => e.id);
      expect(ids).toContain(both);
      expect(ids).not.toContain(typeOnly);
      expect(ids).not.toContain(actorOnly);
    });

    it("refuses an event type the database does not know", async () => {
      // The type filter is not a hard-coded enum copy (it would go stale as
      // the ledger gains types), so the refusal comes from the cast. What
      // matters is that an unknown name is refused rather than silently
      // matching nothing, which would read as "nothing happened".
      await expect(activity({ type: ["not_a_real_event_type"] })).rejects.toThrow();
    });
  });

  describe("paging", () => {
    it("walks backwards through the ledger without repeating or skipping a row", async () => {
      const itemId = await createItem("paging", "area-web");
      const written: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        written.push(await writeEvent({ itemId, actorId: "pager" }));
      }
      const newestFirst = [...written].reverse();

      const first = await activity({ actorId: ["pager"], limit: 2 });
      expect(first.events.map((e) => e.id)).toEqual(newestFirst.slice(0, 2));
      expect(first.nextCursor).toBe(newestFirst[1]);

      const second = await activity({ actorId: ["pager"], limit: 2, cursor: first.nextCursor! });
      expect(second.events.map((e) => e.id)).toEqual(newestFirst.slice(2, 4));

      const third = await activity({ actorId: ["pager"], limit: 2, cursor: second.nextCursor! });
      expect(third.events.map((e) => e.id)).toEqual(newestFirst.slice(4, 5));
      // The last page is known to be last because one row beyond it was
      // asked for and did not come back — not inferred from its length.
      expect(third.nextCursor).toBeNull();
    });

    it("reports no cursor when the page is exactly the last row", async () => {
      // The boundary an off-by-one gets wrong: a page holding precisely
      // `limit` rows with nothing after it must still say it is the end.
      const itemId = await createItem("exact page", "area-web");
      const a = await writeEvent({ itemId, actorId: "exact" });
      const b = await writeEvent({ itemId, actorId: "exact" });

      const result = await activity({ actorId: ["exact"], limit: 2 });
      expect(result.events.map((e) => e.id)).toEqual([b, a]);
      expect(result.nextCursor).toBeNull();
    });

    it("refuses a malformed cursor by naming the field rather than failing internally", async () => {
      await expect(activity({ cursor: "not-a-number" })).rejects.toThrow(/cursor/i);
    });
  });

  describe("the slim default and the full opt-in", () => {
    it("omits payload and body by default and returns them on request", async () => {
      const itemId = await createItem("projection", "area-web");
      await writeEvent({ itemId, actorId: "proj", body: "the prose" });

      const slim = await activity({ actorId: ["proj"] });
      expect(slim.events[0]).not.toHaveProperty("payload");
      expect(slim.events[0]).not.toHaveProperty("body");

      const full = await activity({ actorId: ["proj"], full: true });
      expect(full.events[0]).toMatchObject({ body: "the prose", payload: { k: "v" } });
    });

    it("resolves each event's item title so a row reads without a second call", async () => {
      const itemId = await createItem("a readable title", "area-web");
      await writeEvent({ itemId, actorId: "titles" });

      const result = await activity({ actorId: ["titles"] });
      expect(result.events[0]!.itemTitle).toBe("a readable title");
    });
  });

  describe("seen state", () => {
    it("reports read state for the named profile only", async () => {
      const mine = await createPerson("person-mine");
      await createPerson("person-other");
      const itemId = await createItem("seen", "area-web");
      const eventId = await writeEvent({ itemId, actorId: "seen-probe" });

      await runtime.call("mark_event_seen", { eventId, personId: mine });

      const asMe = await activity({ actorId: ["seen-probe"], personId: mine });
      expect(asMe.events[0]!.seen).toBe(true);

      // The same event, read as someone else, is unseen — per-person read
      // state is the point of `event_seen`'s composite key.
      const asThem = await activity({ actorId: ["seen-probe"], personId: "person-other" });
      expect(asThem.events[0]!.seen).toBe(false);

      // And with nobody named, "seen" is false rather than a stranger's answer.
      const anonymous = await activity({ actorId: ["seen-probe"] });
      expect(anonymous.events[0]!.seen).toBe(false);
    });

    it("drops seen events when unseenOnly is set", async () => {
      const person = await createPerson("person-unseen");
      const itemId = await createItem("unseen", "area-web");
      const read = await writeEvent({ itemId, actorId: "unseen-probe" });
      const unread = await writeEvent({ itemId, actorId: "unseen-probe" });
      await runtime.call("mark_event_seen", { eventId: read, personId: person });

      const result = await activity({
        actorId: ["unseen-probe"],
        personId: person,
        unseenOnly: true,
      });
      const ids = result.events.map((e) => e.id);
      expect(ids).toContain(unread);
      expect(ids).not.toContain(read);
    });

    it("ignores unseenOnly when no profile is named rather than filtering everything", async () => {
      // "Unseen by nobody in particular" is not a question with an answer.
      // Filtering on it would either return everything or nothing depending
      // on how the SQL was written; returning everything, unfiltered, is the
      // honest reading and matches what `seen: false` reports alongside.
      const itemId = await createItem("no profile", "area-web");
      const eventId = await writeEvent({ itemId, actorId: "noprofile-probe" });
      await createPerson("person-irrelevant");
      await runtime.call("mark_event_seen", { eventId, personId: "person-irrelevant" });

      const result = await activity({ actorId: ["noprofile-probe"], unseenOnly: true });
      expect(result.events.map((e) => e.id)).toContain(eventId);
    });
  });
});
