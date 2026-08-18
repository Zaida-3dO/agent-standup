// MILESTONES.md #109 — every read is bounded, and a test proves it.
//
// **This file is the row's actual deliverable.** The pagination is the fix;
// this is the thing that stops the problem recurring. #103 bounded the
// default read once and the same class of defect came back in the next
// operation, because nothing anywhere asserted that a read fits. So the
// assertion here is deliberately generic: it iterates **every operation the
// registry declares as a read** and requires each to return a tenable
// payload against a realistic corpus. An operation added next month is
// covered without anyone remembering to cover it.
//
// **The assertion is about response SIZE, not row count** — the row says so
// outright, and the distinction is the whole lesson of #107. Row count was
// never the thing that overflowed: `get_board` returned ~542,000 characters
// on the current corpus *after* #103 had already cut the row count, because
// a handful of `executing` items carrying long `body` and `customFields`
// values is a larger payload than hundreds of slim ones. A cap on rows is
// satisfied by a response that still does not fit; a cap on characters is
// the thing a caller's context actually enforces.
//
// **What would make this file hollow, stated first so it can be checked.**
// Three ways, all of which the assertions below are shaped to avoid:
//
//   1. **A corpus too small to overflow anything.** A test seeded with
//      three tidy items passes against a completely unbounded read — it
//      proves the operation returns a small payload when there is nothing
//      to return, which is not a claim about bounding at all. So
//      `seedRealisticCorpus` builds items whose *size* is the point: bodies
//      and custom fields at the scale the real corpus carries, in the
//      quantity that made the measured board read 542k characters.
//   2. **Measuring the operation's return value instead of its wire
//      form.** A read is overflowing the context it is read in, and what
//      lands in that context is serialised JSON, not a JS object graph. So
//      every measurement is `JSON.stringify(...).length`.
//   3. **Only testing the operations someone remembered.** Hence the
//      registry-driven loop, and hence the guard below asserting the loop
//      actually covered something — a filter typo that selected zero
//      operations would otherwise make this file pass by testing nothing.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { OPERATION_REGISTRY, operationsOfKind } from "@/lib/service/registry";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  OPEN_COLUMNS,
  WITHHELD_COLUMNS,
  buildSliceNotice,
} from "@/lib/service/board/slice";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

/**
 * The ceiling a read has to fit under, in characters of serialised JSON.
 *
 * 40,000 characters is roughly 10k tokens: a large but genuinely readable
 * response, and comfortably under the context any caller has.
 *
 * **The number is chosen against this file's corpus, not against the
 * production one, and that distinction matters.** A bound only tests
 * anything if an unbounded read *breaches* it here — and the corpus below
 * is 269 items, where an unbounded slim board read measures ~64,000
 * characters and an unbounded `full` one ~1,045,000. A 120,000 bound would
 * therefore have been passed by an unbounded slim read on this data, which
 * is the "corpus too small to overflow anything" trap named in the header:
 * the assertion would have looked strict and proved nothing. That was
 * observed, not theorised — the bound was verified by deliberately removing
 * the limit and confirming this file goes red.
 *
 * The production numbers this row was filed over (542,000 for `get_board`,
 * 165,000 for a live `orientation`) are far above it, so a bound that fails
 * here fails there too.
 */
const TENABLE_PAYLOAD_CHARS = 40_000;

/** What actually lands in a caller's context: the serialised response. */
function payloadSize(value: unknown): number {
  return JSON.stringify(value).length;
}

describe("the default slice — what a read with no filters answers", () => {
  // Written out literally rather than derived from `OPEN_COLUMNS`, for the
  // circularity reason `columns.ts` gives: an expectation read from the
  // implementation proves only that the implementation equals itself.
  it("is in_progress and waiting — the work being worked on", () => {
    expect([...OPEN_COLUMNS]).toEqual(["in_progress", "waiting"]);
  });

  // #109 part 2's actual content: backlog is excluded by DEFAULT, which is
  // strictly narrower than #103's non-terminal default. A test asserting
  // only that terminal work is excluded would pass against #103's behaviour
  // and miss this row entirely.
  it("withholds backlog as well as completed, not merely terminal work", () => {
    expect([...WITHHELD_COLUMNS].sort()).toEqual(["backlog", "completed"]);
  });

  it("bounds a page by default rather than leaving it to the caller", () => {
    expect(DEFAULT_PAGE_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_PAGE_LIMIT).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
  });
});

