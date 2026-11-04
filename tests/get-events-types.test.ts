// `get_events` with a `types` filter, against a real Postgres.
//
// The filter exists so a caller can read one kind of event in full without
// paying the heavy shape for the rest of the slice (the Standup overnight
// report reads `state_change` events this way). What needs a database is the
// part that lives in SQL: that `limit` counts only the types asked for, that
// the cursor still points at a real position, and that an unknown name is
// refused plainly instead of surfacing as a failed enum cast.
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
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_events types filter, against Postgres", () => {
  const dbName = scratchDatabaseName("events_types");
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

  async function createItem(title: string): Promise<string> {
    const item = (await runtime.call("create_item", {
      title,
      body: "x",
      area: "types-tests",
      originType: "auto",
    })) as { id: string };
    return item.id;
  }

  /** Appends a note through the real operation. */
  async function appendNote(itemId: string, body: string): Promise<string> {
    const appended = (await runtime.call("note", { itemId, body })) as { id: bigint | string };
    return String(appended.id);
  }

  /** Appends a system `nudge` event directly: a second type to filter against, with no extra setup. */
  async function appendNudge(itemId: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `INSERT INTO "Event" ("itemId", "actorType", "type", "payload", "body")
       VALUES ($1, 'system'::"ActorType", 'nudge'::"EventType", '{}'::jsonb, 'a nudge')
       RETURNING "id"`,
      itemId,
    );
    return rows[0]!.id.toString();
  }

  /** The horizon is server-wide, so wait until the row is visible to a bounded read. */
  async function waitForVisibility(eventId: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const feed = await getEvents({ since: String(BigInt(eventId) - 1n), limit: 1 });
      if (feed.events.some((event) => event.id === eventId)) return;
      if (Date.now() > deadline) {
        throw new Error(`Event ${eventId} never became visible within ${timeoutMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function getEvents(input: Record<string, unknown> = {}): Promise<GetEventsOutput> {
    return runtime.call("get_events", input) as Promise<GetEventsOutput>;
  }

  it("returns only the named type, and counts the limit over that type alone", async () => {
    const itemId = await createItem("Types filter item");
    const firstNote = await appendNote(itemId, "first");
    await appendNudge(itemId);
    await appendNudge(itemId);
    const secondNote = await appendNote(itemId, "second");
    await waitForVisibility(secondNote);

    const since = String(BigInt(firstNote) - 1n);
    const notes = await getEvents({ since, types: ["note"], limit: 2 });
    // Two notes came back even though two nudges sit between them: the limit
    // applies after the type filter, not before it.
    expect(notes.events.map((event) => event.type)).toEqual(["note", "note"]);
    expect(notes.events.map((event) => event.id)).toEqual([firstNote, secondNote]);
  }, 30_000);

  it("leaves other types out", async () => {
    const itemId = await createItem("Types exclusion item");
    const note = await appendNote(itemId, "a note");
    const nudge = await appendNudge(itemId);
    await waitForVisibility(nudge);

    const since = String(BigInt(note) - 1n);
    const nudges = await getEvents({ since, types: ["nudge"] });
    expect(nudges.events.length).toBeGreaterThan(0);
    expect(nudges.events.every((event) => event.type === "nudge")).toBe(true);
    expect(nudges.events.some((event) => event.id === note)).toBe(false);
  }, 30_000);

  it("accepts several types at once", async () => {
    const itemId = await createItem("Several types item");
    const note = await appendNote(itemId, "n");
    const nudge = await appendNudge(itemId);
    await waitForVisibility(nudge);

    const both = await getEvents({ since: String(BigInt(note) - 1n), types: ["note", "nudge"] });
    const ids = both.events.map((event) => event.id);
    expect(ids).toContain(note);
    expect(ids).toContain(nudge);
  }, 30_000);

  it("returns payload and body for the filtered type when full is set, and nothing for the rest", async () => {
    const itemId = await createItem("Full plus types item");
    const note = await appendNote(itemId, "carries a body");
    const nudge = await appendNudge(itemId);
    await waitForVisibility(nudge);

    const since = String(BigInt(note) - 1n);
    const full = await getEvents({ since, types: ["note"], full: true });
    const row = full.events.find((event) => event.id === note) as
      (GetEventsOutput["events"][number] & { body?: string | null }) | undefined;
    expect(row).toBeDefined();
    expect(row!.body).toBe("carries a body");
    expect(full.events.some((event) => event.id === nudge)).toBe(false);

    // Without `full`, the same filter stays slim.
    const slim = await getEvents({ since, types: ["note"] });
    expect("body" in slim.events[0]!).toBe(false);
    expect("payload" in slim.events[0]!).toBe(false);
  }, 30_000);

  it("keeps the cursor on the last row returned", async () => {
    const itemId = await createItem("Cursor item");
    const note = await appendNote(itemId, "n");
    await waitForVisibility(note);

    const page = await getEvents({ since: String(BigInt(note) - 1n), types: ["note"], limit: 1 });
    expect(page.cursor).toBe(page.events[page.events.length - 1]!.id);
  }, 30_000);

  it("refuses a name that is not an event type, naming it and listing the valid ones", async () => {
    await expect(getEvents({ types: ["state_change", "not_a_type"] })).rejects.toThrow(
      /Unknown event type: not_a_type\. Valid types are: .*state_change/,
    );
  }, 30_000);

  it("names every unknown type when more than one is wrong", async () => {
    await expect(getEvents({ types: ["nope", "also_nope"] })).rejects.toThrow(
      /Unknown event types: nope, also_nope\./,
    );
  }, 30_000);

  it("refuses an empty list rather than reading it as every type or none", async () => {
    await expect(getEvents({ types: [] })).rejects.toThrow();
  }, 30_000);
});
