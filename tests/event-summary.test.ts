// A `field_change` event records a short summary instead of the values when
// either side is large, so one edit of a big field cannot put tens of
// thousands of characters in the ledger. Small values keep `{field, from, to}`.
//
// No database: `recordFieldChanges` is driven through a fake transaction
// handle that captures the payload it was asked to insert, so the assertions
// are about what would be stored.
import { describe, expect, it } from "vitest";
import {
  FIELD_CHANGE_INLINE_LIMIT,
  SUMMARY_MAX_KEYS,
  SUMMARY_MAX_KEY_LENGTH,
  canonicalJson,
  fieldChangePayload,
  isOversizedChange,
  serialisedSize,
  shortHash,
  summariseFieldChange,
} from "@/lib/event-summary";
import { recordFieldChanges } from "@/lib/events";
import type { TransactionHandle } from "@/lib/service/context";

/** A string whose JSON form (with its two quotes) is exactly `size` characters. */
function stringOfSerialisedSize(size: number, fill = "a"): string {
  return fill.repeat(size - 2);
}

function fakeHandle(): { db: TransactionHandle; payloads: Record<string, unknown>[] } {
  const payloads: Record<string, unknown>[] = [];
  const db: TransactionHandle = {
    async $queryRawUnsafe<T>(_query: string, ...values: unknown[]): Promise<T> {
      // Parameter 7 of the INSERT in `insertEventRow` is the JSON payload.
      payloads.push(JSON.parse(values[6] as string) as Record<string, unknown>);
      return [{ id: BigInt(payloads.length), txId: 1n, ts: new Date(0) }] as T;
    },
    async $executeRawUnsafe(): Promise<number> {
      return 0;
    },
  };
  return { db, payloads };
}

describe("the size limit", () => {
  it("keeps a value exactly at the limit whole, and summarises one character over", () => {
    const atLimit = stringOfSerialisedSize(FIELD_CHANGE_INLINE_LIMIT);
    const overLimit = stringOfSerialisedSize(FIELD_CHANGE_INLINE_LIMIT + 1);
    expect(serialisedSize(atLimit)).toBe(FIELD_CHANGE_INLINE_LIMIT);
    expect(isOversizedChange("x", atLimit)).toBe(false);
    expect(isOversizedChange("x", overLimit)).toBe(true);
  });

  it("looks at either side, not only the new value", () => {
    const big = stringOfSerialisedSize(FIELD_CHANGE_INLINE_LIMIT + 50);
    expect(isOversizedChange(big, "small")).toBe(true);
    expect(isOversizedChange("small", big)).toBe(true);
  });

  it("measures an object by its serialised length, not its key count", () => {
    const manySmallKeys = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`k${i}`, "value-text"]),
    );
    expect(serialisedSize(manySmallKeys)).toBeGreaterThan(FIELD_CHANGE_INLINE_LIMIT);
    expect(isOversizedChange(null, manySmallKeys)).toBe(true);
    expect(isOversizedChange(null, { a: 1, b: 2 })).toBe(false);
  });
});

