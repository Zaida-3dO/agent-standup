// The backfill-only timestamp override — SCHEMA.md §3,
// src/lib/events-backfill.ts and the refusal in src/lib/events.ts.
//
// Against a real Postgres, because the claim being made is about what
// actually lands in the `ts` column: an in-memory double would be asserting
// that this file passes its own argument along, which is not the question.
// The question is whether the normal path can be made to write a timestamp
// it did not choose, and whether the backfill path preserves one to the
// millisecond through the driver, the cast and the column's own precision.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { appendEvent, type AppendEventInput } from "@/lib/events";
import { appendBackfillEvent, InvalidBackfillTimestampError } from "@/lib/events-backfill";
import type { TransactionHandle } from "@/lib/service/context";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** The instant an imported event claims to have happened — years before this test runs. */
const HISTORICAL = new Date("2023-04-05T06:07:08.123Z");

describeIfDb("the backfill-only event timestamp, against Postgres", () => {
  const dbName = scratchDatabaseName("events_backfill");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "backfill-area", displayName: "Backfill area" } });
    await prisma.item.create({
      data: {
        id: "backfill-item",
        kind: "task",
        title: "t",
        body: "b",
        state: "someday",
        originType: "auto",
        area: "backfill-area",
        mergeAuthority: "needs_approval",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** Runs `fn` inside one transaction, handing it the same narrowed handle an operation gets. */
  async function inTransaction<T>(fn: (db: TransactionHandle) => Promise<T>): Promise<T> {
    return prisma.$transaction((tx) => fn(tx as unknown as TransactionHandle));
  }

  const base = {
    itemId: "backfill-item",
    actor: { actorType: "agent", actorId: "crew-member" },
    type: "note",
    payload: {},
  } as const;

  it("the backfill path writes the timestamp it was given, to the millisecond", async () => {
    const appended = await inTransaction((db) =>
      appendBackfillEvent(db, { ...base, ts: HISTORICAL, body: "imported" }),
    );
    const row = await prisma.event.findUniqueOrThrow({ where: { id: appended.id } });
    // Single-character mutation this catches: passing `null` instead of
    // `input.ts` in appendBackfillEvent, or dropping the `"ts"` column from
    // insertEventRow's column list — either makes this row land at now().
    expect(row.ts.toISOString()).toBe(HISTORICAL.toISOString());
    expect(appended.ts.toISOString()).toBe(HISTORICAL.toISOString());
  });

  it("the backfill path still lets Postgres assign txId, rather than fabricating one", async () => {
    // `txId` is a fact about the writing transaction, not about the moment
    // being described, and `readSinceBounded`'s visibility horizon reads it.
    // A backfilled txId would break the one guarantee that read makes.
    const appended = await inTransaction((db) =>
      appendBackfillEvent(db, { ...base, ts: HISTORICAL }),
    );
    expect(appended.txId).toBeGreaterThan(0n);
  });

  it("the NORMAL path refuses a timestamp instead of quietly honouring it", async () => {
    // This is the rejection the whole split exists for. The cast is what an
    // import script written in a hurry would produce — the type has no `ts`,
    // so reaching the run-time guard at all requires going around it, and
    // that is precisely the caller this guard is for.
    const forged = { ...base, ts: HISTORICAL } as unknown as AppendEventInput;
    await expect(inTransaction((db) => appendEvent(db, forged))).rejects.toThrow(
      /`ts` cannot be set on the normal append path/,
    );
  });

  it("the normal path refuses even when the forged timestamp is undefined", async () => {
    // `{ ts: undefined }` is the shape a spread of an optional field
    // produces, and it is the case a naive `if (input.ts)` check would wave
    // through — leaving a caller believing overrides are accepted here.
    // Single-character mutation this catches: swapping the hasOwnProperty
    // check for a truthiness test on `input.ts`.
    const forged = { ...base, ts: undefined } as unknown as AppendEventInput;
    await expect(inTransaction((db) => appendEvent(db, forged))).rejects.toThrow(
      /`ts` cannot be set on the normal append path/,
    );
  });

  it("the normal path writes now(), not some other row's timestamp", async () => {
    const before = Date.now();
    const appended = await inTransaction((db) => appendEvent(db, { ...base, body: "live" }));
    const after = Date.now();
    // Millisecond truncation on the column (`@db.Timestamptz(3)`) can put
    // the stored value up to 1ms below `before`; the bound is widened by
    // that one millisecond rather than left flaky.
    expect(appended.ts.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(appended.ts.getTime()).toBeLessThanOrEqual(after + 1);
  });

  it("the backfill path refuses an unusable Date rather than passing it to Postgres", async () => {
    await expect(
      inTransaction((db) => appendBackfillEvent(db, { ...base, ts: new Date("not a date") })),
    ).rejects.toThrow(InvalidBackfillTimestampError);
    await expect(
      inTransaction((db) =>
        appendBackfillEvent(db, { ...base, ts: "2023-04-05" as unknown as Date }),
      ),
    ).rejects.toThrow(/ts must be a valid Date/);
  });

  it("appends the two open-loop event types the enum gained", async () => {
    // The enum labels are only real once Postgres accepts them; a TypeScript
    // union saying they exist proves nothing about the column.
    const opened = await inTransaction((db) =>
      appendEvent(db, {
        ...base,
        type: "open_loop",
        payload: { loopId: "loop-x", text: "untested cold-boot path" },
      }),
    );
    const closedEvent = await inTransaction((db) =>
      appendEvent(db, { ...base, type: "open_loop_closed", payload: { loopId: "loop-x" } }),
    );
    expect(opened.id).toBeGreaterThan(0n);
    expect(closedEvent.id).toBeGreaterThan(0n);
  });

  it("refuses an event type Postgres does not know", async () => {
    await expect(
      inTransaction((db) =>
        appendEvent(db, { ...base, type: "open-loop" as unknown as AppendEventInput["type"] }),
      ),
    ).rejects.toThrow();
  });
});

describe("the backfill module's import boundary", () => {
  // A source-level assertion, not a behavioural one: the eslint zone that
  // enforces this is only checked when lint runs, and a future edit that
  // reached for `events-backfill.ts` from inside the service layer would be
  // caught by lint — but only if the zone still names the module. This test
  // fails if the zone is removed or renamed, which lint itself cannot tell
  // you, because a deleted rule reports no violations.
  const config = readFileSync(path.resolve(import.meta.dirname, "../eslint.config.mjs"), "utf-8");

  it("keeps both backfill modules inside a restricted-import zone", () => {
    expect(config).toContain('from: "./src/lib/events-backfill.ts"');
    expect(config).toContain('from: "./src/lib/events-insert.ts"');
  });

  it("allowlists only events.ts and the import path", () => {
    // Widening this allowlist is the realistic way the boundary would be
    // lost — someone adds their own module to it rather than routing through
    // appendEvent. Spelled out so that widening it has to be a deliberate
    // edit to a test that says why.
    expect(config).toContain(
      'ignores: ["src/lib/events.ts", "src/lib/events-backfill.ts", "src/lib/import-*.ts"]',
    );
  });
});