describe("the notice a default read carries", () => {
  it("names each withheld column, its real total, and the call that returns it", () => {
    const notice = buildSliceNotice(12, [
      { column: "backlog", total: 58 },
      { column: "completed", total: 175 },
    ]);
    expect(notice).toContain("12 open items");
    // The counts have to be the real ones — a notice quoting a wrong total
    // is #123 in sentence form.
    expect(notice).toContain("58 in backlog");
    expect(notice).toContain("175 in completed");
    // Self-routing (#111's principle): naming the call, not just the fact.
    expect(notice).toContain('get_board with column: "backlog"');
    expect(notice).toContain('get_board with column: "completed"');
    expect(notice).toContain("search");
  });

  // The load-bearing negative: a notice that fires when nothing was
  // withheld trains callers to stop reading it, which costs exactly the
  // attention it exists to buy on the calls that matter.
  it("is null when nothing was withheld", () => {
    expect(buildSliceNotice(3, [])).toBeNull();
  });

  it("is null when every withheld column is genuinely empty, rather than pointing at nothing", () => {
    expect(
      buildSliceNotice(3, [
        { column: "backlog", total: 0 },
        { column: "completed", total: 0 },
      ]),
    ).toBeNull();
  });

  it("names only the withheld columns that actually hold something", () => {
    const notice = buildSliceNotice(4, [
      { column: "backlog", total: 0 },
      { column: "completed", total: 9 },
    ]);
    expect(notice).not.toContain("backlog");
    expect(notice).toContain("9 in completed");
  });

  it("says `item` rather than `items` for a single one", () => {
    expect(buildSliceNotice(1, [{ column: "backlog", total: 2 }])).toContain("1 open item;");
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("every registered read is bounded against a realistic corpus", () => {
  const dbName = scratchDatabaseName("bounded_reads");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  /** One item id from the corpus, for the reads that need a subject. */
  let sampleItemId: string;
  let sessionId: string;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    const seeded = await seedRealisticCorpus();
    sampleItemId = seeded.sampleItemId;
    sessionId = seeded.sessionId;
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /**
   * A corpus whose *size* is the point.
   *
   * Proportioned after the real store the row measured — a large completed
   * majority, a sizeable backlog, a small live set — because the shape is
   * what makes an unbounded read fail: a default that excluded only
   * terminal work still returned the whole backlog, which is why #109
   * narrows the default further. Every item carries a body and custom
   * fields at realistic length, since the payload is dominated by field
   * size rather than row count (#107).
   */
  async function seedRealisticCorpus(): Promise<{ sampleItemId: string; sessionId: string }> {
    // ~2KB of body per item — the scale the measured corpus carries, and
    // the reason a row-count bound was never sufficient.
    const body = "This item carries a realistic amount of prose. ".repeat(45);
    const customFields = JSON.stringify({
      notes: "a realistic custom field payload. ".repeat(30),
      links: Array.from({ length: 8 }, (_, i) => `ref-${i}`),
    });

    const plan: { state: string; count: number }[] = [
      { state: "merged", count: 140 },
      { state: "cancelled", count: 20 },
      { state: "on_deck", count: 55 },
      { state: "someday", count: 15 },
      { state: "executing", count: 18 },
      { state: "in_review", count: 9 },
      { state: "blocked", count: 7 },
      { state: "paused", count: 5 },
    ];

    // `Item.area` is a foreign key; the area has to exist first.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      "bounded-reads",
    );

    let sample = "";
    for (const { state, count } of plan) {
      for (let i = 0; i < count; i++) {
        const id = `bounded-${state}-${i}`;
        // Inserted directly rather than created + transitioned: reaching
        // `merged` legitimately needs artifacts and a full state-machine
        // walk per item, and this file is about the size of a read, not
        // about how an item got to its state. 269 legitimate walks would
        // also dominate the file's runtime.
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Item" ("id", "kind", "title", "body", "state", "priority", "area", "originType", "driveMode", "mergeAuthority", "customFields", "createdAt", "updatedAt")
           VALUES ($1, 'task'::"ItemKind", $2, $3, $4::"ItemState", 'P2'::"Priority", 'bounded-reads', 'auto'::"OriginType", 'autonomous'::"DriveMode", 'agent_judgement'::"MergeAuthority", $5::jsonb, now() - ($6 || ' seconds')::interval, now())`,
          id,
          `A realistically titled piece of work number ${i} in ${state}`,
          body,
          state,
          customFields,
          String(i),
        );
        // The area filter reads the `ItemArea` join table, never
        // `Item.area` — see `areaFilterCondition`.
        await prisma.$executeRawUnsafe(
          `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, 'bounded-reads') ON CONFLICT DO NOTHING`,
          id,
        );
        if (state === "executing" && i === 0) sample = id;
      }
    }

    // A session, so the session-scoped reads have a real subject rather
    // than returning empty and passing vacuously.
    //
    // Inserted directly rather than through `register_session`, because the
    // transport a registration arrived over is stamped by the adapter and
    // cannot be supplied by a direct service call — and this file is about
    // the size of a read, not about the registration handshake.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Session" ("id", "machine", "transport") VALUES ($1, 'test-machine', 'http'::"SessionTransport") ON CONFLICT DO NOTHING`,
      "bounded-reads-session",
    );

    return { sampleItemId: sample, sessionId: "bounded-reads-session" };
  }

  /**
   * The arguments each read needs to return something real.
   *
   * A read handed nothing returns nothing and passes this file without
   * exercising anything, so the reads that take a subject are given one.
   * Anything absent from this map is called with `{}` — which is the case
   * that matters most, since an unfiltered call is exactly the one that
   * overflows.
   */
  function inputFor(name: string): Record<string, unknown> {
    switch (name) {
      case "orientation":
      case "get_item":
      case "get_item_detail":
        return { itemId: sampleItemId };
      case "my_work":
        return { sessionId };
      case "describe_tool":
        return { tool: "get_board" };
      case "get_setting":
        return { key: "budget.weekly.tokens" };
      case "get_area":
        return { id: "bounded-reads" };
      case "get_repo":
      case "get_machine":
      case "get_account":
        return { id: "nonexistent" };
      case "kill_guard":
        return { pid: 1, sessionId };
      // `get_costs` has a required `groupBy`, so an unfiltered call is
      // refused before it reads anything — and a refusal is treated here as
      // a bounded answer, which would let this operation pass the sweep
      // without its payload ever being measured. Supplying the grouping
      // with the largest cardinality is what puts it back under the
      // assertion: one row per session that has ever run is the shape most
      // able to grow without bound.
      case "get_costs":
        return { groupBy: "session" };
      default:
        return {};
    }
  }

  /**
   * Reads excluded from the size sweep, each for a stated reason.
   *
   * Kept deliberately tiny and named: a waiver list is the easiest place to
   * quietly park the operation that actually overflows, so every entry has
   * to justify itself as *structurally* bounded — its size fixed by a
   * schema or a primary key — rather than by how much data happens to sit
   * behind it.
   */
  const NOT_SIZE_BOUNDED: ReadonlySet<string> = new Set([
    // Returns one row by primary key or throws — its size is one item, and
    // an item's own size is #107's territory rather than this row's.
    "get_item",
    // Returns the operation catalogue: one line per registered operation,
    // bounded by the size of the registry itself, which no corpus grows.
    "service_info",
    // One named tool's contract — bounded by the schema, not the corpus.
    "describe_tool",
    // A single settings snapshot; bounded by the settings registry.
    "get_setting",
    "get_settings",
  ]);

  const readOperations = operationsOfKind("read").filter(
    (operation) => !NOT_SIZE_BOUNDED.has(operation.name),
  );

  // The guard against the whole sweep silently covering nothing — a filter
  // typo or a registry rename would otherwise leave this file green while
  // asserting on an empty list.
  it("sweeps a meaningful number of read operations", () => {
    expect(readOperations.length).toBeGreaterThanOrEqual(10);
    // And the two that actually overflowed are definitely in it.
    const names = readOperations.map((operation) => operation.name);
    expect(names).toContain("get_board");
    expect(names).toContain("orientation");
  });

  /**
   * Whether a thrown value is the service refusing the *call* rather than
   * the read returning something too large.
   *
   * A refusal is not a payload and cannot overflow anything: an operation
   * that needs an id this sweep did not supply says so, in a few dozen
   * characters, and that is the system working. Treating a refusal as a
   * failure here would turn this file into a test of whether every read's
   * arguments happen to be spelled correctly in `inputFor` — which is not
   * what it is for, and which would make it noisy enough to be ignored.
   *
   * **Only these two kinds are tolerated.** Anything else — a crash, a
   * database error, a bug in the operation — still fails the test, because
   * those are not the system declining to answer.
   */
  function isRefusal(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "invalid_input" || code === "not_found";
  }

  // The row's assertion, applied to every read there is.
  for (const operation of readOperations) {
    it(`${operation.name} returns a tenable payload with no filters`, async () => {
      let result: unknown;
      try {
        result = await runtime.call(
          operation.name as keyof typeof OPERATION_REGISTRY,
          inputFor(operation.name) as never,
        );
      } catch (error) {
        // A refusal is a bounded answer by construction — see `isRefusal`.
        if (isRefusal(error)) return;
        throw error;
      }
      const size = payloadSize(result);
      expect(
        size,
        `${operation.name} returned ${size} characters, over the ${TENABLE_PAYLOAD_CHARS} bound`,
      ).toBeLessThanOrEqual(TENABLE_PAYLOAD_CHARS);
    });
  }

  // The guard on the escape hatch above: if every read in the sweep were
  // refused, each individual case would return early and the whole file
  // would pass having measured nothing at all. So the reads that must
  // genuinely produce a payload are named, and measured, explicitly.
  it("actually measures the reads that overflowed, rather than skipping them as refusals", async () => {
    for (const name of ["get_board", "list_items", "orientation", "my_work"] as const) {
      const result = await runtime.call(name, inputFor(name) as never);
      const size = payloadSize(result);
      expect(size).toBeGreaterThan(0);
      expect(size, `${name} returned ${size} characters`).toBeLessThanOrEqual(
        TENABLE_PAYLOAD_CHARS,
      );
    }
  });

  // The `full` projection is where the payload actually lived: #107 made the
  // slim shape the default, so a bound checked only against the default
  // never sees the columns that were 99% of the measured response. On this
  // corpus an unbounded `full` board read is ~1,045,000 characters — the
  // single largest thing either row is about — so it is asserted directly
  // rather than left to the default-shaped sweep above.
  it("bounds the full projection too, which is where the payload actually was", async () => {
    for (const input of [
      { full: true },
      { full: true, column: "backlog" },
      { full: true, column: "completed" },
    ]) {
      const result = await runtime.call("get_board", input as never);
      const size = payloadSize(result);
      expect(
        size,
        `get_board ${JSON.stringify(input)} returned ${size} characters`,
      ).toBeLessThanOrEqual(TENABLE_PAYLOAD_CHARS);
    }
  });

  // The corpus has to be big enough that an unbounded read would fail the
  // bound above — otherwise every assertion in the loop is vacuous. This
  // measures the thing the loop is protecting against, directly.
  // Without this, every assertion above could be vacuous: a corpus that
  // cannot overflow the bound proves nothing about bounding. This measures
  // the unbounded read directly and requires it to be over the line — by a
  // wide margin, so the file does not quietly become vacuous as the seed
  // data drifts.
  it("is seeded richly enough that an unbounded read would breach the bound", async () => {
    const everything =
      await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "Item"`);
    expect(payloadSize(everything)).toBeGreaterThan(TENABLE_PAYLOAD_CHARS * 5);
  });
});