describe("fieldChangePayload", () => {
  it("keeps the plain {field, from, to} shape for small values", () => {
    expect(fieldChangePayload("priority", "P2", "P0")).toEqual({
      field: "priority",
      from: "P2",
      to: "P0",
    });
    expect(fieldChangePayload("customFields", { a: 1 }, { a: 2 })).toEqual({
      field: "customFields",
      from: { a: 1 },
      to: { a: 2 },
    });
  });

  it("records a summary, and neither value, for a large one", () => {
    const from = stringOfSerialisedSize(5000, "o");
    const to = stringOfSerialisedSize(5200, "n");
    const payload = fieldChangePayload("body", from, to) as unknown as Record<string, unknown>;
    expect(payload).toMatchObject({
      field: "body",
      summarised: true,
      changed: true,
      fromSize: 5000,
      toSize: 5200,
    });
    expect(payload).not.toHaveProperty("from");
    expect(payload).not.toHaveProperty("to");
    expect(JSON.stringify(payload)).not.toContain("oooo");
    expect(JSON.stringify(payload)).not.toContain("nnnn");
    expect(JSON.stringify(payload).length).toBeLessThan(500);
  });

  it("gives each side its own short hash, and the hash tells different values apart", () => {
    const a = stringOfSerialisedSize(3000, "a");
    const b = stringOfSerialisedSize(3000, "b");
    const payload = summariseFieldChange("body", a, b);
    expect(payload.fromHash).toMatch(/^[0-9a-f]{12}$/);
    expect(payload.toHash).toMatch(/^[0-9a-f]{12}$/);
    expect(payload.fromHash).not.toBe(payload.toHash);
    expect(payload.fromHash).toBe(shortHash(a));
  });

  it("does not let a body (a string) grow a keys list", () => {
    const payload = summariseFieldChange("body", "x", stringOfSerialisedSize(4000));
    expect(payload).not.toHaveProperty("keys");
  });
});

