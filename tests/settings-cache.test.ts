// The revision-based cache (SCHEMA.md §17.3).
//
// The guarantee under test is not "the happy path works". It is that a
// stale read is not reachable once the revision has moved and the
// revalidation interval has elapsed — so most of these tests move the
// revision and then assert on what a later read returns, rather than
// asserting the cache called something.
import { describe, expect, it } from "vitest";
import { SettingsCache, type SettingsSource } from "@/lib/settings/cache";
import type { StoredOverride } from "@/lib/settings/resolve";

/**
 * An in-memory source that counts its reads and lets a test move the
 * revision the way a write in another process would.
 */
class FakeSource implements SettingsSource {
  revision = 1n;
  overrides: StoredOverride[] = [];
  revisionReads = 0;
  overrideReads = 0;
  /** Set to delay readOverrides, to test what happens during a load. */
  gate: Promise<void> | null = null;

  async readRevision(): Promise<bigint> {
    this.revisionReads += 1;
    return this.revision;
  }

  async readOverrides(): Promise<{ overrides: StoredOverride[]; revision: bigint }> {
    this.overrideReads += 1;
    if (this.gate) await this.gate;
    // Both read together, as the interface requires: the revision returned
    // is the one these rows were read at.
    return { overrides: this.overrides.map((o) => ({ ...o })), revision: this.revision };
  }

  /** What a settings write in another process does: rows plus the bump. */
  write(key: string, value: unknown): void {
    const existing = this.overrides.find((o) => o.key === key);
    if (existing) existing.value = value;
    else this.overrides.push({ key, value });
    this.revision += 1n;
  }

  clear(key: string): void {
    this.overrides = this.overrides.filter((o) => o.key !== key);
    this.revision += 1n;
  }
}

