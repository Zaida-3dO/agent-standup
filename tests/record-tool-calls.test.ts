// `record_tool_calls` against a real Postgres — MILESTONES.md #50,
// SCHEMA.md §10 (`tool_calls`).
//
// Why these need a real database rather than a modelled handle: three of
// the properties under test are Postgres's, not the operation's. That the
// `stateAt` column accepts only a real `ItemState` value; that a `text[]`
// round-trips an array rather than a string; that an out-of-range `int` is
// refused by the column rather than quietly wrapping. A double would decide
// each of those by whatever it happened to implement.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
// The cap functions themselves are unit-tested in tests/telemetry-caps.ts,
// which runs everywhere; what this file adds is that the operation actually
// *applies* them on the way into the table — a property no unit test of a
// pure function can reach, and the one a mutation that deleted a `capText`
// call at the insert site would otherwise survive.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { MAX_BATCH_SIZE, type RecordToolCallsOutput } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  MAX_COMMAND_CHARS,
  MAX_PATHS,
  MAX_PATH_CHARS,
  MAX_TOOL_CHARS,
  TRUNCATION_MARKER,
} from "@/lib/telemetry/caps";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A stable instant, so nothing here depends on when the suite runs. */
const AT = new Date("2026-01-02T03:04:05.000Z");