describe("hashing is by content, not by key order", () => {
  it("hashes the same object the same way whatever order its keys were written in", () => {
    expect(shortHash({ a: 1, b: { c: 2, d: 3 } })).toBe(shortHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("hashes arrays in order, because order is content there", () => {
    expect(shortHash([1, 2])).not.toBe(shortHash([2, 1]));
  });

  it("treats undefined as null, which is how the ledger stores it", () => {
    expect(shortHash(undefined)).toBe(shortHash(null));
    expect(serialisedSize(undefined)).toBe(4);
  });
});

describe("the changed keys of an object-valued field", () => {
  const big = (n: number) => "x".repeat(n);

  it("lists added, removed and changed keys with sizes, and leaves unchanged keys out", () => {
    const before = { kept: big(1500), edited: "old-value", gone: "bye" };
    const after = { kept: big(1500), edited: "new-value-longer", fresh: big(900) };
    const summary = summariseFieldChange("customFields", before, after);
    expect(summary.keys).toEqual([
      {
        key: "edited",
        change: "changed",
        fromSize: 11,
        toSize: 18,
        hash: shortHash("new-value-longer"),
      },
      { key: "fresh", change: "added", fromSize: null, toSize: 902, hash: shortHash(big(900)) },
      { key: "gone", change: "removed", fromSize: 5, toSize: null, hash: shortHash("bye") },
    ]);
    expect(summary.keys?.map((k) => k.key)).not.toContain("kept");
  });

  it("does not report a key whose value was rewritten to the same content", () => {
    const value = { nested: { a: 1, b: 2 } };
    const reordered = { nested: { b: 2, a: 1 } };
    const summary = summariseFieldChange(
      "customFields",
      { v: value, pad: big(2500) },
      {
        v: reordered,
        pad: big(2500),
        extra: 1,
      },
    );
    expect(summary.keys?.map((k) => k.key)).toEqual(["extra"]);
  });

  it("treats a null side as an empty object, so a first write lists every key as added", () => {
    const summary = summariseFieldChange("customFields", null, {
      progress: big(2600),
      meta: "m",
    });
    expect(summary.keys?.map((k) => `${k.key}:${k.change}`)).toEqual([
      "meta:added",
      "progress:added",
    ]);
  });

  it("lists no keys when one side is not an object", () => {
    expect(summariseFieldChange("customFields", [1, 2, 3], { a: big(2500) })).not.toHaveProperty(
      "keys",
    );
    expect(summariseFieldChange("customFields", "text", { a: big(2500) })).not.toHaveProperty(
      "keys",
    );
    expect(summariseFieldChange("areas", null, [big(2500)])).not.toHaveProperty("keys");
  });

  it("caps the list and says how many keys it left out, so the summary stays small", () => {
    const after = Object.fromEntries(
      Array.from({ length: SUMMARY_MAX_KEYS + 10 }, (_, i) => [
        `key-${String(i).padStart(3, "0")}`,
        i,
      ]),
    );
    const summary = summariseFieldChange(
      "customFields",
      { pad: big(2500) },
      { pad: big(2500), ...after },
    );
    expect(summary.keys).toHaveLength(SUMMARY_MAX_KEYS);
    expect(summary.keysOmitted).toBe(10);
    expect(JSON.stringify(summary).length).toBeLessThan(5000);
  });

  it("cuts a very long key name, so one odd key cannot grow the summary", () => {
    const longKey = "k".repeat(5000);
    const summary = summariseFieldChange(
      "customFields",
      { pad: big(2500) },
      {
        pad: big(2500),
        [longKey]: 1,
      },
    );
    expect(summary.keys?.[0]?.key).toHaveLength(SUMMARY_MAX_KEY_LENGTH);
  });

  it("omits keysOmitted when nothing was left out", () => {
    const summary = summariseFieldChange("customFields", null, { a: big(2600) });
    expect(summary).not.toHaveProperty("keysOmitted");
  });
});

describe("recordFieldChanges writes the summary, not the value", () => {
  const actor = { actorType: "system" } as const;

  it("stores a small edit exactly as before", async () => {
    const { db, payloads } = fakeHandle();
    await recordFieldChanges(db, {
      itemId: "item-1",
      actor,
      before: { priority: "P2" },
      after: { priority: "P0" },
      fields: ["priority"],
    });
    expect(payloads).toEqual([{ field: "priority", from: "P2", to: "P0" }]);
  });

  it("stores a summary for a very large customFields edit, a few hundred characters long", async () => {
    const { db, payloads } = fakeHandle();
    const progress = (marker: string) => ({ sessions: marker.repeat(20000) });
    await recordFieldChanges(db, {
      itemId: "item-1",
      actor,
      before: { customFields: { progress: progress("a"), note: "same" } },
      after: { customFields: { progress: progress("b"), note: "same" } },
      fields: ["customFields"],
    });
    expect(payloads).toHaveLength(1);
    const stored = JSON.stringify(payloads[0]);
    expect(stored.length).toBeLessThan(1000);
    expect(payloads[0]).toMatchObject({ field: "customFields", summarised: true, changed: true });
    expect(payloads[0]?.keys).toEqual([
      expect.objectContaining({ key: "progress", change: "changed" }),
    ]);
    expect(stored).not.toContain("aaaaaaaa");
    expect(stored).not.toContain("bbbbbbbb");
  });

  it("summarises only the field that is large; its neighbour in the same call stays whole", async () => {
    const { db, payloads } = fakeHandle();
    await recordFieldChanges(db, {
      itemId: "item-1",
      actor,
      before: { body: "short", priority: "P2" },
      after: { body: "x".repeat(6000), priority: "P1" },
      fields: ["body", "priority"],
    });
    expect(payloads[0]).toMatchObject({ field: "body", summarised: true });
    expect(payloads[1]).toEqual({ field: "priority", from: "P2", to: "P1" });
  });

  it("still writes nothing for a large value that did not change", async () => {
    const { db, payloads } = fakeHandle();
    const same = { progress: "z".repeat(30000) };
    const written = await recordFieldChanges(db, {
      itemId: "item-1",
      actor,
      before: { customFields: same },
      after: { customFields: { ...same } },
      fields: ["customFields"],
    });
    expect(written).toEqual([]);
    expect(payloads).toEqual([]);
  });

  it("treats a missing side as null when summarising", async () => {
    const { db, payloads } = fakeHandle();
    await recordFieldChanges(db, {
      itemId: "item-1",
      actor,
      before: {},
      after: { body: "y".repeat(4000) },
      fields: ["body"],
    });
    expect(payloads[0]).toMatchObject({ fromSize: 4, toSize: 4002, summarised: true });
  });
});
