// Minting idempotency against a real Postgres — MILESTONES.md #63,
// DECISIONS.md §13.
//
// **This file has to hold a real database connection and cannot be faked.**
// The property under test — "two concurrent scans of the same source mint
// exactly one item" — is a property of how Postgres arbitrates a unique
// index between two open transactions. An in-memory fake would be testing
// the fake's own map semantics, would pass whether or not the constraint
// exists, and would therefore assert nothing about the behaviour that
// actually matters.
//
// The mutation each test is written to survive is named in its own comment.
// The one that matters most: making the dedup non-atomic (deleting the
// unique index, or reducing `mintOnce` to a plain check-then-insert)
// must turn "mints once under concurrency" red. A fixture that only ever
// mints serially cannot detect that at all, so the concurrent tests below
// genuinely overlap two transactions rather than awaiting one after the
// other.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findItemsFromPath,
  findMintedItem,
  isUniqueViolation,
  mintOnce,
} from "@/lib/minting/mint-once";
import {
  formatSourceRef,
  hashSourceContent,
  normaliseSourcePath,
  parseSourceRef,
  sourcePathOf,
} from "@/lib/minting/source-ref";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const AREA_ID = "minting-test-area";

/** Inserts the row a minted item's foreign keys need. */
async function seedArea(prisma: PrismaClient): Promise<void> {
  await prisma.area.upsert({
    where: { id: AREA_ID },
    update: {},
    create: { id: AREA_ID, displayName: "Minting test area" },
  });
}

/**
 * The insert a scan performs, reduced to the columns that matter here.
 *
 * `state` is a parameter because §13's "a file that yields nothing still
 * mints an item — a `wont-do` with a summary saying why" is one of the
 * cases under test, and it must go through the identical dedup path as a
 * productive mint.
 */
function mintItem(
  db: Pick<PrismaClient, "item">,
  sourceRef: string,
  state: "someday" | "wont_do" = "someday",
) {
  return db.item.create({
    data: {
      // `Item.id` is caller-supplied (`@id` with no default) — the service's
      // own create mints one with `crypto.randomUUID()` and this stands in
      // for that. Deliberately NOT derived from `sourceRef`: an id that
      // encoded the ref would make the primary key itself deduplicate, and
      // the test would then pass with the unique index gone.
      id: crypto.randomUUID(),
      kind: "task",
      title: `minted from ${sourceRef}`,
      body: "b",
      state,
      originType: "source",
      area: AREA_ID,
      mergeAuthority: "needs_approval",
      sourceRef,
    },
    select: { id: true },
  });
}

