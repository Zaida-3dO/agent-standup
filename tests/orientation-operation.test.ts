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
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem, type ClaimInput } from "@/lib/claims";
import {
  createScratchDatabase,
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
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
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
});
