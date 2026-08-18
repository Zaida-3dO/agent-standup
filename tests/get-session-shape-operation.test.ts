// `get_session_shape` against a real Postgres — MILESTONES.md #54, SCHEMA.md §10.
//
// The judgement this operation reports is proved without a database in
// `tests/telemetry-shape.test.ts`, over the pure module. What is left here is
// exactly what that file cannot see, and all of it is about *which rows* the
// reading is taken over:
//
//   - the window is the **most recent** calls, not the first ones;
//   - the rows reach the signals in **chronological order**, which repeat
//     detection depends on and which the query deliberately inverts;
//   - the reading is scoped to **one session**, so two agents' commands never
//     blend into a repeat count neither earned;
//   - the window is **bounded**, and a caller cannot ask for an unbounded read
//     of the highest-volume table in the schema.
//
// Those are properties of a query and an ordering, and an in-memory double
// asserting them would be asserting its own construction.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { resolveSettings, type SettingsSnapshot } from "@/lib/settings";
import { DEFAULT_SHAPE_WINDOW, MAX_SHAPE_WINDOW } from "@/lib/service/operations/get-session-shape";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/**
 * A snapshot with the `shape.*` thresholds set low enough that a handful of
 * seeded rows can trip them.
 *
 * Overriding rather than seeding hundreds of rows to clear the shipped
 * defaults: the defaults are asserted in the settings test, and a query test
 * that needed 200 inserts per case would be slow enough to be skipped.
 */
function snapshotWithLowThresholds(): SettingsSnapshot {
  return resolveSettings({
    overrides: [
      { key: "shape.minimum_sample", value: 2 },
      { key: "shape.repeat_threshold", value: 2 },
      { key: "shape.spread_threshold", value: 3 },
      { key: "shape.read_share_threshold", value: 0.75 },
    ],
    revision: 1n,
  });
}