describeIfDb("minting idempotency (#63)", () => {
  const databaseName = scratchDatabaseName("minting");
  let prisma: PrismaClient;
  let databaseUrl: string;

  beforeAll(async () => {
    const { url, migrated } = await createMigratedScratchDatabase(testDatabaseUrl!, databaseName);
    databaseUrl = url;
    if (!migrated) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("npx", ["prisma", "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "inherit",
        shell: process.platform === "win32",
      });
    }
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedArea(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, databaseName);
  });

  describe("the constraint itself", () => {
    // Kills: dropping `Item_sourceRef_unique` from the migration. Without
    // the index both inserts succeed and this test fails — which is the
    // whole point of asserting on the database directly rather than only
    // through `mintOnce`, whose pre-check would mask a missing index in a
    // serial test.
    it("refuses a second row carrying the same sourceRef", async () => {
      const ref = formatSourceRef("constraint/a.md", hashSourceContent("one"));
      await mintItem(prisma, ref);

      await expect(mintItem(prisma, ref)).rejects.toSatisfy(isUniqueViolation);
      const count = await prisma.item.count({ where: { sourceRef: ref } });
      expect(count).toBe(1);
    });

    // Kills: making the unique index total instead of partial. Null
    // `sourceRef` is the overwhelming majority of rows — everything created
    // by a person or an agent directly — and a total index would collapse
    // them into one, taking the whole product down. This asserts the
    // `WHERE "sourceRef" IS NOT NULL` clause is really there.
    it("does not constrain rows with no sourceRef", async () => {
      const create = () =>
        prisma.item.create({
          data: {
            id: crypto.randomUUID(),
            kind: "task",
            title: "no source",
            body: "b",
            state: "someday",
            originType: "auto",
            area: AREA_ID,
            mergeAuthority: "needs_approval",
          },
          select: { id: true },
        });

      const first = await create();
      const second = await create();
      expect(first.id).not.toBe(second.id);
    });
  });

  describe("mintOnce", () => {
    // Kills: `mintOnce` returning `minted: true` unconditionally, or
    // dropping the pre-check AND the violation handler.
    it("mints on first sight and reports already-minted on the second", async () => {
      const ref = formatSourceRef("serial/a.md", hashSourceContent("one"));

      const first = await mintOnce(prisma, ref, (db) => mintItem(db as PrismaClient, ref));
      expect(first.minted).toBe(true);

      const second = await mintOnce(prisma, ref, (db) => mintItem(db as PrismaClient, ref));
      expect(second.minted).toBe(false);
      if (second.minted) throw new Error("unreachable");
      // The pre-check answered, so this is not a race and the id is known.
      expect(second.raced).toBe(false);
      expect(second.itemId).toBe(first.minted ? first.item.id : null);

      expect(await prisma.item.count({ where: { sourceRef: ref } })).toBe(1);
    });

    // Kills: swallowing every error as "already minted". A caller that
    // reported a failed mint as an idempotent no-op would drop work
    // silently, which is the failure mode the board row about dropped inbox
    // captures already records once.
    it("rethrows a failure that is not a duplicate", async () => {
      const ref = formatSourceRef("broken/a.md", hashSourceContent("one"));
      const boom = new Error("column does not exist");

      await expect(mintOnce(prisma, ref, () => Promise.reject(boom))).rejects.toThrow(
        "column does not exist",
      );
      expect(await prisma.item.count({ where: { sourceRef: ref } })).toBe(0);
    });

    // Kills: treating "yielded nothing" as a reason to skip the mint. §13
    // is explicit that this still mints, and that it dedupes identically —
    // otherwise an unproductive file is rescanned forever.
    it("dedupes a wont_do mint exactly as it dedupes a productive one", async () => {
      const ref = formatSourceRef("empty/a.md", hashSourceContent("nothing useful"));

      const first = await mintOnce(prisma, ref, (db) =>
        mintItem(db as PrismaClient, ref, "wont_do"),
      );
      const second = await mintOnce(prisma, ref, (db) =>
        mintItem(db as PrismaClient, ref, "wont_do"),
      );

      expect(first.minted).toBe(true);
      expect(second.minted).toBe(false);
      expect(await prisma.item.count({ where: { sourceRef: ref } })).toBe(1);
    });
  });

  describe("concurrency — the property the row is about", () => {
    /**
     * Several mints of the same ref, overlapping **by construction**.
     *
     * **Why a barrier and not just "start them all and await together".**
     * The naive version was tried first and is not reliable: whether any
     * attempt's pre-check runs before another's insert commits is decided
     * by connection-pool scheduling, and with the unique index mutated away
     * a 2-way and even a 4-way race still passed most runs — the first
     * insert usually landed before the second's pre-check read it, so the
     * pre-check masked the missing constraint. A test whose ability to fail
     * depends on that is a test that will one day stop failing.
     *
     * The barrier removes the luck. Every attempt runs its pre-check, then
     * waits until all of them have; only then is any insert issued. So
     * every attempt has provably observed "not minted" before the first row
     * exists, which is exactly the interleaving a check-then-insert gets
     * wrong, and the constraint is the only thing that can stop the
     * duplicate. `mintOnce`'s own pre-check still runs inside it — this
     * barrier surrounds the insert the caller supplies, and does not
     * replace or bypass any part of the code under test.
     *
     * ⚠️ **The barrier is bounded, and it has to be — the visibility
     * horizon is server-wide.** `pg_snapshot_xmin` is a property of the
     * server rather than of one database, so a transaction held open here
     * holds back rows for *every* suite running against the same Postgres,
     * including the ones that read through a horizon-bounded feed.
     *
     * This is measured, not theorised. With an unbounded barrier, three
     * full-suite runs each failed a *different* test in the bounded-read
     * suite with "never became visible within 15000ms", while this file
     * passed alone and the pristine baseline passed clean; skipping only
     * this describe block turned the whole suite green again. So the cap
     * has to be short relative to how long another suite is willing to wait
     * for a row — not merely finite.
     *
     * Releasing on the timeout does not weaken the test. It only means the
     * attempts were not all in flight at once, and the assertion that
     * exactly one row exists still holds — a run that degrades that way
     * proves less about interleaving but can never pass with a duplicate.
     * The mutation check is what keeps that honest: with the unique index
     * downgraded to a plain index, every concurrency test here still fails
     * on every run at this timeout.
     */
    const BARRIER_TIMEOUT_MS = 250;

    async function raceMints(ref: string, attempts: number) {
      let arrived = 0;
      let release!: () => void;
      const allArrived = new Promise<void>((resolve) => {
        release = resolve;
      });
      const timer = setTimeout(release, BARRIER_TIMEOUT_MS);

      const started = Array.from({ length: attempts }, () =>
        mintOnce(prisma, ref, async (db) => {
          // Arrive: `mintOnce` has already done its pre-check to get here.
          arrived += 1;
          if (arrived === attempts) release();
          await allArrived;
          return mintItem(db as PrismaClient, ref);
        }).catch((error: unknown) => ({ error }) as const),
      );
      try {
        return await Promise.all(started);
      } finally {
        // Never leave the timer pending — it would keep the process alive
        // past the suite and delay the run's exit.
        clearTimeout(timer);
      }
    }

    // THE row's headline property. Kills: dropping the unique index;
    // removing the violation handler (the loser would throw); reducing
    // `mintOnce`'s body to a bare check-then-insert.
    //
    // Two is the smallest real race, and with the barrier above it is a
    // sufficient one — every attempt has read "not minted" before any
    // insert runs, so the constraint is the only thing left that can
    // prevent the duplicate.
    it("mints exactly once when two scans race the same source", async () => {
      const ref = formatSourceRef("race/two.md", hashSourceContent("one"));

      const results = await raceMints(ref, 2);

      expect(results.filter((r) => "error" in r)).toEqual([]);
      const minted = results.filter((r) => "minted" in r && r.minted);
      expect(minted).toHaveLength(1);
      expect(await prisma.item.count({ where: { sourceRef: ref } })).toBe(1);
    });

    // The same property under more pressure, and the one that pins `raced`.
    // Kills: a `mintOnce` that reports every non-mint as `raced: false`,
    // which would make the losers indistinguishable from an ordinary
    // already-minted read in telemetry.
    it("mints exactly once when eight scans race, and the losers report the race", async () => {
      const ref = formatSourceRef("race/eight.md", hashSourceContent("one"));

      const results = await raceMints(ref, 8);

      expect(results.filter((r) => "error" in r)).toEqual([]);
      expect(results.filter((r) => "minted" in r && r.minted)).toHaveLength(1);
      expect(await prisma.item.count({ where: { sourceRef: ref } })).toBe(1);

      // At least one loser must have gone through the constraint rather
      // than the pre-check — otherwise the mints were not actually
      // concurrent and this file is not testing what it claims.
      const losers = results.filter((r) => "minted" in r && !r.minted);
      expect(losers.length).toBe(7);
      expect(losers.some((r) => "raced" in r && r.raced)).toBe(true);
    });

    // Kills: deduping on path alone rather than on `path@hash`. Two
    // different sources must not block each other.
    it("does not let one source's mint block a different source", async () => {
      const a = formatSourceRef("race/distinct-a.md", hashSourceContent("a"));
      const b = formatSourceRef("race/distinct-b.md", hashSourceContent("b"));

      const [first, second] = await Promise.all([
        mintOnce(prisma, a, (db) => mintItem(db as PrismaClient, a)),
        mintOnce(prisma, b, (db) => mintItem(db as PrismaClient, b)),
      ]);

      expect(first.minted).toBe(true);
      expect(second.minted).toBe(true);
    });
  });

  describe("across a restart, and across an edit", () => {
    // Kills: holding dedup state in a module-level Set/Map instead of in
    // the database.
    //
    // **A genuinely separate client is what makes this a restart test.** A
    // second `PrismaClient` over the same URL has its own connection pool
    // and its own process-local state, so anything `mintOnce` had cached
    // in-process is not shared with it. The first client mints; the second
    // — which has never seen this ref — must still refuse. An in-memory
    // guard passes the serial test above and fails this one.
    it("still refuses to re-mint through a separate client", async () => {
      const ref = formatSourceRef("restart/a.md", hashSourceContent("one"));
      await mintOnce(prisma, ref, (db) => mintItem(db as PrismaClient, ref));

      const reconnected = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        expect(await findMintedItem(reconnected, ref)).not.toBeNull();

        const again = await mintOnce(reconnected, ref, (db) => mintItem(db as PrismaClient, ref));
        expect(again.minted).toBe(false);
      } finally {
        await reconnected.$disconnect();
      }

      expect(await prisma.item.count({ where: { sourceRef: ref } })).toBe(1);
    });

    // Kills: deduping on path only, or truncating the hash out of the ref.
    // §13: "editing a file changes its hash, so it becomes eligible again".
    it("mints again once the file's content has changed", async () => {
      const path = "edited/a.md";
      const before = formatSourceRef(path, hashSourceContent("version one"));
      const after = formatSourceRef(path, hashSourceContent("version two"));
      expect(before).not.toBe(after);

      const firstMint = await mintOnce(prisma, before, (db) =>
        mintItem(db as PrismaClient, before),
      );
      const secondMint = await mintOnce(prisma, after, (db) => mintItem(db as PrismaClient, after));

      expect(firstMint.minted).toBe(true);
      expect(secondMint.minted).toBe(true);
    });

    // Kills: `findItemsFromPath` matching on equality, or forgetting the
    // prefix — §13's "the agent is told which items already came from the
    // previous version".
    it("reports every item minted from earlier versions of the same path", async () => {
      const path = "history/a.md";
      const v1 = formatSourceRef(path, hashSourceContent("v1"));
      const v2 = formatSourceRef(path, hashSourceContent("v2"));
      await mintOnce(prisma, v1, (db) => mintItem(db as PrismaClient, v1));
      await mintOnce(prisma, v2, (db) => mintItem(db as PrismaClient, v2));

      const found = await findItemsFromPath(prisma, path);
      expect(found.map((r) => r.sourceRef).sort()).toEqual([v1, v2].sort());
    });

    // Kills: dropping the LIKE escaping. A path containing `_` is a
    // single-character wildcard in LIKE, so without escaping this returns
    // the unrelated source too.
    it("does not treat wildcard characters in a path as wildcards", async () => {
      const literal = "wild/a_b.md";
      const decoy = "wild/axb.md";
      const literalRef = formatSourceRef(literal, hashSourceContent("l"));
      const decoyRef = formatSourceRef(decoy, hashSourceContent("d"));
      await mintOnce(prisma, literalRef, (db) => mintItem(db as PrismaClient, literalRef));
      await mintOnce(prisma, decoyRef, (db) => mintItem(db as PrismaClient, decoyRef));

      const found = await findItemsFromPath(prisma, literal);
      expect(found.map((r) => r.sourceRef)).toEqual([literalRef]);
    });
  });
});