describeIfDb("record_tool_calls — telemetry ingest against Postgres", () => {
  const dbName = scratchDatabaseName("tool_calls");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let counter = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** A fresh item in a named state, so cases never share one. */
  async function seedItem(state: "on_deck" | "executing" | "in_review" = "executing") {
    counter += 1;
    const id = `item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state,
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /** Claims `itemId` for `sessionId`, so the ingest has an assignment to find. */
  async function claim(itemId: string, sessionId: string) {
    return runtime.call("claim", {
      itemId,
      role: "builder",
      holderType: "agent",
      holderId: "crew-member",
      sessionId,
      machine: "laptop",
    });
  }

  /** One minimal, valid call. Overridable per case. */
  function call(overrides: Record<string, unknown> = {}) {
    return { tool: "Bash", ts: AT.toISOString(), ...overrides };
  }

  async function record(sessionId: string, calls: unknown[]): Promise<RecordToolCallsOutput> {
    return (await runtime.call("record_tool_calls", {
      sessionId,
      calls,
    })) as RecordToolCallsOutput;
  }

  /**
   * Calls the operation expecting it to reject, and returns the typed
   * service error.
   *
   * Separate from `record` rather than a `.catch()` at each call site so a
   * case that *stops* rejecting fails loudly here — resolving instead of
   * throwing hits the explicit `throw` below rather than quietly returning
   * a success value that the assertion then reads a missing `code` off.
   */
  async function recordRejection(
    sessionId: string,
    calls: unknown[],
  ): Promise<{ code: string; fields?: string[] }> {
    try {
      await record(sessionId, calls);
    } catch (error) {
      return error as { code: string; fields?: string[] };
    }
    throw new Error("expected record_tool_calls to reject, but it succeeded");
  }

  async function rowsFor(sessionId: string) {
    return prisma.toolCall.findMany({ where: { sessionId }, orderBy: { id: "asc" } });
  }

  // -------------------------------------------------------------------------
  // Ingest, and the item's state at the time
  // -------------------------------------------------------------------------

  describe("the write", () => {
    it("records a batch and attributes it to the session's live assignment", async () => {
      const itemId = await seedItem("executing");
      await claim(itemId, "s-write-1");

      const result = await record("s-write-1", [
        call({ tool: "Bash", command: "npm test" }),
        call({ tool: "Read", paths: ["src/a.ts"] }),
      ]);

      expect(result.recorded).toBe(2);
      expect(result.itemId).toBe(itemId);
      expect(result.assignmentId).not.toBeNull();

      const rows = await rowsFor("s-write-1");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.tool).toBe("Bash");
      expect(rows[0]!.command).toBe("npm test");
      expect(rows[0]!.itemId).toBe(itemId);
      expect(rows[1]!.paths).toEqual(["src/a.ts"]);
    });

    it("stamps the ITEM'S STATE at the time — the whole reason the column exists", async () => {
      // §10: `state_at` is denormalised precisely so cost can be sliced by
      // stage. A mutation that dropped `live?.state` from the insert (or
      // passed a constant) leaves every other assertion in this file green
      // — this is the only one that fails.
      const itemId = await seedItem("in_review");
      await claim(itemId, "s-state-1");

      const result = await record("s-state-1", [call()]);
      expect(result.stateAt).toBe("in_review");

      const rows = await rowsFor("s-state-1");
      expect(rows[0]!.stateAt).toBe("in_review");
    });

    it("follows the item's state rather than caching it — two batches either side of a move differ", async () => {
      // The state is resolved per call, not per session. If it were read
      // once and reused, the second batch would still read `on_deck`, and
      // every cost figure attributed to `executing` would be missing this
      // work.
      const itemId = await seedItem("on_deck");
      await claim(itemId, "s-state-2");

      const before = await record("s-state-2", [call()]);
      await prisma.item.update({ where: { id: itemId }, data: { state: "executing" } });
      const after = await record("s-state-2", [call()]);

      expect(before.stateAt).toBe("on_deck");
      expect(after.stateAt).toBe("executing");
    });

    it("uses the CLIENT'S timestamp, not the server's clock", async () => {
      // A spooled batch is flushed after the fact. Defaulting `ts` to
      // `now()` would attribute every call in it to the flush moment, which
      // destroys the per-stage attribution #53 computes.
      const itemId = await seedItem();
      await claim(itemId, "s-ts-1");

      const earlier = new Date("2020-06-07T08:09:10.000Z");
      await record("s-ts-1", [call({ ts: earlier.toISOString() })]);

      const rows = await rowsFor("s-ts-1");
      expect(rows[0]!.ts.toISOString()).toBe(earlier.toISOString());
    });

    it("stores the four token counts SEPARATELY — they price at different rates", async () => {
      // §10: "Prices ~5× input — never fold into a single total." A
      // mutation that summed them, or that mapped two of them to the same
      // column, is caught here and nowhere else.
      const itemId = await seedItem();
      await claim(itemId, "s-tok-1");

      await record("s-tok-1", [
        call({
          inputTokens: 11,
          outputTokens: 22,
          cacheWriteTokens: 33,
          cacheReadTokens: 44,
        }),
      ]);

      const rows = await rowsFor("s-tok-1");
      expect(rows[0]!.inputTokens).toBe(11);
      expect(rows[0]!.outputTokens).toBe(22);
      expect(rows[0]!.cacheWriteTokens).toBe(33);
      expect(rows[0]!.cacheReadTokens).toBe(44);
    });

    it("stores the usage snapshots the hook carries, and null when it carries none", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-usage-1");

      await record("s-usage-1", [call({ usage5h: 0.25, usageWeekly: 0.8 }), call()]);

      const rows = await rowsFor("s-usage-1");
      expect(Number(rows[0]!.usage5h)).toBeCloseTo(0.25);
      expect(Number(rows[0]!.usageWeekly)).toBeCloseTo(0.8);
      expect(rows[1]!.usage5h).toBeNull();
      expect(rows[1]!.usageWeekly).toBeNull();
    });

    it("defaults absent token counts to zero rather than null", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-tok-2");
      await record("s-tok-2", [call()]);
      const rows = await rowsFor("s-tok-2");
      expect(rows[0]!.inputTokens).toBe(0);
      expect(rows[0]!.outputTokens).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Ghost sessions — §10's "real work with no minted task"
  // -------------------------------------------------------------------------

  describe("ghost sessions", () => {
    it("RECORDS a call from a session holding nothing, with null item, assignment and state", async () => {
      // Refusing this would mean the data the M9 picker learns from
      // contains only work that was already tracked — a survivorship bias
      // in the measurement itself. A mutation that threw NotFound here
      // passes every other case in this file.
      const result = await record("s-ghost-1", [call({ command: "git status" })]);

      expect(result.recorded).toBe(1);
      expect(result.assignmentId).toBeNull();
      expect(result.itemId).toBeNull();
      expect(result.stateAt).toBeNull();

      const rows = await rowsFor("s-ghost-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.itemId).toBeNull();
      expect(rows[0]!.stateAt).toBeNull();
      expect(rows[0]!.command).toBe("git status");
    });

    it("treats a RELEASED assignment as a ghost session — a stale claim never attributes new work", async () => {
      // The window this covers is real: a session flushes its spool after
      // releasing. The lookup requires `releasedAt IS NULL`, so a released
      // assignment attributes nothing — otherwise these calls would land
      // under an item this session does not hold, inflating its cost with
      // whatever the session went on to do elsewhere.
      const itemId = await seedItem();
      await claim(itemId, "s-ghost-2");
      await runtime.call("release", { itemId, sessionId: "s-ghost-2" });

      const result = await record("s-ghost-2", [call()]);
      expect(result.assignmentId).toBeNull();
      expect(result.stateAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The caps, applied at the insert site
  // -------------------------------------------------------------------------

  describe("caps on the big fields", () => {
    it("truncates an over-long command and MARKS it, rather than refusing the row", async () => {
      // Truncate-not-reject is the deliberate choice (see the module
      // header): the row is the thing that cannot be backfilled. Both
      // halves are asserted — that it was cut to the cap, and that the row
      // still exists.
      const itemId = await seedItem();
      await claim(itemId, "s-cap-1");

      const huge = "A".repeat(MAX_COMMAND_CHARS + 5_000);
      const result = await record("s-cap-1", [call({ command: huge })]);

      expect(result.recorded).toBe(1);
      expect(result.truncatedFields).toBe(1);

      const rows = await rowsFor("s-cap-1");
      expect(rows[0]!.command!.length).toBe(MAX_COMMAND_CHARS);
      expect(rows[0]!.command!.endsWith(TRUNCATION_MARKER)).toBe(true);
    });

    it("stores a command of EXACTLY the cap untouched", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-cap-2");

      const exact = "B".repeat(MAX_COMMAND_CHARS);
      const result = await record("s-cap-2", [call({ command: exact })]);

      expect(result.truncatedFields).toBe(0);
      const rows = await rowsFor("s-cap-2");
      expect(rows[0]!.command).toBe(exact);
    });

    it("caps a wide path list to MAX_PATHS entries", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-cap-3");

      const wide = Array.from({ length: 5_000 }, (_, i) => `src/f${i}.ts`);
      const result = await record("s-cap-3", [call({ tool: "Glob", paths: wide })]);

      expect(result.truncatedFields).toBe(1);
      const rows = await rowsFor("s-cap-3");
      expect(rows[0]!.paths).toHaveLength(MAX_PATHS);
      expect(rows[0]!.paths[0]).toBe("src/f0.ts");
    });

    it("caps each path's length as well as the count", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-cap-4");

      const long = Array.from({ length: 3 }, () => "d".repeat(MAX_PATH_CHARS + 100));
      await record("s-cap-4", [call({ paths: long })]);

      const rows = await rowsFor("s-cap-4");
      for (const path of rows[0]!.paths) {
        expect(path.length).toBe(MAX_PATH_CHARS);
      }
    });

    it("caps an over-long tool name", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-cap-5");

      await record("s-cap-5", [call({ tool: "T".repeat(MAX_TOOL_CHARS + 50) })]);

      const rows = await rowsFor("s-cap-5");
      expect(rows[0]!.tool.length).toBe(MAX_TOOL_CHARS);
    });

    it("counts every truncated field across the batch, so a clipping client can see it", async () => {
      // `truncatedFields` is the only signal a client gets that its
      // payloads are too big — a truncated row is indistinguishable from a
      // small one from the outside. A mutation that hard-coded it to 0 or 1
      // is caught here.
      const itemId = await seedItem();
      await claim(itemId, "s-cap-6");

      const result = await record("s-cap-6", [
        call({ command: "A".repeat(MAX_COMMAND_CHARS + 1) }),
        call({ paths: Array.from({ length: MAX_PATHS + 1 }, (_, i) => `p${i}`) }),
        call({ command: "fits" }),
      ]);

      expect(result.truncatedFields).toBe(2);
    });

    it("reports zero truncated fields for a batch that fits", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-cap-7");
      const result = await record("s-cap-7", [call({ command: "ls", paths: ["a.ts"] })]);
      expect(result.truncatedFields).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Rejections — the input that is wrong rather than merely large
  // -------------------------------------------------------------------------

  describe("what it refuses", () => {
    it("REFUSES a negative token count rather than clamping it to zero", async () => {
      // Clamping would fabricate a measurement, in a table whose whole
      // purpose is measurement. The rejection is the point: a client
      // sending negatives has a bug, and a plausible-looking zero hides it.
      const error = await recordRejection("s-bad-1", [call({ inputTokens: -1 })]);
      expect(error.code).toBe("invalid_input");
    });

    it("refuses a non-integer token count", async () => {
      const error = await recordRejection("s-bad-2", [call({ outputTokens: 1.5 })]);
      expect(error.code).toBe("invalid_input");
    });

    it("refuses a token count past what the int column can hold, naming the FIELD not the column", async () => {
      // Without the schema bound this reaches Postgres, which fails the
      // whole batch with an error naming a column — leaving the client
      // unable to tell which of its 500 rows was at fault.
      const error = await recordRejection("s-bad-3", [call({ inputTokens: 2_147_483_648 })]);
      expect(error.code).toBe("invalid_input");
    });

    it("refuses a batch over MAX_BATCH_SIZE rather than silently dropping the tail", async () => {
      // Truncating a batch would discard whole calls, and a client that
      // cannot tell how many rows landed cannot retry correctly.
      const tooMany = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => call());
      const error = await recordRejection("s-bad-4", tooMany);
      expect(error.code).toBe("invalid_input");
    });

    it("accepts a batch of EXACTLY MAX_BATCH_SIZE", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-max-1");
      const exact = Array.from({ length: MAX_BATCH_SIZE }, () => call());
      const result = await record("s-max-1", exact);
      expect(result.recorded).toBe(MAX_BATCH_SIZE);
    });

    it("refuses an empty batch — an ingest with nothing in it is a client bug, not a no-op", async () => {
      const error = await recordRejection("s-bad-5", []);
      expect(error.code).toBe("invalid_input");
    });

    it("refuses a call with no tool", async () => {
      const error = await recordRejection("s-bad-6", [{ ts: AT.toISOString() }]);
      expect(error.code).toBe("invalid_input");
    });

    it("refuses an unrecognised field rather than dropping it — the schema is strict", async () => {
      // A client sending `input_tokens` where the schema says `inputTokens`
      // would otherwise have every count silently recorded as zero, and
      // nothing would ever say so.
      const error = await recordRejection("s-bad-7", [call({ input_tokens: 5 })]);
      expect(error.code).toBe("invalid_input");
    });

    it("refuses a non-finite usage reading", async () => {
      // `NaN` in a numeric column is a value every later comparison
      // silently loses to, which is worse than not having the reading.
      const error = await recordRejection("s-bad-8", [call({ usage5h: Number.NaN })]);
      expect(error.code).toBe("invalid_input");
    });

    it("refuses an empty session id", async () => {
      const error = await recordRejection("", [call()]);
      expect(error.code).toBe("invalid_input");
    });
  });
});
