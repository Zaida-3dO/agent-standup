// `doc_patch`, `doc_get` and `doc_list` — the document store, against a real
// Postgres.
//
// **What would make this file hollow.** A test that patches a key and reads
// it back passes against a store that ignores `ifRev`, rewrites the whole
// document on every patch, puts the value in the event, or returns a page
// bigger than the response limit — which is every property the store exists
// to have. So each case pins one of those, and names the edit to the source
// that breaks it. Runs against a real database because the claims are about
// row locks, upserts, keyset order and collation, none of which an in-memory
// model of Postgres proves. Skips without TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { MAX_RESPONSE_CHARS } from "@/lib/service/response-size";
import {
  MAX_DOC_KEYS_PER_PATCH,
  MAX_DOC_PAGE_CHARS,
  MAX_DOC_VALUE_CHARS,
} from "@/lib/service/operations/documents-shared";
import type { DocPatchOutput } from "@/lib/service/operations/doc-patch";
import type { DocGetOutput } from "@/lib/service/operations/doc-get";
import type { DocListOutput } from "@/lib/service/operations/doc-list";
import type { ItemDetailOutput } from "@/lib/service/operations/get-item-detail";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** `JSON.stringify` replacer: ledger ids are bigints, which it cannot serialise on its own. */
function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

interface ServiceError {
  code: string;
  guard?: string;
  fields?: string[];
  message: string;
  details?: Record<string, unknown>;
}

/** Runs `call` and returns the error it threw, failing the test if it did not throw. */
async function rejection(call: Promise<unknown>): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

interface EventRow {
  id: bigint;
  actorId: string | null;
  payload: {
    doc: string;
    rev: number;
    previousRev: number;
    keys: { key: string; op: string; bytes: number }[];
  };
  body: string | null;
  headline: string | null;
}