// Pure — no database needed, so these run everywhere and are not gated.
describe("source refs (#63)", () => {
  // Kills: changing the separator, or dropping the hash from the format.
  it("round-trips a path and a hash", () => {
    const ref = formatSourceRef("a/b.md", "0123456789abcdef");
    expect(ref).toBe("a/b.md@0123456789abcdef");
    expect(parseSourceRef(ref)).toEqual({ path: "a/b.md", contentHash: "0123456789abcdef" });
  });

  // Kills: splitting on the FIRST separator. A path may legitimately
  // contain `@`, and splitting first would report a truncated path and a
  // hash that is really the rest of the path.
  it("splits at the last separator, so a path may contain one", () => {
    const ref = formatSourceRef("mail@host/note.md", "abcdef0123456789");
    expect(parseSourceRef(ref)).toEqual({
      path: "mail@host/note.md",
      contentHash: "abcdef0123456789",
    });
    expect(sourcePathOf(ref)).toBe("mail@host/note.md");
  });

  // Kills: accepting a malformed ref and returning an empty path or hash,
  // which a caller would then query on and match everything.
  it("refuses a string that is not a ref", () => {
    expect(parseSourceRef("no-separator")).toBeNull();
    expect(parseSourceRef("@leading")).toBeNull();
    expect(parseSourceRef("trailing@")).toBeNull();
  });

  // Kills: hashing the path instead of the content, or not hashing at all.
  it("hashes content, so identical bytes give identical refs and different bytes do not", () => {
    expect(hashSourceContent("one")).toBe(hashSourceContent("one"));
    expect(hashSourceContent("one")).not.toBe(hashSourceContent("two"));
    expect(hashSourceContent("one")).toHaveLength(16);
  });

  // Kills: dropping the separator normalisation. The same file reached from
  // two machines with different separators must dedupe against itself —
  // `machines.source_globs` exists precisely because layouts differ.
  it("normalises separators so the same file scanned two ways is one source", () => {
    expect(normaliseSourcePath("a\\b\\c.md")).toBe("a/b/c.md");
    expect(normaliseSourcePath("a//b/c.md")).toBe("a/b/c.md");
    expect(normaliseSourcePath("a/b/")).toBe("a/b");
    expect(normaliseSourcePath("/")).toBe("/");
  });
});
