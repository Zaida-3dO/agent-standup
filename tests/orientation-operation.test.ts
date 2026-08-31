// `orientation` against a real Postgres — SCHEMA.md §4, §19, §22,
// MILESTONES.md #28. Follows the same shape as tests/items-operations.test.ts:
// a real ServiceRuntime against a scratch database, because what this
// operation proves (visibility-horizon bounding, the checkpoint/event
// interplay, the actionable-child split) is exactly the kind of thing an
// in-memory double would decide by its own implementation rather than by
// what Postgres actually does.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem, type ClaimInput } from "@/lib/claims";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("orientation against Postgres", () => {
  const dbName = scratchDatabaseName("orientation_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function makeItem(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    return (await runtime.call("create_item", {
      title: "Orientation subject",
      body: "x",
      area: "orientation-area",
      originType: "auto",
      ...overrides,
    })) as { id: string };
  }

  async function appendCheckpoint(itemId: string, body: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Event" ("itemId", "actorType", "actorId", "type", "payload", "body")
       VALUES ($1, 'agent'::"ActorType", 'crew-member', 'checkpoint'::"EventType", '{}'::jsonb, $2)`,
      itemId,
      body,
    );
  }

  async function claim(input: ClaimInput) {
    return prisma.$transaction((tx) => claimItem(tx, input));
  }

  /**
   * Retries `orientation` until `whatChanged` is non-empty, or gives up.
   *
   * The visibility horizon (`events.ts` `visibilityHorizon`, SCHEMA.md §3)
   * is deliberately conservative: it holds a row back until the OLDEST
   * transaction concurrent with it anywhere on the Postgres server
   * finishes — and Postgres transaction ids are cluster-wide, not
   * per-database (confirmed directly: `SELECT txid_current()` against two
   * different databases on the same server returns consecutive values).
   * This suite runs its own scratch database, but shares the one running
   * Postgres server with every other DB-integration test file executing
   * concurrently in the same `vitest run` — including
   * `tests/events.test.ts`'s own "excludes a row written by a transaction
   * that has not yet committed" case and `tests/claims.test.ts`'s 25-round
   * concurrency races, both of which hold transactions open by design. A
   * long transaction elsewhere can therefore hold this suite's own horizon
   * back for a moment, exactly as `events.ts`'s own header documents
   * ("Cost: a row is held back... unless something holds a long
   * transaction open") — this is `readSinceBounded` behaving correctly
   * under real concurrency, not a defect in `orientation`. Polling is the
   * honest way to assert "eventually visible" against a bound that is
   * deliberately not "immediately visible".
   */
  async function orientationUntilChanged(
    itemId: string,
    input: { since?: string } = {},
  ): Promise<{
    checkpoint: { body: string } | null;
    whatChanged: readonly { type: string; payload: unknown; id: string }[];
  }> {
    // Up to ~30s total, polling every 200ms — sized for the WHOLE suite
    // running concurrently (46 files, several holding transactions open by
    // design), not just this file in isolation. A single held-open
    // transaction elsewhere on the same Postgres server can hold this
    // horizon back for longer than a short, fixed retry budget assumes.
    for (let attempt = 0; attempt < 150; attempt++) {
      const result = (await runtime.call("orientation", { itemId, ...input })) as {
        checkpoint: { body: string } | null;
        whatChanged: readonly { type: string; payload: unknown; id: string }[];
      };
      if (result.whatChanged.length > 0) return result;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `orientation's whatChanged for ${itemId} stayed empty after 150 retries (~30s) — ` +
        `a genuine bug, not just horizon lag.`,
    );
  }

  it("refuses an id that does not exist", async () => {
    const error = await runtime
      .call("orientation", { itemId: "does-not-exist" })
      .catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("not_found");
  });

  it("refuses a non-numeric `since` — the input schema's own regex, not a runtime crash", async () => {
    const item = await makeItem({ title: "Bad since" });
    // Mutation this catches, actually applied and confirmed locally: widen
    // the schema's `/^\d+$/` to `/^.+$/` (any character instead of only
    // digits) in orientation.ts — "not-a-number" then PASSES validation and
    // reaches `BigInt(input.since)` in the handler, which throws and
    // surfaces as `internal` instead of `invalid_input`. Confirms the
    // schema is what turns a malformed `since` into a clean rejection
    // rather than a crash.
    const error = await runtime
      .call("orientation", { itemId: item.id, since: "not-a-number" })
      .catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("invalid_input");
    expect((error as { fields: string[] }).fields).toContain("since");
  });

  it("checkpoint is null and whatChanged is exactly the create event when nothing else has happened", async () => {
    // Single-character mutation this test would catch: change the SQL's
    // `ORDER BY "id" DESC` to `ASC` in orientation.ts's checkpoint query —
    // this case has only one candidate row either way, so it would not
    // itself catch that; the ordering is instead proven by the two-
    // checkpoint case below. What THIS case catches: change `checkpoint`'s
    // initial value from `null` to `checkpointRow` unconditionally (i.e.
    // drop the `? ... : null` ternary) — with zero checkpoint rows,
    // `checkpointRows[0]` is `undefined`, and a version that skipped the
    // null-guard would read `undefined.id` and throw instead of
    // returning `null` cleanly.
    const item = await makeItem({ title: "No checkpoint yet" });
    const result = await orientationUntilChanged(item.id);
    expect(result.checkpoint).toBeNull();
    // create_item appends exactly one field_change event (SCHEMA.md §3) —
    // with no checkpoint, `since` defaults to 0, so it is the one thing
    // that "changed" since the beginning.
    expect(result.whatChanged).toHaveLength(1);
    expect(result.whatChanged[0]?.type).toBe("field_change");
  }, 35_000);

  it("returns the LATEST checkpoint when two exist, and bounds whatChanged to events after it", async () => {
    const item = await makeItem({ title: "Two checkpoints" });
    await appendCheckpoint(item.id, "first checkpoint");
    await appendCheckpoint(item.id, "second, latest checkpoint");
    // One more event after the latest checkpoint — this is what
    // `whatChanged` must contain when `since` is omitted (defaults to the
    // latest checkpoint's event id).
    await runtime.call("update_item", {
      id: item.id,
      title: "Renamed after latest checkpoint",
    });

    const result = await orientationUntilChanged(item.id);

    expect(result.checkpoint?.body).toBe("second, latest checkpoint");
    // Single-character mutation this catches: change `ORDER BY "id" DESC`
    // to `ASC` in the checkpoint query — that would return "first
    // checkpoint" instead, failing this exact assertion.
    expect(result.whatChanged).toHaveLength(1);
    expect(result.whatChanged[0]?.type).toBe("field_change");
    expect(result.whatChanged[0]?.payload).toMatchObject({ field: "title" });
  }, 35_000);

  it("whatChanged is genuinely empty — not an error — when nothing happened since the checkpoint", async () => {
    // The "nothing changed" case the task brief asks for explicitly,
    // alongside the "something changed" case above.
    const item = await makeItem({ title: "Quiet item" });
    await appendCheckpoint(item.id, "only checkpoint, nothing after it");

    const result = (await runtime.call("orientation", { itemId: item.id })) as {
      whatChanged: readonly unknown[];
    };
    expect(result.whatChanged).toEqual([]);
  });

  it("an explicit `since` overrides the checkpoint default", async () => {
    const item = await makeItem({ title: "Explicit since" });
    const first = await orientationUntilChanged(item.id);
    const createEventId = first.whatChanged[0]?.id;
    expect(createEventId).toBeDefined();

    await runtime.call("update_item", { id: item.id, title: "Edited" });

    // Passing the create event's own id as `since` should exclude the
    // create event itself and include only the later update.
    const result = await orientationUntilChanged(item.id, { since: createEventId });
    expect(result.whatChanged).toHaveLength(1);
    expect(result.whatChanged[0]?.payload).toMatchObject({ field: "title" });
  }, 35_000);

  it("open loops: an actionable child is reported actionable=true, a blocked child actionable=false", async () => {
    const parent = await makeItem({ title: "Parent with children" });
    const actionableChild = await makeItem({ title: "Still going", parentId: parent.id });
    const waitingChild = await makeItem({ title: "Waiting on someone", parentId: parent.id });
    // Move the second child straight to `blocked` — orientation reads
    // states, not transitions, so a direct write is fine here (row #27's
    // territory owns the transition path, not this one).
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = 'blocked'::"ItemState" WHERE "id" = $1`,
      waitingChild.id,
    );

    const result = (await runtime.call("orientation", { itemId: parent.id })) as {
      openLoops: { children: readonly { id: string; actionable: boolean }[] };
    };

    const byId = new Map(result.openLoops.children.map((c) => [c.id, c.actionable]));
    // Single-character mutation this catches: flip `!NON_ACTIONABLE_STATES.has(...)`
    // to drop the `!` in orientation.ts — every child would then report the
    // opposite of what it should, failing both assertions below.
    expect(byId.get(actionableChild.id)).toBe(true);
    expect(byId.get(waitingChild.id)).toBe(false);
  });

  it("open loops: an item with no Summary row reports an empty notDone list, not an error", async () => {
    const item = await makeItem({ title: "Never completed" });
    const result = (await runtime.call("orientation", { itemId: item.id })) as {
      openLoops: { notDone: readonly unknown[] };
    };
    expect(result.openLoops.notDone).toEqual([]);
  });

  it("open loops: reads notDone entries back from a real Summary row", async () => {
    const item = await makeItem({ title: "Has a summary" });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Summary" ("itemId", "shipped", "notDone", "userFacing", "watchFor", "finalState")
       VALUES ($1, '["done thing"]'::jsonb, $2::jsonb, false, '[]'::jsonb, '{}'::jsonb)`,
      item.id,
      JSON.stringify([{ text: "leftover work", reason: "descoped" }]),
    );

    const result = (await runtime.call("orientation", { itemId: item.id })) as {
      openLoops: { notDone: readonly { text: string; reason: string }[] };
    };
    expect(result.openLoops.notDone).toEqual([{ text: "leftover work", reason: "descoped" }]);
  });

  // ── Open loops as events (SCHEMA.md §3a) ───────────────────────────────
  //
  // The gap this closes: `Summary` is 1:1 with an item and written only at
  // completion, so before this an `executing` item could not carry an open
  // loop at all — and that is the state in which a session is most likely to
  // have one. The three sources are unioned into `openLoops`, never merged
  // into one list: they are different kinds of thing and call for different
  // responses.
  async function appendLoopEvent(
    itemId: string,
    type: "open_loop" | "open_loop_closed",
    payload: Record<string, unknown>,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Event" ("itemId", "actorType", "actorId", "type", "payload")
       VALUES ($1, 'agent'::"ActorType", 'crew-member', $2::"EventType", $3::jsonb)`,
      itemId,
      type,
      JSON.stringify(payload),
    );
  }

  function loopsOf(result: unknown): readonly { loopId: string; text: string }[] {
    return (result as { openLoops: { loops: readonly { loopId: string; text: string }[] } })
      .openLoops.loops;
  }

  it("open loops: an EXECUTING item with no Summary still reports its open loop", async () => {
    // The whole point of the change. Under the previous shape this item had
    // nowhere to put a loop, and orientation could only ever answer `[]`.
    const item = await makeItem({ title: "Mid-flight, carrying a loose end" });
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = 'executing'::"ItemState" WHERE "id" = $1`,
      item.id,
    );
    await appendLoopEvent(item.id, "open_loop", {
      loopId: "loop-cold-boot",
      text: "never checked what happens on a cold boot",
    });

    const result = await runtime.call("orientation", { itemId: item.id });
    expect(loopsOf(result)).toEqual([
      expect.objectContaining({
        loopId: "loop-cold-boot",
        text: "never checked what happens on a cold boot",
      }),
    ]);
    // And the Summary-derived list is untouched — union, not replace.
    expect((result as { openLoops: { notDone: readonly unknown[] } }).openLoops.notDone).toEqual(
      [],
    );
  });

  it("open loops: a closed loop is not reported", async () => {
    // The rejection half. Single-character mutation this catches: dropping
    // the closed-set filter in deriveOpenLoops.
    const item = await makeItem({ title: "Loop opened and closed" });
    await appendLoopEvent(item.id, "open_loop", { loopId: "loop-a", text: "the retry path" });
    await appendLoopEvent(item.id, "open_loop_closed", { loopId: "loop-a" });

    const result = await runtime.call("orientation", { itemId: item.id });
    expect(loopsOf(result)).toEqual([]);
  });

  it("open loops: closes only the loop named, leaving the others open", async () => {
    const item = await makeItem({ title: "Three loops, one closed" });
    await appendLoopEvent(item.id, "open_loop", { loopId: "loop-a", text: "a" });
    await appendLoopEvent(item.id, "open_loop", { loopId: "loop-b", text: "b" });
    await appendLoopEvent(item.id, "open_loop", { loopId: "loop-c", text: "c" });
    await appendLoopEvent(item.id, "open_loop_closed", { loopId: "loop-b" });

    const result = await runtime.call("orientation", { itemId: item.id });
    expect(loopsOf(result).map((l) => l.loopId)).toEqual(["loop-a", "loop-c"]);
  });

  it("open loops: reports a loop opened BEFORE the latest checkpoint", async () => {
    // Deliberately not scoped to `since`/the checkpoint cursor the way
    // `whatChanged` is. A loop that has survived several sessions is exactly
    // the one a resuming session most needs to be told about, and a
    // cursor-scoped read would hide it. Single-character mutation this
    // catches: reusing `whatChanged`'s bounded read for this query.
    const item = await makeItem({ title: "Old loop, newer checkpoint" });
    await appendLoopEvent(item.id, "open_loop", {
      loopId: "loop-old",
      text: "still unresolved from two sessions ago",
    });
    await appendCheckpoint(item.id, "picked this up fresh");

    const result = await runtime.call("orientation", { itemId: item.id });
    expect(loopsOf(result).map((l) => l.loopId)).toEqual(["loop-old"]);
  });

  it("open loops: an item with no loop events reports an empty list, not an error", async () => {
    const item = await makeItem({ title: "No loops at all" });
    const result = await runtime.call("orientation", { itemId: item.id });
    expect(loopsOf(result)).toEqual([]);
  });

  it("open loops: another item's loops are not reported against this one", async () => {
    // The query is item-scoped. Single-character mutation this catches:
    // dropping the `"itemId" = $1` predicate from the loop query — every
    // item in the database would then report every loop.
    const mine = await makeItem({ title: "Mine" });
    const theirs = await makeItem({ title: "Theirs" });
    await appendLoopEvent(theirs.id, "open_loop", { loopId: "loop-theirs", text: "not mine" });

    const result = await runtime.call("orientation", { itemId: mine.id });
    expect(loopsOf(result)).toEqual([]);
  });

  it("open loops: a checkpoint carrying a loop-shaped payload is not read as a loop", async () => {
    // The type filter is what distinguishes a loop from any other event that
    // happens to have a `loopId` in its payload.
    const item = await makeItem({ title: "Checkpoint that looks like a loop" });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Event" ("itemId", "actorType", "actorId", "type", "payload")
       VALUES ($1, 'agent'::"ActorType", 'crew-member', 'checkpoint'::"EventType", $2::jsonb)`,
      item.id,
      JSON.stringify({ loopId: "loop-fake", text: "not actually a loop" }),
    );

    const result = await runtime.call("orientation", { itemId: item.id });
    expect(loopsOf(result)).toEqual([]);
  });

  it("open loops: reports notDone AND loops together for a completed item that has both", async () => {
    // "Union, do not replace", asserted rather than assumed: the Summary
    // path and the event path both survive on the same item.
    const item = await makeItem({ title: "Has a summary and a live loop" });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Summary" ("itemId", "shipped", "notDone", "userFacing", "watchFor", "finalState")
       VALUES ($1, '["done thing"]'::jsonb, $2::jsonb, false, '[]'::jsonb, '{}'::jsonb)`,
      item.id,
      JSON.stringify([{ text: "leftover work", reason: "descoped" }]),
    );
    await appendLoopEvent(item.id, "open_loop", { loopId: "loop-live", text: "still open" });

    const result = (await runtime.call("orientation", { itemId: item.id })) as {
      openLoops: {
        notDone: readonly { text: string }[];
        loops: readonly { loopId: string }[];
      };
    };
    expect(result.openLoops.notDone).toEqual([{ text: "leftover work", reason: "descoped" }]);
    expect(result.openLoops.loops.map((l) => l.loopId)).toEqual(["loop-live"]);
  });

  it("crew: reports the live assignment on the item, and omits a released one", async () => {
    const item = await makeItem({ title: "Has crew" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "crew-member-a",
      sessionId: "session-orientation-crew-1",
      machine: "laptop",
    });

    const result = (await runtime.call("orientation", { itemId: item.id })) as {
      crew: readonly { sessionId: string; role: string }[];
    };
    expect(result.crew).toHaveLength(1);
    expect(result.crew[0]?.sessionId).toBe("session-orientation-crew-1");
    expect(result.crew[0]?.role).toBe("builder");

    // Release it, then confirm orientation omits it from crew — proves the
    // query reads `releasedAt IS NULL`, the live-assignment predicate,
    // rather than every assignment row ever written on the item.
    await prisma.$executeRawUnsafe(
      `UPDATE "Assignment" SET "releasedAt" = CURRENT_TIMESTAMP WHERE "itemId" = $1 AND "sessionId" = $2`,
      item.id,
      "session-orientation-crew-1",
    );
    const afterRelease = (await runtime.call("orientation", { itemId: item.id })) as {
      crew: readonly unknown[];
    };
    expect(afterRelease.crew).toEqual([]);
  });

  it("crew: reports MULTIPLE live assignments at once — an orchestrator and a builder together", async () => {
    const item = await makeItem({ title: "Multi-role crew" });
    await claim({
      itemId: item.id,
      role: "orchestrator",
      holderType: "agent",
      holderId: "crew-orchestrator",
      sessionId: "session-multi-orch",
      machine: "laptop",
    });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "crew-builder",
      sessionId: "session-multi-builder",
      parentSessionId: "session-multi-orch",
      rootSessionId: "session-multi-orch",
      machine: "laptop",
    });

    const result = (await runtime.call("orientation", { itemId: item.id })) as {
      crew: readonly { sessionId: string; role: string }[];
    };
    const roles = new Map(result.crew.map((a) => [a.sessionId, a.role]));
    expect(result.crew).toHaveLength(2);
    expect(roles.get("session-multi-orch")).toBe("orchestrator");
    expect(roles.get("session-multi-builder")).toBe("builder");
  });

  describe("truncation is announced, never silent", () => {
    /**
     * Reads `orientation` until at least `count` events are visible.
     *
     * Same reason as `orientationUntilChanged` above, and the same bound:
     * `readSinceBounded` holds a row back until the oldest transaction
     * concurrent with it anywhere on the Postgres SERVER commits, and this
     * suite shares that server with every other DB file in the run. A
     * truncation assertion needs a known number of events to be visible, so
     * waiting for them is the honest way to assert it — polling on the
     * PRECONDITION, never on the property under test, which is asserted once
     * below and must hold the first time it is read.
     */
    async function orientationWithAtLeast(
      itemId: string,
      count: number,
      input: Record<string, unknown> = {},
    ): Promise<{ whatChanged: readonly { id: string }[]; whatChangedTruncated: boolean }> {
      for (let attempt = 0; attempt < 150; attempt++) {
        const result = (await runtime.call("orientation", {
          itemId,
          since: "0",
          limit: 100,
          ...input,
        })) as { whatChanged: readonly { id: string }[]; whatChangedTruncated: boolean };
        if (result.whatChanged.length >= count) return result;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(
        `orientation for ${itemId} never showed ${count} events after ~30s — ` +
          `a genuine bug, not just horizon lag.`,
      );
    }

    /**
     * How many checkpoints the truncation cases below append, and the total
     * number of events that leaves on the item.
     *
     * The total is one MORE than the number appended: `create_item` writes a
     * `field_change` event of its own (SCHEMA.md §3), so an item with four
     * checkpoints has five events. Both are named here because the polled
     * count and the number written have to move together — see
     * `settledOrientation` for what goes wrong when they do not.
     */
    const TRUNCATION_CHECKPOINTS = 4;
    const TRUNCATION_TOTAL_EVENTS = TRUNCATION_CHECKPOINTS + 1;

    /**
     * Reads `orientation` once EVERY event written to the item is visible.
     *
     * **Why this exists, and why polling for "enough" events is not the same
     * thing.** These cases write `TRUNCATION_CHECKPOINTS` events and then
     * compare a bounded read against an unbounded one. Both reads have to see
     * the same ledger, or the comparison is between two different worlds.
     *
     * Waiting for only *some* of the events satisfies the lower bound the
     * horizon threatens — it is why the helper above polls at all — but
     * leaves the UPPER bound unpinned, and that is a real race rather than a
     * theoretical one. With four events written and only three awaited, the
     * unbounded read can settle at three while the fourth is still below the
     * visibility horizon; if it clears the horizon before the bounded read a
     * moment later, that read sees four. `slice(-2)` of three rows and
     * `slice(-2)` of four rows are different pairs, and the comparison fails
     * with every query having succeeded — an assertion mismatch, not an
     * error, which is what makes it easy to misread as unrelated flakiness.
     *
     * Reproduced deterministically: hold a transaction open across the fourth
     * write so the unbounded read settles short, then commit it before the
     * bounded read. The expected pair and the actual pair differ by one
     * event, exactly as above.
     *
     * The horizon is a CLUSTER-wide bound, not a per-database one
     * (`pg_snapshot_xmin`, `src/lib/events.ts`) — Postgres transaction ids
     * are shared across databases on a server — so the transaction that
     * stretches it is usually in another test file entirely, and this file
     * cannot make it go away by being tidy on its own.
     *
     * Waiting for the exact total keeps the discipline the helper above
     * documents: this polls the PRECONDITION (all the writes have landed),
     * never the property under test (which events a bounded read returns).
     * That property is still asserted once, on the first read, and must hold
     * the first time.
     */
    async function settledOrientation(
      itemId: string,
    ): Promise<{ whatChanged: readonly { id: string }[]; whatChangedTruncated: boolean }> {
      return orientationWithAtLeast(itemId, TRUNCATION_TOTAL_EVENTS);
    }

    // The load-bearing property of the whole bounded-reads change, and the
    // one thing that had no test at all. The failure mode if these flags
    // regress is not an error — it is `orientation` quietly returning a
    // partial answer the caller cannot tell is partial, which is exactly
    // what `response-size.ts` refuses to do and states its reasons for
    // refusing. A silent truncation is a regression INTO the behaviour this
    // codebase has explicitly rejected, so it is pinned here.

    it("sets whatChangedTruncated when there are more events than `limit`, and keeps the flag false when there are not", async () => {
      // Both directions in one test on purpose: a flag hardwired to `true`
      // passes a truncated-case assertion just as well as a correct one.
      //
      // Fails on `>` -> `>=` (the untruncated case would start announcing
      // truncation), on a hardwired `true` or `false`, and on dropping the
      // flag from the response.
      const item = await makeItem({ title: "Truncation subject" });
      for (let i = 0; i < TRUNCATION_CHECKPOINTS; i++)
        await appendCheckpoint(item.id, `checkpoint ${i}`);

      // Wait for EVERY event to clear the visibility horizon first, so the
      // assertions below are about truncation and not about timing. Waiting
      // for only some of them would leave `exactCount` below reading a
      // ledger that can still grow — see `settledOrientation`.
      const wholeResult = await settledOrientation(item.id);
      expect(wholeResult.whatChangedTruncated).toBe(false);
      expect(wholeResult.whatChanged).toHaveLength(TRUNCATION_TOTAL_EVENTS);

      const truncatedResult = (await runtime.call("orientation", {
        itemId: item.id,
        since: "0",
        limit: 2,
      })) as { whatChanged: readonly unknown[]; whatChangedTruncated: boolean };

      expect(truncatedResult.whatChangedTruncated).toBe(true);
      expect(truncatedResult.whatChanged).toHaveLength(2);

      // **The exact-fit boundary, which is where an off-by-one lives.** A
      // page holding precisely as many events as exist is NOT truncated —
      // nothing was withheld. Asserting only the loose cases above would let
      // `>` become `>=`, which announces truncation on a complete response
      // and teaches callers to distrust a flag that is crying wolf.
      const exactCount = wholeResult.whatChanged.length;
      const exactFit = (await runtime.call("orientation", {
        itemId: item.id,
        since: "0",
        limit: exactCount,
      })) as { whatChanged: readonly unknown[]; whatChangedTruncated: boolean };

      expect(exactFit.whatChanged).toHaveLength(exactCount);
      expect(exactFit.whatChangedTruncated).toBe(false);
    });

    it("keeps the NEWEST events when it truncates, not the oldest", async () => {
      // `slice(-limit)` rather than `slice(0, limit)`. This is the half a
      // boolean flag cannot express: a caller told "truncated" still has to
      // be able to trust that what it DID get is the recent end.
      //
      // Fails if the slice flips to `slice(0, limit)` — the returned ids
      // would then be the oldest two rather than the newest two.
      const item = await makeItem({ title: "Newest-events subject" });
      for (let i = 0; i < TRUNCATION_CHECKPOINTS; i++)
        await appendCheckpoint(item.id, `ordered checkpoint ${i}`);

      // Every event, not merely enough of them: the pair this compares
      // against is taken from the tail of THIS read, so a read that settles
      // while another event is still below the horizon compares the wrong
      // pair. See `settledOrientation`.
      const all = await settledOrientation(item.id);
      expect(all.whatChanged).toHaveLength(TRUNCATION_TOTAL_EVENTS);

      const bounded = (await runtime.call("orientation", {
        itemId: item.id,
        since: "0",
        limit: 2,
      })) as { whatChanged: readonly { id: string }[]; whatChangedTruncated: boolean };

      expect(bounded.whatChangedTruncated).toBe(true);
      const newestTwo = all.whatChanged.slice(-2).map((e) => e.id);
      expect(bounded.whatChanged.map((e) => e.id)).toEqual(newestTwo);
    });

    it("sets crewTruncated when more crew are live than `limit`, and false when they fit", async () => {
      // The crew list is bounded on the DISPLAY copy only — `liveAssignments`
      // stays unbounded because the claim guards must see every live row.
      // This pins that the display bound announces itself.
      //
      // Fails on `>` -> `>=`, on a hardwired flag, or if the bound is moved
      // onto `liveAssignments` itself (the guards' correctness aside, the
      // untruncated assertion below would start failing).
      const item = await makeItem({ title: "Crew truncation subject" });
      await claim({
        itemId: item.id,
        role: "orchestrator",
        holderType: "agent",
        holderId: "crew-trunc-orch",
        sessionId: "session-trunc-orch",
        machine: "laptop",
      });
      await claim({
        itemId: item.id,
        role: "builder",
        holderType: "agent",
        holderId: "crew-trunc-builder",
        sessionId: "session-trunc-builder",
        parentSessionId: "session-trunc-orch",
        rootSessionId: "session-trunc-orch",
        machine: "laptop",
      });

      const bounded = (await runtime.call("orientation", {
        itemId: item.id,
        limit: 1,
      })) as { crew: readonly unknown[]; crewTruncated: boolean };

      expect(bounded.crewTruncated).toBe(true);
      expect(bounded.crew).toHaveLength(1);

      const whole = (await runtime.call("orientation", {
        itemId: item.id,
        limit: 50,
      })) as { crew: readonly unknown[]; crewTruncated: boolean };

      expect(whole.crewTruncated).toBe(false);
      expect(whole.crew).toHaveLength(2);
    });
  });
});
