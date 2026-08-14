// MILESTONES.md #102 — the four item mutations write through the one writer.
//
// `create_item`, `update_item`, `transition_item` and `complete_item` each
// wrote their `events` row with an inline INSERT whose column list stopped at
// `("itemId", "actorType", "actorId", "type", "payload")`. Three columns the
// table has were never populated by those paths: `session_id`,
// `assignment_id` and `body`.
//
// **What this file asserts, and why it is not covered elsewhere.** The
// existing operation tests already check that an event of the right *type*
// with the right *payload* is appended — and every one of them passed while
// `session_id` was null on every row, because none of them looks at that
// column. So the regression this row fixes is invisible to a test that asks
// "was an event written". These tests read the columns themselves.
//
// The negative cases are the load-bearing half. A caller with no session must
// still write its row with a null session, and a released assignment must not
// be credited — an attribution that fires unconditionally is not attribution,
// it is decoration.
//
// Runs against a real Postgres: the claim is about column values in rows that
// were actually inserted. Skips without TEST_DATABASE_URL, like every other
// DB-backed file here.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, guardRegistry, prismaTransactionRunner } from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/**
 * The invariant as a source check, not a behaviour check — and it needs no
 * database, so it runs everywhere.
 *
 * The tests below prove that the four operations they name attribute their
 * events. They cannot prove it of a fifth operation nobody has written yet:
 * a new inline `INSERT INTO "Event"` would write a row with a null session
 * and every one of those tests would still pass, because none of them looks
 * at an operation it does not name. That is exactly how the four in this row
 * got there.
 *
 * ESLint's `no-restricted-paths` zone already stops anything importing
 * `events-insert.ts` directly, but it cannot see a hand-rolled SQL string —
 * which is the form all four of these actually took.
 *
 * **Scope, stated precisely, because the qualifier is the whole claim.** This
 * asserts the invariant over every `.ts`/`.tsx` file under `src` — the API
 * routes and the CLI binaries included, not the service layer alone. An
 * unqualified "the only file containing the statement" is only true of what
 * is actually scanned, so widening the scan is what makes the sentence
 * honest rather than merely confident.
 */
describe("the events ledger has exactly one writer", () => {
  // The whole of `src`, not just `src/lib`. Scoping this to the service
  // directory made the check blind to `src/app` and `src/bin` — a fifth
  // writer appearing in an API route or a CLI binary passed green, and so
  // did every other check in the repository, because none of them can see a
  // hand-rolled SQL string either. A check that inspects only the directory
  // where the problem has already been fixed certifies nothing about the
  // places it could next appear.
  const SOURCE_DIR = path.resolve(import.meta.dirname, "../src");
  /**
   * The one module allowed to contain the statement, as a path relative to
   * `SOURCE_DIR`.
   *
   * A path rather than a bare file name, because widening the scan to all of
   * `src` brought in many duplicated basenames (`route.ts`, `index.ts`,
   * `http.ts` and a dozen more appear repeatedly). Matching on basename
   * would mean any file that happened to be named `events-insert.ts`
   * anywhere under `src` was exempt — an allowlist that grows itself is not
   * an allowlist.
   */
  const WRITERS = new Set([path.join("lib", "events-insert.ts")]);

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...sourceFiles(full));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        found.push(full);
      }
    }
    return found;
  }

  const scanned = sourceFiles(SOURCE_DIR).map((file) => path.relative(SOURCE_DIR, file));

  it("scans the API routes and the CLI binaries, not only the service layer", () => {
    // Guards the guard. The assertion below is an `toEqual([])` over a
    // filtered list, which passes just as happily over a list that was empty
    // because nothing was scanned. This is what makes the difference
    // between the two visible — and it is the exact gap that let a seeded
    // violation in `src/app` pass.
    expect(scanned.some((file) => file.startsWith(`app${path.sep}`))).toBe(true);
    expect(scanned.some((file) => file.startsWith(`bin${path.sep}`))).toBe(true);
    expect(scanned.some((file) => file.startsWith(`lib${path.sep}`))).toBe(true);
  });

  it("names a writer that actually exists", () => {
    // An allowlist entry that matches no file exempts nothing and is dead
    // weight that reads as protection — the same failure mode as a stale
    // waiver in the external-refs check.
    for (const writer of WRITERS) {
      expect(scanned).toContain(writer);
    }
  });

  it('has no INSERT INTO "Event" outside events-insert.ts', () => {
    const offenders = scanned
      .filter((file) => !WRITERS.has(file))
      .filter((file) =>
        readFileSync(path.join(SOURCE_DIR, file), "utf8").includes('INSERT INTO "Event"'),
      );

    // Seeding a single `INSERT INTO "Event"` into any file under `src` makes
    // this fail — including an API route or a CLI binary, which is the
    // change that proves the widened scope is doing work.
    expect(offenders).toEqual([]);
  });
});

