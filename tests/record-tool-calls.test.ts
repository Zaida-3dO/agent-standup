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
// ⚠️ That means a run with no database reports these as *skipped* and exits
// 0 — a green local run is not evidence any of this passed. The cap
// functions themselves are unit-tested in tests/telemetry-contract.test.ts,
// which needs no database and so runs everywhere; what this file adds is
// that the operation actually *applies* them on the way into the table — a
// property no unit test of a pure function can reach, and the one a
// mutation deleting a `capText` call at the insert site would survive.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { MAX_BATCH_SIZE, type RecordToolCallsOutput } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  MAX_COMMAND_CHARS,
  MAX_PATHS,
  MAX_PATH_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_TOOL_CHARS,
  TRUNCATION_MARKER,
  type ToolCallBatch,
  type ToolCallRecord,
} from "@/lib/telemetry/contract";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { registerSessions } from "./helpers/register-sessions";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

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
    prisma = createTestPrismaClient(scratchUrl);
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

  /**
   * Claims `itemId` for `sessionId`, registering the session first.
   *
   * The registration is not incidental setup that could be dropped: a claim
   * from an unregistered session is refused outright (SCHEMA.md §21), and
   * every case here that needs an assignment needs a claim to get one.
   * Seeding it through the shared helper rather than switching the rule off
   * keeps these cases on the same path a running installation takes — a
   * regression that only appears with the rule *on* would be invisible to a
   * suite that turned it off.
   */
  async function claim(itemId: string, sessionId: string) {
    await registerSessions(prisma, [sessionId]);
    return runtime.call("claim", {
      itemId,
      role: "builder",
      holderType: "agent",
      holderId: "crew-member",
      sessionId,
      machine: "laptop",
    });
  }

  /** One minimal, valid record. Overridable per case. */
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
  // Attribution: which assignment a batch lands on, and per-record sessions
  // -------------------------------------------------------------------------

  describe("attribution", () => {
    it("attributes to the MOST RECENTLY claimed assignment when a session holds two", async () => {
      // A session can hold more than one live assignment, and this decides
      // which item the whole batch attributes to — so the ordering is a
      // wrong `itemId`/`stateAt` on every row if it flips, which is #53's
      // cost-per-stage attribution. The single-character mutation this
      // kills: `ORDER BY a."claimedAt" DESC` -> `ASC`.
      //
      // The two items are seeded in DIFFERENT states, so the assertion
      // distinguishes them by `stateAt` as well as by id — an ordering bug
      // that happened to pick the right id would still be caught.
      const older = await seedItem("on_deck");
      const newer = await seedItem("in_review");
      await claim(older, "s-order-1");
      // `claimedAt` defaults to `now()`, so the two claims must be
      // distinguishable in time. Asserted rather than assumed below.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await claim(newer, "s-order-1");

      const claims = await prisma.assignment.findMany({
        where: { sessionId: "s-order-1", releasedAt: null },
        orderBy: { claimedAt: "asc" },
      });
      expect(claims).toHaveLength(2);
      // Guards the guard: if both claims landed on the same timestamp the
      // ordering assertion below would be decided by chance, not by the
      // ORDER BY, and would pass under the mutation half the time.
      expect(claims[0]!.claimedAt.getTime()).toBeLessThan(claims[1]!.claimedAt.getTime());

      const result = await record("s-order-1", [call()]);
      expect(result.itemId).toBe(newer);
      expect(result.stateAt).toBe("in_review");
    });

    it("caps the SESSION ID before it is stored and before it is used as a key", async () => {
      // `sessionId` is an index key (`ToolCall_sessionId_ts_idx`). An
      // uncapped value that differs only past the cap would split one
      // session's telemetry across two keys — a wrong measurement, not an
      // expensive one. The mutation this kills: dropping the
      // `capText(input.sessionId, MAX_SESSION_ID_CHARS)` call so the raw id
      // is used, which every other case in this file survives.
      const huge = "s".repeat(MAX_SESSION_ID_CHARS + 200);
      const result = await record(huge, [call()]);

      const stored = result.sessionId;
      expect(stored.length).toBe(MAX_SESSION_ID_CHARS);
      expect(result.truncatedFields).toBeGreaterThan(0);

      // The row is keyed by the CAPPED id, so it is findable by it — the
      // property that actually matters, and the one a length-only
      // assertion on the return value would not prove.
      const rows = await prisma.toolCall.findMany({ where: { sessionId: stored } });
      expect(rows).toHaveLength(1);
      // And not by the raw one, which is what "split across two keys"
      // would look like.
      expect(await prisma.toolCall.findMany({ where: { sessionId: huge } })).toHaveLength(0);
    });

    it("attributes EVERY row in a batch to the envelope's session", async () => {
      // The session is on the envelope, not on each record, so one flush is
      // one session's work by construction. This pins that: every row
      // written carries the envelope's id and the item that session holds,
      // with nothing per-record able to redirect any of them.
      const itemId = await seedItem("executing");
      await claim(itemId, "s-envelope-1");

      const result = await record("s-envelope-1", [
        call({ command: "one" }),
        call({ command: "two" }),
        call({ command: "three" }),
      ]);

      expect(result.recorded).toBe(3);
      expect(result.sessionId).toBe("s-envelope-1");

      const rows = await rowsFor("s-envelope-1");
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.sessionId === "s-envelope-1")).toBe(true);
      expect(rows.every((row) => row.itemId === itemId)).toBe(true);
      expect(rows.every((row) => row.stateAt === "executing")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The cross-PR contract: what the hook's spool actually sends
  // -------------------------------------------------------------------------

  describe("the record the hook spools", () => {
    it("accepts a record shaped exactly as the shared contract defines it", async () => {
      // Built as a `ToolCallRecord` — the same type the hook's spool
      // constructs — so this stops compiling if the shape drifts, and fails
      // at runtime if the schema stops accepting a value of that type. The
      // pairing is the point: a type both sides share does not help if the
      // server's schema refuses a value of it, which is precisely how the
      // two halves of this feature came apart the first time.
      const itemId = await seedItem();
      await claim(itemId, "s-contract-1");

      const one: ToolCallRecord = {
        ts: AT.toISOString(),
        tool: "Bash",
        command: "npm test",
        paths: ["src/a.ts"],
        inputTokens: 1,
        outputTokens: 2,
        cacheWriteTokens: 3,
        cacheReadTokens: 4,
        usage5h: 0.5,
        usageWeekly: 0.25,
      };
      const batch: ToolCallBatch = { sessionId: "s-contract-1", calls: [one] };

      const result = (await runtime.call("record_tool_calls", batch)) as RecordToolCallsOutput;

      expect(result.recorded).toBe(1);
      const rows = await rowsFor("s-contract-1");
      expect(rows[0]!.inputTokens).toBe(1);
      expect(rows[0]!.cacheReadTokens).toBe(4);
    });

    it("REFUSES a record carrying its own sessionId — the session is the envelope's", async () => {
      // A client that puts the session on every record has misread the
      // contract, and the refusal is what tells it so. Accepting it
      // silently would be worse than it sounds: the per-record value would
      // be ignored, so a batch whose records name a DIFFERENT session than
      // the envelope would be attributed wholesale to the envelope's, and
      // nothing would ever say the field had been discarded.
      const error = await recordRejection("s-strict-1", [
        { ...call(), sessionId: "some-other-session" },
      ]);
      expect(error.code).toBe("invalid_input");
    });

    it("accepts model and effort, and stores neither as a column on this table", async () => {
      // Both halves matter and they are easy to mistake for a contradiction.
      // SCHEMA.md §11 keeps the two strings off `tool_calls` ("two strings on
      // ~450k rows a year buys little") *and* requires the hook to report
      // them on every call, because a run is bounded by (assignment, model,
      // effort) and a change can land at any call. They are read to decide
      // where one run ends and the next begins, then discarded — so a
      // `ToolCall` row carries no trace of either, and the fields are still
      // absent from the projection the table exposes.
      const result = await record("s-facets-1", [
        { ...call(), model: "some-vendor-model-id", effort: "high" },
      ]);
      expect(result.recorded).toBe(1);

      const rows = await rowsFor("s-facets-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty("model");
      expect(rows[0]).not.toHaveProperty("effort");
    });

    it("REFUSES a model or effort past the identifier cap", async () => {
      // Bounded like every other string on this payload. An unbounded value
      // here would reach the run's own `model` column, which is what a cost
      // and a score are keyed on — so a value too long to be a vendor ID is
      // a client bug worth naming rather than silently clipping into an
      // identifier that matches no price and no scoring bucket.
      const tooLong = "m".repeat(MAX_TOOL_CHARS + 1);
      const withModel = await recordRejection("s-strict-2", [{ ...call(), model: tooLong }]);
      expect(withModel.code).toBe("invalid_input");

      const withEffort = await recordRejection("s-strict-3", [{ ...call(), effort: tooLong }]);
      expect(withEffort.code).toBe("invalid_input");
    });

    it("REFUSES a misspelled known field rather than recording a silent zero", async () => {
      // The case that earns `.strict()` its cost. Without it, a client
      // sending `input_tokens` for `inputTokens` has every count recorded
      // as zero — and the first person to notice is whoever tries to
      // compute a month of costs from them. A refused batch is retained by
      // the client and retried once fixed; an accepted batch of zeroes is
      // unbackfillable garbage in the one table §10 says cannot be rebuilt.
      const error = await recordRejection("s-strict-4", [call({ input_tokens: 5 })]);
      expect(error.code).toBe("invalid_input");
    });

    it("REFUSES an unknown field on the envelope too, not just on a record", async () => {
      // Both levels are strict. An envelope-level typo (a client sending
      // `session_id`) would otherwise fail the required-field check with a
      // message about the field it did NOT send, which sends someone
      // looking in the wrong place.
      const error = await runtime
        .call("record_tool_calls", {
          sessionId: "s-strict-5",
          calls: [call()],
          somethingElse: true,
        })
        .then(() => {
          throw new Error("expected record_tool_calls to reject, but it succeeded");
        })
        .catch((e: unknown) => e as { code: string });
      expect(error.code).toBe("invalid_input");
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

  /**
   * The liveness stamp — SCHEMA.md §2's `last_active` ("stamped by the hook
   * on every tool call"), which until this operation wrote it was true of
   * nothing in the tree.
   *
   * These are DB-backed rather than unit tests because the property under
   * test *is* the write: that resolving the session's assignment and
   * stamping it are one statement. A double would decide that by whatever
   * it implemented.
   */
  describe("stamps lastActive, so a flushing session is visibly alive", () => {
    /** `lastActive` and `claimedAt` for a session's newest live assignment. */
    async function timestamps(sessionId: string) {
      const rows = await prisma.$queryRawUnsafe<
        { lastActive: Date; claimedAt: Date; id: string }[]
      >(
        `SELECT "id", "lastActive", "claimedAt" FROM "Assignment"
          WHERE "sessionId" = $1 AND "releasedAt" IS NULL
          ORDER BY "claimedAt" DESC LIMIT 1`,
        sessionId,
      );
      return rows[0]!;
    }

    it("MOVES lastActive past claimedAt, so the column tracks activity not claim age", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-stamp-1");

      // Both columns default to now() at insert, so before any flush they
      // are the same instant. That equality is the whole defect this test
      // exists to catch: it is what made every threshold computed from
      // `lastActive` a measure of claim age.
      const before = await timestamps("s-stamp-1");
      expect(before.lastActive.getTime()).toBe(before.claimedAt.getTime());

      await record("s-stamp-1", [call()]);

      const after = await timestamps("s-stamp-1");
      expect(after.lastActive.getTime()).toBeGreaterThan(after.claimedAt.getTime());
      expect(after.lastActive.getTime()).toBeGreaterThan(before.lastActive.getTime());
    });

    it("stamps the flush time, NOT the caller's ts — an old batch still means alive now", async () => {
      const itemId = await seedItem();
      await claim(itemId, "s-stamp-2");

      // `AT` is a fixed instant far behind whenever this suite runs.
      // Stamping it would make a session that just flushed look years
      // quiet — the false negative the stamp exists to prevent, arriving
      // through the very path meant to prevent it.
      await record("s-stamp-2", [call({ ts: AT.toISOString() })]);

      const after = await timestamps("s-stamp-2");
      expect(after.lastActive.getTime()).toBeGreaterThan(AT.getTime());
      expect(after.lastActive.getTime()).toBeGreaterThan(after.claimedAt.getTime());
    });

    it("stamps the assignment the batch is ATTRIBUTED to when a session holds two", async () => {
      const first = await seedItem();
      const second = await seedItem();
      await claim(first, "s-stamp-3");
      const older = await timestamps("s-stamp-3");
      await claim(second, "s-stamp-3");

      const out = await record("s-stamp-3", [call()]);
      // Newest-claim-wins is the attribution rule; the stamp must follow it
      // or the row that proves the session is alive is not the row eviction
      // will read when this item is contended.
      expect(out.itemId).toBe(second);

      const newest = await timestamps("s-stamp-3");
      expect(newest.lastActive.getTime()).toBeGreaterThan(newest.claimedAt.getTime());

      const untouched = await prisma.$queryRawUnsafe<{ lastActive: Date }[]>(
        `SELECT "lastActive" FROM "Assignment" WHERE "id" = $1`,
        older.id,
      );
      expect(untouched[0]!.lastActive.getTime()).toBe(older.lastActive.getTime());
    });

    it("records a ghost session's calls without failing, having no assignment to stamp", async () => {
      // §10: a ghost session is first-class. The stamp must not turn "no
      // assignment" into a refusal — that would make the system measure
      // only work that was already tracked.
      const out = await record("s-stamp-ghost", [call()]);
      expect(out.recorded).toBe(1);
      expect(out.assignmentId).toBeNull();
      expect(out.itemId).toBeNull();
    });
  });
});