describeIfDb("get_session_shape against Postgres", () => {
  const dbName = scratchDatabaseName("session_shape_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  /** A second runtime at the **shipped** `shape.*` defaults — see its use below. */
  let defaultsRuntime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => snapshotWithLowThresholds(),
    });
    defaultsRuntime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => resolveSettings({ overrides: [], revision: 1n }),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** A base moment every seeded row is offset from, so ordering is explicit. */
  const T0 = new Date("2026-03-01T12:00:00.000Z");

  /** Seeds one tool-call row `secondsFromStart` after `T0`. */
  async function seed(
    sessionId: string,
    secondsFromStart: number,
    call: { tool: string; command?: string; paths?: readonly string[] },
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ToolCall" ("sessionId", "ts", "tool", "command", "paths")
       VALUES ($1, $2, $3, $4, $5)`,
      sessionId,
      new Date(T0.getTime() + secondsFromStart * 1000),
      call.tool,
      call.command ?? null,
      call.paths ?? [],
    );
  }

  type ShapeResult = Awaited<ReturnType<typeof shapeOf>>;
  async function shapeOf(sessionId: string, limit?: number) {
    return (await runtime.call(
      "get_session_shape",
      limit === undefined ? { sessionId } : { sessionId, limit },
    )) as {
      sessionId: string;
      calls: number;
      repeats: { level: string; value: number };
      spread: { level: string; value: number };
      readShare: { level: string; value: number; sampleSize: number };
      thresholds: {
        minimumSample: number;
        repeatThreshold: number;
        spreadThreshold: number;
        readShareThreshold: number;
      };
    };
  }

  it("reports an unknown shape for a session with no calls at all", async () => {
    // Not an error and not a zero-shaped judgement: nothing has been
    // measured, and the honest answer is that nothing can be said.
    const shape = await shapeOf("shape-empty-session");
    expect(shape.calls).toBe(0);
    expect(shape.repeats.level).toBe("unknown");
    expect(shape.spread.level).toBe("unknown");
  });

  it("reads the rows in chronological order, so a return is not read as a departure", async () => {
    // The query orders newest-first to use the index, then reverses. If that
    // reversal were dropped, this session reads backwards as
    // `a, b, a` -> still one return — so the case is built asymmetrically:
    // forwards it is one return to `a`, backwards it would be one return to
    // `b`, and only the *value* distinguishes them from the level.
    const session = "shape-ordering";
    await seed(session, 1, { tool: "Bash", command: "a" });
    await seed(session, 2, { tool: "Bash", command: "b" });
    await seed(session, 3, { tool: "Bash", command: "a" });
    await seed(session, 4, { tool: "Bash", command: "c" });
    await seed(session, 5, { tool: "Bash", command: "b" });

    // Forwards: `a` returns at t3 and `b` returns at t5 — two returns.
    const shape = await shapeOf(session);
    expect(shape.calls).toBe(5);
    expect(shape.repeats.value).toBe(2);
    expect(shape.repeats.level).toBe("elevated");
  });

  it("counts a retry loop once, end to end through the operation", async () => {
    // The row's own warning, proved through the real query rather than only
    // over an array: a session hammering one command is not circling.
    const session = "shape-retry-loop";
    for (let i = 0; i < 12; i += 1) {
      await seed(session, i, { tool: "Bash", command: "npm test" });
    }
    const shape = await shapeOf(session);
    expect(shape.calls).toBe(12);
    expect(shape.repeats.value).toBe(0);
    expect(shape.repeats.level).toBe("normal");
  });

  it("separates a working session from a stuck one at the shipped defaults", async () => {
    // The property the whole fix is about, proved end to end: through the
    // real query, with rows shaped the way `@/lib/hook/payload` writes them
    // (a Read/Edit stores its file path in `command`), and against the
    // **shipped** thresholds rather than the low ones the other cases use.
    //
    // Before the Bash restriction, both of these scored far above
    // `repeat_threshold` (3) — an ordinary session 10 and a stuck one 18 —
    // so `elevated` said nothing about a session at all. Overriding the
    // thresholds here would hide exactly the regression this guards.
    const working = "shape-defaults-working";
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    let t = 0;
    for (let i = 0; i < 5; i += 1) {
      const file = files[i % files.length]!;
      await seed(working, (t += 1), { tool: "Read", command: file, paths: [file] });
      await seed(working, (t += 1), { tool: "Edit", command: file, paths: [file] });
      await seed(working, (t += 1), { tool: "Bash", command: "npm test" });
      await seed(working, (t += 1), { tool: "Read", command: file, paths: [file] });
    }

    const stuck = "shape-defaults-stuck";
    t = 0;
    for (let i = 0; i < 10; i += 1) {
      await seed(stuck, (t += 1), { tool: "Bash", command: "npm run build" });
      await seed(stuck, (t += 1), { tool: "Bash", command: "npm test" });
    }

    const workingShape = (await defaultsRuntime.call("get_session_shape", {
      sessionId: working,
    })) as ShapeResult;
    const stuckShape = (await defaultsRuntime.call("get_session_shape", {
      sessionId: stuck,
    })) as ShapeResult;

    // Both clear `minimum_sample` (20), so neither answer is a shrug.
    expect(workingShape.calls).toBe(20);
    expect(stuckShape.calls).toBe(20);
    expect(workingShape.repeats.level).toBe("normal");
    expect(stuckShape.repeats.level).toBe("elevated");
  });

  it("scopes the reading to one session", async () => {
    // Two sessions each running the same command once. Pooled, that reads as
    // a return; scoped, it is two first runs and no repeat at all.
    await seed("shape-scope-a", 1, { tool: "Bash", command: "shared" });
    await seed("shape-scope-a", 2, { tool: "Read", paths: ["src/a.ts"] });
    await seed("shape-scope-b", 3, { tool: "Bash", command: "shared" });
    await seed("shape-scope-b", 4, { tool: "Read", paths: ["src/b.ts"] });

    const a = await shapeOf("shape-scope-a");
    expect(a.calls).toBe(2);
    expect(a.repeats.value).toBe(0);
    expect(a.spread.value).toBe(1);
  });

  it("takes the window from the most recent calls, not the earliest", async () => {
    // Ten calls: the first five touch five files, the last five touch one.
    // A window of 5 taken from the wrong end reports a spread of 5.
    const session = "shape-window-end";
    for (let i = 0; i < 5; i += 1) {
      await seed(session, i, { tool: "Read", paths: [`src/old-${i}.ts`] });
    }
    for (let i = 0; i < 5; i += 1) {
      await seed(session, 100 + i, { tool: "Read", paths: ["src/recent.ts"] });
    }

    const windowed = await shapeOf(session, 5);
    expect(windowed.calls).toBe(5);
    expect(windowed.spread.value).toBe(1);

    // The whole session, for contrast — the same rows, a different window.
    const whole = await shapeOf(session, 20);
    expect(whole.calls).toBe(10);
    expect(whole.spread.value).toBe(6);
  });

  it("counts distinct paths across the window rather than path-carrying calls", async () => {
    const session = "shape-spread";
    await seed(session, 1, { tool: "Read", paths: ["src/a.ts", "src/b.ts"] });
    await seed(session, 2, { tool: "Edit", paths: ["src/b.ts", "src/c.ts"] });
    await seed(session, 3, { tool: "Read", paths: ["src/a.ts"] });

    const shape = await shapeOf(session);
    expect(shape.spread.value).toBe(3);
    expect(shape.spread.level).toBe("elevated");
  });

  it("takes the read share over classifiable calls, ignoring shell", async () => {
    // Three reads, one write, and four shell calls. Over everything the
    // share would be 3/8; over what can be classified it is 3/4.
    const session = "shape-read-share";
    for (let i = 0; i < 3; i += 1) await seed(session, i, { tool: "Read", paths: ["src/a.ts"] });
    await seed(session, 3, { tool: "Edit", paths: ["src/a.ts"] });
    for (let i = 0; i < 4; i += 1)
      await seed(session, 10 + i, { tool: "Bash", command: `ls ${i}` });

    const shape = await shapeOf(session);
    expect(shape.calls).toBe(8);
    expect(shape.readShare.sampleSize).toBe(4);
    expect(shape.readShare.value).toBe(75);
    expect(shape.readShare.level).toBe("elevated");
  });

  it("returns the thresholds the reading was taken against", async () => {
    // A level is meaningless without them: shown `elevated` and the number
    // 3, a consumer cannot tell whether the threshold was 2 or 30.
    const shape = await shapeOf("shape-empty-session");
    expect(shape.thresholds).toMatchObject({
      minimumSample: 2,
      repeatThreshold: 2,
      spreadThreshold: 3,
      readShareThreshold: 0.75,
    });
  });

  it("refuses a limit past the bound rather than reading the whole table", async () => {
    // `tool_calls` is the highest-volume table in the schema and this
    // operation is reachable over MCP, HTTP and the command line, so an
    // unbounded limit is a full scan waiting to be typed.
    const error = await runtime
      .call("get_session_shape", { sessionId: "shape-empty-session", limit: MAX_SHAPE_WINDOW + 1 })
      .catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("invalid_input");
  });

  it("refuses a non-positive limit and an empty session id", async () => {
    for (const input of [
      { sessionId: "shape-empty-session", limit: 0 },
      { sessionId: "shape-empty-session", limit: -1 },
      { sessionId: "" },
    ]) {
      const error = await runtime.call("get_session_shape", input).catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
    }
  });

  it("refuses an unrecognised field rather than ignoring it", async () => {
    // The input schema is strict, like every other operation's: a caller
    // misspelling `limit` must be told, not quietly given the default.
    const error = await runtime
      .call("get_session_shape", { sessionId: "shape-empty-session", windowSize: 10 })
      .catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("invalid_input");
  });

  it("defaults the window when none is given", async () => {
    // Proved by behaviour rather than by reading the constant: a session
    // with more rows than the default window reports exactly the default.
    const session = "shape-default-window";
    for (let i = 0; i < DEFAULT_SHAPE_WINDOW + 10; i += 1) {
      await seed(session, i, { tool: "Read", paths: ["src/a.ts"] });
    }
    const shape = await shapeOf(session);
    expect(shape.calls).toBe(DEFAULT_SHAPE_WINDOW);
  }, 60_000);

  it("echoes the session it read, so a result is never orphaned from its subject", async () => {
    const shape: ShapeResult = await shapeOf("shape-scope-a");
    expect(shape.sessionId).toBe("shape-scope-a");
  });
});