describeIfDb("documents, against Postgres", () => {
  const dbName = scratchDatabaseName("documents");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const scratch = await createMigratedScratchDatabase(testDatabaseUrl!, dbName);
    prisma = createTestPrismaClient(scratch.url);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    // Children first: the tree's self-reference has no cascade.
    await prisma.$executeRawUnsafe(`DELETE FROM "Item" WHERE "parentId" IS NOT NULL`);
    await prisma.item.deleteMany({});
  });

  async function seedItem(parentId: string | null = null, id: string = randomUUID()) {
    await prisma.item.create({
      data: {
        id,
        parentId,
        kind: parentId === null ? "project" : "task",
        title: `Item ${id.slice(0, 4)}`,
        body: "seeded for the document tests",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

  const call = <T>(
    name: string,
    input: unknown,
    caller: Record<string, unknown> = { actor: "tester" },
  ): Promise<T> => runtime.call(name as never, input, { caller } as never) as Promise<T>;

  const patch = (input: Record<string, unknown>) => call<DocPatchOutput>("doc_patch", input);
  const get = (input: Record<string, unknown>) => call<DocGetOutput>("doc_get", input);
  const list = (input: Record<string, unknown>) => call<DocListOutput>("doc_list", input);

  async function docEvents(itemId: string): Promise<EventRow[]> {
    return prisma.$queryRawUnsafe<EventRow[]>(
      `SELECT "id", "actorId", "payload", "body", "headline" FROM "Event"
       WHERE "itemId" = $1 AND "type" = 'doc_change' ORDER BY "id"`,
      itemId,
    );
  }

  async function entryCount(itemId: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS "n" FROM "ItemDocEntry" WHERE "itemId" = $1`,
      itemId,
    );
    return Number(rows[0]!.n);
  }

  /** A JSON string value whose serialised form is exactly `chars` long. */
  const sized = (chars: number): string => "x".repeat(chars - 2);

  describe("doc_patch — what one patch writes", () => {
    it("writes one entry and one small event for a one-key patch", async () => {
      // Killed by writing the whole document per patch (more than one row), or
      // by appending an event per key, or by dropping the event.
      const itemId = await seedItem();
      const result = await patch({ itemId, doc: "progress", set: { meta: { title: "Plan" } } });

      expect(result).toMatchObject({
        itemId,
        doc: "progress",
        rev: 1,
        changed: true,
        keys: [{ key: "meta", op: "created" }],
      });
      expect(await entryCount(itemId)).toBe(1);

      const events = await docEvents(itemId);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        doc: "progress",
        rev: 1,
        previousRev: 0,
        keys: [{ key: "meta", op: "created" }],
      });
      expect(result.eventId).toBe(events[0]!.id.toString());
      // Small: a few hundred characters however big the value is.
      expect(JSON.stringify(events[0]!.payload).length).toBeLessThan(300);
    });

    it("keeps the event small however many keys a patch names", async () => {
      // 100 keys of 200 characters would be about 25,000 characters if listed
      // in full. Killed by listing every key, or by not cutting the names.
      const itemId = await seedItem();
      const set: Record<string, number> = {};
      for (let n = 0; n < MAX_DOC_KEYS_PER_PATCH; n += 1) {
        set[`${String(n).padStart(3, "0")}${"k".repeat(197)}`] = n;
      }
      const result = await patch({ itemId, doc: "progress", set });

      // The reply still lists every key, in full.
      expect(result.keys).toHaveLength(MAX_DOC_KEYS_PER_PATCH);
      expect(result.keys[0]!.key).toHaveLength(200);

      const events = await docEvents(itemId);
      const payload = events[0]!.payload as EventRow["payload"] & { keysOmitted?: number };
      expect(JSON.stringify(payload).length).toBeLessThan(5000);
      expect(payload.keys).toHaveLength(25);
      expect(payload.keysOmitted).toBe(75);
      expect(payload.keys.every((entry) => entry.key.length <= 100)).toBe(true);
    });

    it("says nothing about omitted keys when every key is listed", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      const payload = (await docEvents(itemId))[0]!.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty("keysOmitted");
    });

    it("never puts a value in the event, whatever the value", async () => {
      // The property the ledger's readers rely on. Killed by adding `value`
      // (or the whole patch) to the event payload, or the value to its body.
      const itemId = await seedItem();
      const secret = "SENTINEL-value-that-must-not-reach-the-ledger";
      await patch({
        itemId,
        doc: "progress",
        set: { a: secret, b: { nested: [secret, secret] }, c: sized(5000) },
      });
      await patch({ itemId, doc: "progress", set: { a: `${secret}-changed` }, delete: ["c"] });

      const events = await docEvents(itemId);
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(JSON.stringify(event, bigintToString)).not.toContain("SENTINEL");
        expect(event.body).toBeNull();
        expect(event.headline).toBeNull();
      }
      // Sizes, not contents: the 5,000-character value is reported by its size.
      const created = events[0]!.payload.keys.find((entry) => entry.key === "c");
      expect(created!.bytes).toBe(5000);
      // And no event of any type on the item carries it.
      const all = await prisma.$queryRawUnsafe<{ payload: unknown }[]>(
        `SELECT "payload" FROM "Event" WHERE "itemId" = $1`,
        itemId,
      );
      expect(JSON.stringify(all, bigintToString)).not.toContain("SENTINEL");
    });

    it("changes only the keys it names and leaves every other key alone", async () => {
      // Killed by an implementation that overwrites the document with the patch.
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1, b: 2, c: 3 } });
      const second = await patch({ itemId, doc: "progress", set: { b: 20 } });

      expect(second.rev).toBe(2);
      expect(second.keys).toEqual([{ key: "b", op: "updated", bytes: 2 }]);
      const read = await get({ itemId, doc: "progress" });
      expect(read.entries.map((entry) => [entry.key, entry.value, entry.rev])).toEqual([
        ["a", 1, 1],
        ["b", 20, 2],
        ["c", 3, 1],
      ]);
    });

    it("stores any JSON value, null included, and returns it unchanged", async () => {
      const itemId = await seedItem();
      const values = {
        nothing: null,
        flag: false,
        zero: 0,
        text: "héllo — 日本語",
        list: [1, "two", { three: 3 }],
        deep: { a: { b: { c: [] } } },
      };
      await patch({ itemId, doc: "progress", set: values });
      const read = await get({ itemId, doc: "progress" });
      expect(Object.fromEntries(read.entries.map((entry) => [entry.key, entry.value]))).toEqual(
        values,
      );
    });

    it("attributes the entry and the event to the caller", async () => {
      const itemId = await seedItem();
      await call("doc_patch", { itemId, doc: "progress", set: { a: 1 } }, { actor: "agent-a" });
      const read = await get({ itemId, doc: "progress" });
      expect(read.entries[0]!.updatedBy).toBe("agent-a");
      expect((await docEvents(itemId))[0]!.actorId).toBe("agent-a");
    });

    it("accepts a short id and writes to the one item it identifies", async () => {
      const itemId = await seedItem();
      const result = await patch({ itemId: itemId.slice(0, 8), doc: "progress", set: { a: 1 } });
      expect(result.itemId).toBe(itemId);
      expect(await entryCount(itemId)).toBe(1);
    });

    it("writes nothing, bumps nothing and records nothing when nothing would change", async () => {
      // Killed by dropping the "same value" test (every patch then bumps and
      // logs), or by comparing JSON text instead of jsonb (key order below).
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: { x: 1, y: 2 } } });
      const again = await patch({
        itemId,
        doc: "progress",
        set: { a: { y: 2, x: 1 } },
        delete: ["never-existed"],
      });

      expect(again).toMatchObject({ changed: false, rev: 1, keys: [], eventId: null });
      expect(await docEvents(itemId)).toHaveLength(1);
      expect((await get({ itemId, doc: "progress" })).rev).toBe(1);
    });
  });

  describe("doc_patch — ifRev and the revision", () => {
    it("starts a document at revision 0 and counts one per changing patch", async () => {
      const itemId = await seedItem();
      expect((await get({ itemId, doc: "progress" })).rev).toBe(0);
      expect((await patch({ itemId, doc: "progress", set: { a: 1 } })).rev).toBe(1);
      expect((await patch({ itemId, doc: "progress", set: { a: 2 } })).rev).toBe(2);
      expect((await get({ itemId, doc: "progress" })).rev).toBe(2);
    });

    it("accepts a patch made against the current revision", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 }, ifRev: 0 });
      const next = await patch({ itemId, doc: "progress", set: { a: 2 }, ifRev: 1 });
      expect(next.rev).toBe(2);
    });

    it("refuses the second of two patches to the SAME key made against one revision, and writes nothing", async () => {
      // The reason `ifRev` exists. Killed by ignoring `ifRev`, or by checking
      // it only when the document already has entries.
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      const seen = (await get({ itemId, doc: "progress" })).rev;

      await patch({ itemId, doc: "progress", set: { a: "first writer" }, ifRev: seen });
      const clash = await rejection(
        patch({ itemId, doc: "progress", set: { a: "second writer", b: 2 }, ifRev: seen }),
      );

      expect(clash.code).toBe("conflict");
      expect(clash.fields).toEqual(["ifRev"]);
      // Plain: names the revision it is at, the key, and what to do.
      expect(clash.message).toContain(`revision ${seen + 1}`);
      expect(clash.message).toContain('"a"');
      expect(clash.message).toContain("action get");
      expect(clash.details).toEqual({ currentRev: seen + 1, ifRev: seen, keys: ["a"] });

      // The loser left no trace: its value, its other key, its event.
      const read = await get({ itemId, doc: "progress" });
      expect(read.rev).toBe(seen + 1);
      expect(read.entries.map((entry) => [entry.key, entry.value])).toEqual([
        ["a", "first writer"],
      ]);
      expect(await docEvents(itemId)).toHaveLength(2);
    });

    it("lets two patches to DIFFERENT keys against one revision both succeed", async () => {
      // The reason the check is per key. Parallel sessions each own a session
      // key; a whole-document comparison would refuse the second of them on
      // every overlap. Killed by reverting to the whole-document comparison.
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { base: 1 } });
      const seen = (await get({ itemId, doc: "progress" })).rev;

      const first = await patch({ itemId, doc: "progress", set: { "session-a": 1 }, ifRev: seen });
      const second = await patch({ itemId, doc: "progress", set: { "session-b": 1 }, ifRev: seen });

      expect(first.rev).toBe(seen + 1);
      expect(second.rev).toBe(seen + 2);
      const read = await get({ itemId, doc: "progress" });
      expect(read.rev).toBe(seen + 2);
      expect(read.entries.map((entry) => entry.key)).toEqual(["base", "session-a", "session-b"]);
    });

    it("names every clashing key, and only those", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1, b: 1, c: 1 } });
      const seen = (await get({ itemId, doc: "progress" })).rev;
      await patch({ itemId, doc: "progress", set: { a: 2, c: 2 } });

      const clash = await rejection(
        patch({ itemId, doc: "progress", set: { a: 3, b: 3 }, delete: ["c"], ifRev: seen }),
      );
      expect(clash.code).toBe("conflict");
      expect((clash.details as { keys: string[] }).keys).toEqual(["a", "c"]);
      expect(clash.message).toContain('"a"');
      expect(clash.message).toContain('"c"');
      expect(clash.message).not.toContain('"b"');
      // Nothing was written, not even the unclashed key.
      const read = await get({ itemId, doc: "progress" });
      expect(read.entries.map((entry) => [entry.key, entry.value])).toEqual([
        ["a", 2],
        ["b", 1],
        ["c", 2],
      ]);
    });

    it("refuses a delete of a key written after ifRev", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1, other: 1 } });
      const seen = (await get({ itemId, doc: "progress" })).rev;
      await patch({ itemId, doc: "progress", set: { a: 2 } });

      const clash = await rejection(patch({ itemId, doc: "progress", delete: ["a"], ifRev: seen }));
      expect(clash.code).toBe("conflict");
      expect((clash.details as { keys: string[] }).keys).toEqual(["a"]);
      expect((await get({ itemId, doc: "progress", keys: ["a"] })).entries).toHaveLength(1);

      // A delete of an untouched key is fine under the same ifRev.
      const ok = await patch({ itemId, doc: "progress", delete: ["other"], ifRev: seen });
      expect(ok.changed).toBe(true);
    });

    it("refuses an ifRev ahead of the document's current revision", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      const clash = await rejection(
        patch({ itemId, doc: "progress", set: { fresh: 1 }, ifRev: 5 }),
      );
      expect(clash.code).toBe("conflict");
      expect(clash.fields).toEqual(["ifRev"]);
      expect(clash.message).toContain("does not exist yet");
      expect(clash.details).toEqual({ currentRev: 1, ifRev: 5, keys: [] });
      expect((await get({ itemId, doc: "progress" })).rev).toBe(1);
    });

    it("does not clash on a key nobody has written, whatever else has moved", async () => {
      // A neighbour's write to another key is not a clash. Killed by always
      // refusing when the document has moved on.
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { other: 1 } });
      const ok = await patch({ itemId, doc: "progress", set: { mine: 1 }, ifRev: 0 });
      expect(ok.rev).toBe(2);
    });

    it("treats a document nobody has written as revision 0, so a later ifRev is ahead of it", async () => {
      const itemId = await seedItem();
      const clash = await rejection(patch({ itemId, doc: "progress", set: { a: 1 }, ifRev: 3 }));
      expect(clash.code).toBe("conflict");
      expect(await entryCount(itemId)).toBe(0);
      expect(await docEvents(itemId)).toHaveLength(0);
      // And revision 0 is accepted on it.
      expect((await patch({ itemId, doc: "progress", set: { a: 1 }, ifRev: 0 })).rev).toBe(1);
    });

    it("lets exactly one of two concurrent patches to the same key against one revision win", async () => {
      // The lock, not just the comparison. Killed by dropping `FOR UPDATE`:
      // both would read the same stored revision and both would write.
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 0 } });
      const outcomes = await Promise.allSettled([
        patch({ itemId, doc: "progress", set: { a: "one" }, ifRev: 1 }),
        patch({ itemId, doc: "progress", set: { a: "two" }, ifRev: 1 }),
      ]);
      const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const lost = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason.code).toBe("conflict");
      expect((await get({ itemId, doc: "progress" })).rev).toBe(2);
    });

    it("lets two concurrent patches to different keys against one revision both win", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { base: 0 } });
      const outcomes = await Promise.allSettled([
        patch({ itemId, doc: "progress", set: { a: "one" }, ifRev: 1 }),
        patch({ itemId, doc: "progress", set: { b: "two" }, ifRev: 1 }),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await get({ itemId, doc: "progress" })).rev).toBe(3);
    });

    it("applies concurrent patches without ifRev one after the other, losing none", async () => {
      // Each writer owns its own key and sends no `ifRev`; none may be lost
      // and the revision must count every one.
      const itemId = await seedItem();
      await Promise.all(
        [1, 2, 3, 4, 5].map((n) => patch({ itemId, doc: "progress", set: { [`k${n}`]: n } })),
      );
      const read = await get({ itemId, doc: "progress" });
      expect(read.rev).toBe(5);
      expect(read.entries.map((entry) => entry.key)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
      expect(new Set(read.entries.map((entry) => entry.rev)).size).toBe(5);
    });

    it("keeps documents independent: one document's revision is not another's", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      await patch({ itemId, doc: "progress", set: { a: 2 } });
      expect((await patch({ itemId, doc: "plan", set: { a: 1 } })).rev).toBe(1);
      expect((await get({ itemId, doc: "plan" })).entries).toHaveLength(1);
    });
  });

  describe("doc_patch — delete", () => {
    it("removes the named keys and records the delete with the size it removed", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: "12345", b: 2 } });
      const result = await patch({ itemId, doc: "progress", delete: ["a"] });

      expect(result).toMatchObject({ changed: true, rev: 2, keys: [{ key: "a", op: "deleted" }] });
      expect(result.keys[0]!.bytes).toBe(7); // "12345" with its quotes
      expect((await get({ itemId, doc: "progress" })).entries.map((e) => e.key)).toEqual(["b"]);
      const events = await docEvents(itemId);
      expect(events[1]!.payload.keys).toEqual([{ key: "a", op: "deleted", bytes: 7 }]);
    });

    it("does a set and a delete of different keys in one patch, as one revision and one event", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { old: 1 } });
      const result = await patch({ itemId, doc: "progress", set: { fresh: 1 }, delete: ["old"] });
      expect(result.rev).toBe(2);
      expect(result.keys.map((k) => [k.key, k.op])).toEqual([
        ["fresh", "created"],
        ["old", "deleted"],
      ]);
      expect(await docEvents(itemId)).toHaveLength(2);
    });

    it("ignores a key that is not there, and does not bump the revision for it", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      const result = await patch({ itemId, doc: "progress", delete: ["ghost"] });
      expect(result).toMatchObject({ changed: false, rev: 1, eventId: null });
    });

    it("never lowers the revision, even when the newest key is deleted or the document is emptied", async () => {
      // Killed by deriving the revision from the entries (`max(rev)`).
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      await patch({ itemId, doc: "progress", set: { b: 1 } });
      await patch({ itemId, doc: "progress", delete: ["b"] });
      expect((await get({ itemId, doc: "progress" })).rev).toBe(3);

      await patch({ itemId, doc: "progress", delete: ["a"] });
      const emptied = await get({ itemId, doc: "progress" });
      expect(emptied.entries).toEqual([]);
      expect(emptied.rev).toBe(4);
      // The revision a reader saw is still the document's own: one ahead of
      // the real count would be accepted if the revision had dropped to 2.
      const ahead = await rejection(patch({ itemId, doc: "progress", set: { c: 1 }, ifRev: 5 }));
      expect(ahead.code).toBe("conflict");
      expect((await patch({ itemId, doc: "progress", set: { c: 1 }, ifRev: 4 })).rev).toBe(5);
    });

    it("does not detect a key that someone else deleted after ifRev (a known limit: no tombstones)", async () => {
      // Pinned so the limit is a stated behaviour, not an accident: a deleted
      // entry leaves no row to carry a revision, so a stale writer re-creating
      // the key is allowed.
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      const seen = (await get({ itemId, doc: "progress" })).rev;
      await patch({ itemId, doc: "progress", delete: ["a"] });
      const result = await patch({ itemId, doc: "progress", set: { a: "again" }, ifRev: seen });
      expect(result.keys).toEqual([{ key: "a", op: "created", bytes: 7 }]);
    });
  });

  describe("doc_patch — what it refuses", () => {
    it("refuses an unknown item, and creates nothing for it", async () => {
      const missing = randomUUID();
      const error = await rejection(patch({ itemId: missing, doc: "progress", set: { a: 1 } }));
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["itemId"]);
      expect(error.message).toContain(missing);
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS "n" FROM "ItemDoc"`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
      expect(
        (await rejection(patch({ itemId: "no-such-item", doc: "progress", set: { a: 1 } }))).code,
      ).toBe("not_found");
    });

    it("refuses a patch that names no key", async () => {
      const itemId = await seedItem();
      for (const input of [{}, { set: {} }, { delete: [] }, { set: {}, delete: [] }]) {
        const error = await rejection(patch({ itemId, doc: "progress", ...input }));
        expect(error.code).toBe("invalid_input");
        expect(error.fields).toEqual(["set", "delete"]);
      }
      expect(await docEvents(itemId)).toHaveLength(0);
    });

    it("refuses a key that is both set and deleted", async () => {
      const itemId = await seedItem();
      const error = await rejection(
        patch({ itemId, doc: "progress", set: { a: 1 }, delete: ["a"] }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain('"a"');
      expect(await entryCount(itemId)).toBe(0);
    });

    it("refuses more keys than one patch may carry, naming the limit", async () => {
      const itemId = await seedItem();
      const set = Object.fromEntries(
        Array.from({ length: MAX_DOC_KEYS_PER_PATCH + 1 }, (_, n) => [`k${n}`, n]),
      );
      const error = await rejection(patch({ itemId, doc: "progress", set }));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain(String(MAX_DOC_KEYS_PER_PATCH));
      // At the limit it is accepted.
      const ok = Object.fromEntries(
        Array.from({ length: MAX_DOC_KEYS_PER_PATCH }, (_, n) => [`k${n}`, n]),
      );
      expect((await patch({ itemId, doc: "progress", set: ok })).keys).toHaveLength(
        MAX_DOC_KEYS_PER_PATCH,
      );
    });

    it("refuses a value over the entry limit, plainly, and accepts one exactly at it", async () => {
      // The limit is what lets any entry share a page with its key. Killed by
      // raising or removing it.
      const itemId = await seedItem();
      const error = await rejection(
        patch({ itemId, doc: "progress", set: { big: sized(MAX_DOC_VALUE_CHARS + 1) } }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["set.big"]);
      expect(error.message).toContain('"big"');
      expect(error.message).toContain("Split it across several keys");
      expect(await entryCount(itemId)).toBe(0);

      await patch({ itemId, doc: "progress", set: { fits: sized(MAX_DOC_VALUE_CHARS) } });
      expect(await entryCount(itemId)).toBe(1);
    });

    it("refuses bad names and keys without touching the database", async () => {
      const itemId = await seedItem();
      const badDocs = ["Progress", "1plan", "has space", "", "a".repeat(49)];
      for (const doc of badDocs) {
        const error = await rejection(patch({ itemId, doc, set: { a: 1 } }));
        expect(error.code, `doc ${JSON.stringify(doc)}`).toBe("invalid_input");
      }
      const badKeys = ["", " lead", "has space", "-lead", "a|b", "a".repeat(201), "line\nbreak"];
      for (const key of badKeys) {
        const error = await rejection(patch({ itemId, doc: "progress", set: { [key]: 1 } }));
        expect(error.code, `key ${JSON.stringify(key)}`).toBe("invalid_input");
      }
      expect(await entryCount(itemId)).toBe(0);
    });

    it("refuses a value that is not JSON, and one a document cannot store", async () => {
      const itemId = await seedItem();
      const notJson = await rejection(patch({ itemId, doc: "progress", set: { a: undefined } }));
      expect(notJson.code).toBe("invalid_input");
      expect(notJson.message).toContain("`delete`");

      const nul = await rejection(patch({ itemId, doc: "progress", set: { a: "bad\u0000text" } }));
      expect(nul.code).toBe("invalid_input");
      expect(nul.fields).toEqual(["set.a"]);
      expect(await entryCount(itemId)).toBe(0);
    });

    it("accepts a string that merely contains a backslash followed by u0000, and refuses a NUL after a backslash", async () => {
      // The six characters backslash-u-0-0-0-0 typed as text are legitimate;
      // only a real NUL is not. Killed by testing the serialised JSON for
      // the six characters wherever they appear.
      const itemId = await seedItem();
      const literal = String.raw`path\u0000end`;
      const ok = await patch({ itemId, doc: "progress", set: { a: literal } });
      expect(ok.changed).toBe(true);
      expect((await get({ itemId, doc: "progress" })).entries[0]!.value).toBe(literal);

      // A backslash and then a real NUL: the backslash is escaped and the NUL
      // still follows it, so it is refused.
      const nul = await rejection(
        patch({ itemId, doc: "progress", set: { b: "back\\\u0000slash" } }),
      );
      expect(nul.code).toBe("invalid_input");
      expect(nul.fields).toEqual(["set.b"]);
    });

    it("refuses an ifRev that is not a whole non-negative number, and unknown fields", async () => {
      const itemId = await seedItem();
      for (const ifRev of [-1, 1.5, "1", null]) {
        const error = await rejection(patch({ itemId, doc: "progress", set: { a: 1 }, ifRev }));
        expect(error.code, `ifRev ${JSON.stringify(ifRev)}`).toBe("invalid_input");
      }
      const extra = await rejection(patch({ itemId, doc: "progress", set: { a: 1 }, upsert: 1 }));
      expect(extra.code).toBe("invalid_input");
    });
  });

  describe("doc_get", () => {
    it("reads all keys in byte order, with the revision and who wrote each", async () => {
      // Byte order puts "B" before "a"; a locale collation would not.
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1, B: 2, c_: 3, "10": 4, "9": 5 } });
      const read = await get({ itemId, doc: "progress" });
      expect(read.entries.map((e) => e.key)).toEqual(["10", "9", "B", "a", "c_"]);
      expect(read.rev).toBe(1);
      expect(read.nextCursor).toBeNull();
      expect(read.missing).toEqual([]);
      expect(read.entries[0]).toMatchObject({ rev: 1, updatedBy: "tester" });
      expect(read.entries[0]!.updatedAt).toEqual(expect.any(String));
    });

    it("reads just the named keys and reports the ones that hold nothing", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1, b: 2, c: 3 } });
      const read = await get({ itemId, doc: "progress", keys: ["c", "a", "nope", "c"] });
      expect(read.entries.map((e) => e.key)).toEqual(["a", "c"]);
      expect(read.missing).toEqual(["nope"]);
    });

    it("reads the keys under a prefix, taking the prefix literally", async () => {
      // `_` and `%` are LIKE wildcards; a prefix match built on LIKE would
      // return `sxy` for the prefix `s_`.
      const itemId = await seedItem();
      await patch({
        itemId,
        doc: "progress",
        set: { meta: 1, s_1: 1, s_2: 2, sxy: 3, t_1: 4, "s.dot": 5 },
      });
      const underscored = await get({ itemId, doc: "progress", prefix: "s_" });
      expect(underscored.entries.map((e) => e.key)).toEqual(["s_1", "s_2"]);
      expect((await get({ itemId, doc: "progress", prefix: "meta" })).entries).toHaveLength(1);
      expect((await get({ itemId, doc: "progress", prefix: "zzz" })).entries).toEqual([]);
    });

    it("refuses keys and prefix together", async () => {
      const itemId = await seedItem();
      const error = await rejection(get({ itemId, doc: "progress", keys: ["a"], prefix: "a" }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["keys", "prefix"]);
    });

    it("answers revision 0 and no entries for a document nobody has written, not an error", async () => {
      const itemId = await seedItem();
      expect(await get({ itemId, doc: "progress" })).toMatchObject({
        rev: 0,
        entries: [],
        nextCursor: null,
      });
    });

    it("refuses an unknown item", async () => {
      const error = await rejection(get({ itemId: randomUUID(), doc: "progress" }));
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["itemId"]);
    });

    it("pages by limit with a cursor that visits every entry exactly once", async () => {
      // Killed by an off-by-one in the keyset (a repeat or a skip at each seam)
      // or by a cursor that restarts from the beginning.
      const itemId = await seedItem();
      const set = Object.fromEntries(
        Array.from({ length: 11 }, (_, n) => [`k${String(n).padStart(2, "0")}`, n]),
      );
      await patch({ itemId, doc: "progress", set });

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await get({
          itemId,
          doc: "progress",
          limit: 4,
          ...(cursor ? { cursor } : {}),
        });
        pages += 1;
        expect(page.entries.length).toBeLessThanOrEqual(4);
        seen.push(...page.entries.map((e) => e.key));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual(Object.keys(set));
    });

    it("does not claim more when the last page is exactly full", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1, b: 2, c: 3, d: 4 } });
      const page = await get({ itemId, doc: "progress", limit: 4 });
      expect(page.entries).toHaveLength(4);
      expect(page.nextCursor).toBeNull();
    });

    it("returns an empty page, not the first page again, for a cursor past the end", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1, b: 2 } });
      const page = await get({ itemId, doc: "progress", cursor: "zzz" });
      expect(page.entries).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it("cuts a page by size, not only by count, and says there is more", async () => {
      // Three 20,000-character entries do not fit one 50,000-character page:
      // the page is two entries, shorter than `limit`, and still has more.
      // Killed by ignoring the budget (one page of three) or by reporting
      // `nextCursor: null` because the page was shorter than the limit.
      const itemId = await seedItem();
      await patch({
        itemId,
        doc: "progress",
        set: { a: sized(20_000), b: sized(20_000), c: sized(20_000) },
      });

      const first = await get({ itemId, doc: "progress" });
      expect(first.entries.map((e) => e.key)).toEqual(["a", "b"]);
      expect(first.nextCursor).toBe("b");
      expect(JSON.stringify(first.entries).length).toBeLessThanOrEqual(MAX_DOC_PAGE_CHARS);

      const second = await get({ itemId, doc: "progress", cursor: first.nextCursor! });
      expect(second.entries.map((e) => e.key)).toEqual(["c"]);
      expect(second.nextCursor).toBeNull();
    });

    it("returns every page under the response-size limit on the surface that doubles it", async () => {
      // The largest entries a document may hold, on a transport whose result
      // is delivered twice. Walks the whole document through the real guard:
      // a page that did not fit would be refused, not truncated.
      const itemId = await seedItem();
      const set = Object.fromEntries(
        Array.from({ length: 6 }, (_, n) => [`big${n}`, sized(MAX_DOC_VALUE_CHARS)]),
      );
      await patch({ itemId, doc: "progress", set });

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<DocGetOutput>(
          "doc_get",
          { itemId, doc: "progress", ...(cursor ? { cursor } : {}) },
          { actor: "tester", transport: "mcp-http" },
        );
        expect(JSON.stringify(page).length * 2).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
        // Never an empty page that still claims more: it would never end.
        expect(page.entries.length).toBeGreaterThan(0);
        seen.push(...page.entries.map((e) => e.key));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toEqual(Object.keys(set));
    });
  });

  describe("doc_list", () => {
    async function family() {
      const parent = await seedItem();
      const childA = await seedItem(parent);
      const childB = await seedItem(parent);
      return { parent, childA, childB };
    }

    it("returns the document's entries across the children, each tagged with its child", async () => {
      const { parent, childA, childB } = await family();
      await patch({ itemId: childA, doc: "progress", set: { meta: "a-meta", s1: "a-s1" } });
      await patch({ itemId: childB, doc: "progress", set: { meta: "b-meta" } });

      const result = await list({ parentId: parent, doc: "progress" });
      expect(result.parentId).toBe(parent);
      expect(result.nextCursor).toBeNull();
      const rows = result.entries.map((e) => [e.itemId, e.key, e.value]);
      expect(rows).toHaveLength(3);
      expect(rows).toEqual(
        expect.arrayContaining([
          [childA, "meta", "a-meta"],
          [childA, "s1", "a-s1"],
          [childB, "meta", "b-meta"],
        ]),
      );
      // Ordered by child, then key.
      const order = result.entries.map((e) => `${e.itemId}|${e.key}`);
      expect(order).toEqual([...order].sort());
      expect(result.entries[0]).toMatchObject({ rev: 1, updatedBy: "tester" });
    });

    it("reads only the named document, only direct children, and only this parent's", async () => {
      // Killed by dropping the doc filter, walking the subtree, or joining on
      // the wrong side.
      const { parent, childA } = await family();
      const grandchild = await seedItem(childA);
      const other = await seedItem();
      const strangerChild = await seedItem(other);
      await patch({ itemId: childA, doc: "progress", set: { a: 1 } });
      await patch({ itemId: childA, doc: "plan", set: { not: "this document" } });
      await patch({ itemId: grandchild, doc: "progress", set: { deep: 1 } });
      await patch({ itemId: strangerChild, doc: "progress", set: { other: 1 } });
      await patch({ itemId: parent, doc: "progress", set: { own: 1 } });

      const result = await list({ parentId: parent, doc: "progress" });
      expect(result.entries.map((e) => [e.itemId, e.key])).toEqual([[childA, "a"]]);
    });

    it("leaves out archived children", async () => {
      const { parent, childA, childB } = await family();
      await patch({ itemId: childA, doc: "progress", set: { a: 1 } });
      await patch({ itemId: childB, doc: "progress", set: { b: 1 } });
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "archivedAt" = CURRENT_TIMESTAMP, "archivedReason" = 'duplicate' WHERE "id" = $1`,
        childB,
      );
      const result = await list({ parentId: parent, doc: "progress" });
      expect(result.entries.map((e) => e.itemId)).toEqual([childA]);
    });

    it("is empty for a parent with no children or no such document", async () => {
      const { parent } = await family();
      expect(await list({ parentId: parent, doc: "progress" })).toMatchObject({
        entries: [],
        nextCursor: null,
      });
      const leaf = await seedItem();
      expect((await list({ parentId: leaf, doc: "progress" })).entries).toEqual([]);
    });

    it("refuses an unknown parent", async () => {
      const error = await rejection(list({ parentId: randomUUID(), doc: "progress" }));
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["parentId"]);
    });

    it("refuses a cursor it did not issue", async () => {
      const { parent } = await family();
      for (const cursor of ["nonsense", "|key", "item|"]) {
        const error = await rejection(list({ parentId: parent, doc: "progress", cursor }));
        expect(error.code, cursor).toBe("invalid_input");
        expect(error.fields).toEqual(["cursor"]);
      }
    });

    it("pages across children and keys, visiting every entry exactly once", async () => {
      // Seams fall both inside one child's keys and between two children, so
      // a keyset on only one of the two columns drops or repeats a row.
      const parent = await seedItem();
      const children = [await seedItem(parent), await seedItem(parent), await seedItem(parent)];
      const expected: string[] = [];
      for (const child of children) {
        await patch({ itemId: child, doc: "progress", set: { a: 1, b: 2, c: 3 } });
        for (const key of ["a", "b", "c"]) expected.push(`${child}|${key}`);
      }
      expected.sort();

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list({
          parentId: parent,
          doc: "progress",
          limit: 4,
          ...(cursor ? { cursor } : {}),
        });
        pages += 1;
        expect(page.entries.length).toBeLessThanOrEqual(4);
        seen.push(...page.entries.map((e) => `${e.itemId}|${e.key}`));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
    });

    it("pages under the response-size limit when the children hold large entries", async () => {
      const parent = await seedItem();
      const children = [await seedItem(parent), await seedItem(parent)];
      for (const child of children) {
        await patch({
          itemId: child,
          doc: "progress",
          set: { x: sized(MAX_DOC_VALUE_CHARS), y: sized(MAX_DOC_VALUE_CHARS) },
        });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await call<DocListOutput>(
          "doc_list",
          { parentId: parent, doc: "progress", ...(cursor ? { cursor } : {}) },
          { actor: "tester", transport: "mcp-http" },
        );
        pages += 1;
        expect(JSON.stringify(page).length * 2).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
        expect(page.entries.length).toBeGreaterThan(0);
        seen.push(...page.entries.map((e) => `${e.itemId}|${e.key}`));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      // Four ~40,000-character entries cannot fit one 50,000-character page.
      expect(pages).toBeGreaterThan(1);
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
    });
  });

  describe("documents stay out of the item reads", () => {
    it("get_item, in every depth, carries no document and no value", async () => {
      const itemId = await seedItem();
      const secret = "SENTINEL-document-value";
      await patch({ itemId, doc: "progress", set: { a: secret } });

      for (const full of [false, true, "item"]) {
        const item = await call<unknown>("get_item", { id: itemId, full });
        expect(JSON.stringify(item), `full: ${String(full)}`).not.toContain("SENTINEL");
      }
    });

    it("get_item_detail summarises each document by name, count and size, never a value", async () => {
      const itemId = await seedItem();
      const secret = "SENTINEL-document-value";
      await patch({ itemId, doc: "progress", set: { a: secret, b: 12345 } });
      await patch({ itemId, doc: "plan", set: { only: true } });

      const detail = await call<ItemDetailOutput>("get_item_detail", { id: itemId });
      expect(detail.documents).toEqual([
        { doc: "plan", entries: 1, bytes: 4 },
        // "SENTINEL-document-value" is 23 characters, plus two quotes; 12345 is 5.
        { doc: "progress", entries: 2, bytes: 25 + 5 },
      ]);
      expect(JSON.stringify(detail)).not.toContain("SENTINEL");
    });

    it("reports no documents for an item with none, and none for a document emptied by deletes", async () => {
      const itemId = await seedItem();
      expect((await call<ItemDetailOutput>("get_item_detail", { id: itemId })).documents).toEqual(
        [],
      );
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      await patch({ itemId, doc: "progress", delete: ["a"] });
      expect((await call<ItemDetailOutput>("get_item_detail", { id: itemId })).documents).toEqual(
        [],
      );
    });

    it("removes a document with its item", async () => {
      const itemId = await seedItem();
      await patch({ itemId, doc: "progress", set: { a: 1 } });
      await prisma.event.deleteMany({});
      await prisma.item.delete({ where: { id: itemId } });
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT (SELECT COUNT(*) FROM "ItemDoc") + (SELECT COUNT(*) FROM "ItemDocEntry") AS "n"`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });
});