interface EventRow {
  type: string;
  payload: unknown;
  actorType: string;
  actorId: string | null;
  sessionId: string | null;
  assignmentId: string | null;
  body: string | null;
}

describeIfDb("item mutations attribute their events (#102)", () => {
  const dbName = scratchDatabaseName("item_event_attribution");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });

    for (const guard of ALL_GUARDS) {
      if (!guardRegistry.has(guard.id)) guardRegistry.register(guard);
    }

    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "Summary"`);
    await prisma.artifact.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let counter = 0;
  async function seedItem(state = "executing", overrides: Record<string, unknown> = {}) {
    counter += 1;
    const id = `attr-item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${counter}`,
        body: "body",
        state: state as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
        ...overrides,
      },
    });
    return id;
  }

  /** A live claim held by `sessionId`, returning the assignment's own id. */
  async function claimFor(itemId: string, sessionId: string): Promise<string> {
    const assignment = await prisma.assignment.create({
      data: {
        itemId,
        holderType: "agent",
        holderId: "agent-a",
        sessionId,
        rootSessionId: sessionId,
        machine: "laptop",
        role: "builder",
      },
    });
    return assignment.id;
  }

  async function eventsFor(itemId: string): Promise<EventRow[]> {
    return prisma.$queryRawUnsafe<EventRow[]>(
      `SELECT "type", "payload", "actorType", "actorId", "sessionId", "assignmentId", "body"
         FROM "Event" WHERE "itemId" = $1 ORDER BY "id" ASC`,
      itemId,
    );
  }

  function validSummary() {
    return {
      shipped: ["Delivered the thing."],
      not_done: [],
      user_facing: false,
      how_verified: "Ran it locally and watched it work end to end.",
      watch_for: [],
    };
  }

  describe("create_item", () => {
    it("records the caller's session on the creation event", async () => {
      const item = (await runtime.call(
        "create_item",
        { title: "New", body: "b", area: "web", originType: "auto" },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      )) as { id: string };

      const events = await eventsFor(item.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("field_change");
      // The column this row exists to stop losing. It was available at the
      // call site the whole time and had nowhere to go in a five-column
      // insert, so every creation event landed with a null session.
      expect(events[0]?.sessionId).toBe("session-1");
      expect(events[0]?.actorType).toBe("agent");
      expect(events[0]?.actorId).toBe("agent-a");
      expect(events[0]?.payload).toEqual({ field: "state", from: null, to: "on_deck" });
    });

    it("writes a null session for a caller that has none", async () => {
      const item = (await runtime.call("create_item", {
        title: "New",
        body: "b",
        area: "web",
        originType: "auto",
      })) as { id: string };

      const events = await eventsFor(item.id);
      // The complement of the test above. A helper that stamped a session
      // unconditionally would pass that one and fail here.
      expect(events[0]?.sessionId).toBeNull();
      expect(events[0]?.actorType).toBe("system");
      expect(events[0]?.actorId).toBeNull();
    });

    it("leaves the assignment null — nothing can hold a claim on an item being created", async () => {
      const item = (await runtime.call(
        "create_item",
        { title: "New", body: "b", area: "web", originType: "auto" },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      )) as { id: string };

      const events = await eventsFor(item.id);
      expect(events[0]?.assignmentId).toBeNull();
    });
  });

  describe("update_item", () => {
    it("records the session and the live assignment on each field_change", async () => {
      const id = await seedItem();
      const assignmentId = await claimFor(id, "session-1");

      await runtime.call(
        "update_item",
        { id, title: "Renamed", priority: "P1" },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      );

      const events = await eventsFor(id);
      // One row per changed field — the existing behaviour, unchanged.
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.type).toBe("field_change");
        expect(event.sessionId).toBe("session-1");
        expect(event.assignmentId).toBe(assignmentId);
      }
      expect(events.map((event) => (event.payload as { field: string }).field).sort()).toEqual([
        "priority",
        "title",
      ]);
    });

    it("does not credit an assignment held by a different session", async () => {
      const id = await seedItem();
      await claimFor(id, "session-other");

      await runtime.call(
        "update_item",
        { id, title: "Renamed" },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      );

      const events = await eventsFor(id);
      // Someone else's claim is not this caller's attribution. Looking up by
      // item alone would have credited it.
      expect(events[0]?.assignmentId).toBeNull();
      expect(events[0]?.sessionId).toBe("session-1");
    });

    it("does not credit a released assignment", async () => {
      const id = await seedItem();
      const assignmentId = await claimFor(id, "session-1");
      await prisma.assignment.update({
        where: { id: assignmentId },
        data: { releasedAt: new Date() },
      });

      await runtime.call(
        "update_item",
        { id, title: "Renamed" },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      );

      const events = await eventsFor(id);
      // A finished session's identity must not be attached to work done
      // after it let go. Dropping `releasedAt IS NULL` from the lookup makes
      // this the only failing test.
      expect(events[0]?.assignmentId).toBeNull();
    });

    it("still writes nothing for a no-op edit", async () => {
      const id = await seedItem();
      await runtime.call(
        "update_item",
        { id, title: `Task ${counter}` },
        { caller: { sessionId: "session-1" } },
      );

      // The diff is computed from the STORED form, and re-diffing raw input
      // against the loaded row would resurrect the phantom field_change this
      // operation already fixed once. Routing through `recordFieldChanges`
      // must not reintroduce it.
      expect(await eventsFor(id)).toHaveLength(0);
    });

    it("writes nothing for a mergeAuthority no-op, whose API and stored spellings differ", async () => {
      const id = await seedItem("executing", { mergeAuthority: "needs_approval" });
      await runtime.call(
        "update_item",
        { id, mergeAuthority: "needs-approval" },
        { caller: { sessionId: "session-1" } },
      );

      // The specific case that produced a phantom event before: the API
      // spells it with a hyphen and the enum with an underscore, so a naive
      // comparison always disagrees and reports a change that did not happen.
      expect(await eventsFor(id)).toHaveLength(0);
    });
  });

  describe("transition_item", () => {
    it("records the session and the live assignment on the state_change", async () => {
      const id = await seedItem();
      const assignmentId = await claimFor(id, "session-1");

      await runtime.call(
        "transition_item",
        { id, to: "someday" },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      );

      const events = await eventsFor(id);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("state_change");
      // "Who moved this" is the question a state change most needs to
      // answer, and it was the one with no answer.
      expect(events[0]?.sessionId).toBe("session-1");
      expect(events[0]?.assignmentId).toBe(assignmentId);
      expect(events[0]?.payload).toEqual({ from: "executing", to: "someday" });
    });

    it("writes a null session and assignment for a caller holding neither", async () => {
      const id = await seedItem();
      await runtime.call("transition_item", { id, to: "someday" });

      const events = await eventsFor(id);
      expect(events[0]?.sessionId).toBeNull();
      expect(events[0]?.assignmentId).toBeNull();
      expect(events[0]?.actorType).toBe("system");
    });
  });

  describe("complete_item", () => {
    it("records the session and the live assignment on the completing state_change", async () => {
      const id = await seedItem("in_review");
      const assignmentId = await claimFor(id, "session-1");

      await runtime.call(
        "complete_item",
        { id, to: "research_done", summary: validSummary() },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      );

      const events = await eventsFor(id);
      const stateChange = events.find((event) => event.type === "state_change");
      // SCHEMA.md's point about completion: the ledger should not be able to
      // tell a completion from an ordinary transition by which columns
      // happen to be populated.
      expect(stateChange?.sessionId).toBe("session-1");
      expect(stateChange?.assignmentId).toBe(assignmentId);
      expect(stateChange?.payload).toEqual({ from: "in_review", to: "research_done" });
    });
  });

  describe("the invariant itself", () => {
    it("appends every item event through the one writer, so txId is always set", async () => {
      const id = await seedItem();
      await claimFor(id, "session-1");
      await runtime.call(
        "update_item",
        { id, title: "Renamed" },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      );
      await runtime.call(
        "transition_item",
        { id, to: "someday" },
        { caller: { sessionId: "session-1", actor: "agent-a" } },
      );

      const rows = await prisma.$queryRawUnsafe<{ txId: bigint | null }[]>(
        `SELECT "txId" FROM "Event" WHERE "itemId" = $1`,
        id,
      );
      expect(rows).toHaveLength(2);
      // `txId` is the column the visibility horizon reads to guarantee no
      // reader permanently skips a row. It comes from a default the single
      // writer relies on, so this is a cheap standing check that nothing has
      // gone back to hand-rolling an INSERT that omits it.
      for (const row of rows) {
        expect(row.txId).not.toBeNull();
      }
    });
  });
});