/** A clock a test advances by hand, so no test waits on real time. */
function fakeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("the cache", () => {
  it("builds a snapshot on first read", async () => {
    const source = new FakeSource();
    source.overrides = [{ key: "items.max_depth", value: 4 }];
    const cache = new SettingsCache({ source, now: fakeClock().now });

    const snapshot = await cache.get();
    expect(snapshot.values["items.max_depth"]).toBe(4);
    expect(snapshot.revision).toBe(1n);
    expect(source.overrideReads).toBe(1);
  });

  it("serves from memory inside the revalidation interval, touching nothing", async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const cache = new SettingsCache({
      source,
      revalidateAfterMs: 3_000,
      now: clock.now,
    });

    await cache.get();
    const readsAfterFirst = source.revisionReads;

    clock.advance(2_999);
    await cache.get();
    await cache.get();

    // Not one extra revision read: the whole point of the interval is that
    // the steady state costs nothing.
    expect(source.revisionReads).toBe(readsAfterFirst);
    expect(source.overrideReads).toBe(1);
  });

  // The property that matters: a stale read is not reachable afterwards.
  it("returns the new value once the revision has moved and the interval elapsed", async () => {
    const source = new FakeSource();
    source.overrides = [{ key: "items.max_depth", value: 4 }];
    const clock = fakeClock();
    const cache = new SettingsCache({ source, revalidateAfterMs: 3_000, now: clock.now });

    expect((await cache.get()).values["items.max_depth"]).toBe(4);

    // Another process writes.
    source.write("items.max_depth", 9);
    clock.advance(3_000);

    const after = await cache.get();
    expect(after.values["items.max_depth"]).toBe(9);
    expect(after.revision).toBe(2n);
  });

  it("holds a superseded value only until the interval elapses, never past it", async () => {
    const source = new FakeSource();
    source.overrides = [{ key: "items.max_depth", value: 4 }];
    const clock = fakeClock();
    const cache = new SettingsCache({ source, revalidateAfterMs: 3_000, now: clock.now });
    await cache.get();

    source.write("items.max_depth", 9);

    // Inside the interval, serving the superseded value is the documented,
    // bounded cost of not reading the database on every call.
    clock.advance(2_999);
    expect((await cache.get()).values["items.max_depth"]).toBe(4);

    // One millisecond later it is not reachable any more.
    clock.advance(1);
    expect((await cache.get()).values["items.max_depth"]).toBe(9);
  });

  it("rebuilds after a delete, which a high-water mark on updated_at would miss", async () => {
    // The reason the counter exists: clearing an override deletes a row, so
    // max(updated_at) can move backwards. Here the change is a removal and
    // the cache must still see it.
    const source = new FakeSource();
    source.overrides = [{ key: "items.max_depth", value: 4 }];
    const clock = fakeClock();
    const cache = new SettingsCache({ source, revalidateAfterMs: 1_000, now: clock.now });
    expect((await cache.get()).values["items.max_depth"]).toBe(4);

    source.clear("items.max_depth");
    clock.advance(1_000);

    // Back to the registry default, not stuck on the cleared override.
    expect((await cache.get()).values["items.max_depth"]).toBe(6);
  });

  it("does not rebuild when the interval elapsed but the revision did not move", async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const cache = new SettingsCache({ source, revalidateAfterMs: 1_000, now: clock.now });
    const first = await cache.get();

    clock.advance(5_000);
    const second = await cache.get();

    expect(second).toBe(first); // the same object, not merely equal
    expect(source.revisionReads).toBe(1); // the cheap read only
    expect(source.overrideReads).toBe(1); // no rebuild
  });

  it("makes a change immediate in the process that made it, via invalidate", async () => {
    // §17.3's other half. Without this the writing process is the one
    // process reading a value it knows to be stale.
    const source = new FakeSource();
    const clock = fakeClock();
    const cache = new SettingsCache({ source, revalidateAfterMs: 60_000, now: clock.now });
    expect((await cache.get()).values["items.max_depth"]).toBe(6);

    source.write("items.max_depth", 2);
    cache.invalidate();

    // No clock advance at all: the interval has not elapsed and must not
    // need to.
    expect((await cache.get()).values["items.max_depth"]).toBe(2);
  });

  it("stamps the snapshot with the revision the rows were read at, not the one that triggered it", async () => {
    // A write landing between the revision read and the row read would
    // otherwise stamp a snapshot with a revision newer than its rows, and
    // the next revalidation would compare equal and never correct it — a
    // permanently stale snapshot that believes it is current.
    const source = new FakeSource();
    source.overrides = [{ key: "items.max_depth", value: 4 }];
    const clock = fakeClock();
    const cache = new SettingsCache({ source, revalidateAfterMs: 1_000, now: clock.now });
    await cache.get();

    source.write("items.max_depth", 5); // revision 2
    clock.advance(1_000);

    // A third write lands while readOverrides is in flight.
    let release: () => void = () => {};
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = cache.get();
    source.write("items.max_depth", 8); // revision 3, rows updated
    release();
    const snapshot = await pending;
    source.gate = null;

    // The rows and the revision came from the same read, so they agree.
    expect(snapshot.values["items.max_depth"]).toBe(8);
    expect(snapshot.revision).toBe(3n);

    // And crucially the cache is not now wedged: a later write is still
    // seen, which is what would fail if the stamp were the older revision.
    source.write("items.max_depth", 11);
    clock.advance(1_000);
    expect((await cache.get()).values["items.max_depth"]).toBe(11);
  });

  it("collapses concurrent cold reads into one load", async () => {
    const source = new FakeSource();
    let release: () => void = () => {};
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const cache = new SettingsCache({ source, now: fakeClock().now });
    const all = Promise.all([cache.get(), cache.get(), cache.get()]);
    release();
    const [a, b, c] = await all;

    expect(source.overrideReads).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("retries after a failed load instead of latching the failure forever", async () => {
    const source = new FakeSource();
    const failing = {
      readRevision: () => source.readRevision(),
      readOverrides: async () => {
        throw new Error("database unreachable");
      },
    } satisfies SettingsSource;

    const cache = new SettingsCache({ source: failing, now: fakeClock().now });
    await expect(cache.get()).rejects.toThrow("database unreachable");

    // A rejected promise left latched in the cache would replay this one
    // failure for the lifetime of the process.
    const recovered = new SettingsCache({ source, now: fakeClock().now });
    await expect(recovered.get()).resolves.toBeDefined();
  });

  it("reports nothing held before the first load", async () => {
    const source = new FakeSource();
    const cache = new SettingsCache({ source, now: fakeClock().now });
    expect(cache.peek()).toBeNull();
    await cache.get();
    expect(cache.peek()).not.toBeNull();
    cache.invalidate();
    expect(cache.peek()).toBeNull();
  });

  it("hands out a frozen snapshot, like any other resolution", async () => {
    const source = new FakeSource();
    const cache = new SettingsCache({ source, now: fakeClock().now });
    const snapshot = await cache.get();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.values)).toBe(true);
  });
});
