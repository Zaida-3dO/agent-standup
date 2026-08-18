// M10 T3 — `get_board` and `get_item_detail` return who is on the work.
//
// **What would make this file hollow.** Asserting that a held item comes
// back with a non-empty `assignments` array proves almost nothing: so does
// an implementation that returns the same constant for every item. The
// load-bearing assertions here are therefore about **discrimination** —
// that an unheld item and a held one differ, that a *released* holder does
// not appear as a current one, that `stalled` is not reported as `running`,
// that the slim shape genuinely omits the columns it claims to omit, and
// that the whole page costs one assignment query rather than one per card.
//
// Each test below names the single-character change that would break it.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem, type ClaimInput } from "@/lib/claims";
import type { BoardOutput } from "@/lib/service/operations/get-board";
import type { ItemDetailOutput } from "@/lib/service/operations/get-item-detail";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the reads report who is on the work", () => {
  const dbName = scratchDatabaseName("assignments_in_reads");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  const AREA = "ownership-tests";

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

  let seq = 0;

  /**
   * A task in `executing`, so it lands in the `in_progress` column.
   *
   * Inserted directly rather than through `create_item`, which mints
   * everything in its default state and has no `state` input — the same
   * fixture route `tests/board-pagination.test.ts` takes, including its
   * `ItemArea` join row, without which an area-filtered read cannot see it.
   */
  async function makeExecutingItem(label: string): Promise<string> {
    const id = `own-${seq++}-${label.replace(/[^a-z0-9]+/gi, "-")}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      AREA,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Item" ("id", "kind", "title", "body", "state", "priority", "area", "originType", "driveMode", "mergeAuthority", "createdAt", "updatedAt")
       VALUES ($1, 'task'::"ItemKind", $2, 'body', 'executing'::"ItemState", 'P2'::"Priority", $3, 'auto'::"OriginType", 'autonomous'::"DriveMode", 'agent_judgement'::"MergeAuthority", now(), now())`,
      id,
      label,
      AREA,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      id,
      AREA,
    );
    return id;
  }

  async function claim(input: Partial<ClaimInput> & { itemId: string; sessionId: string }) {
    return prisma.$transaction((tx) =>
      claimItem(tx, {
        role: "builder",
        holderType: "agent",
        holderId: "crew-one",
        machine: "desktop",
        ...input,
      } as ClaimInput),
    );
  }

  /** The `in_progress` page, which is where every fixture below sits. */
  async function board(input: Record<string, unknown> = {}): Promise<BoardOutput> {
    return (await runtime.call("get_board", {
      column: "in_progress",
      limit: 200,
      ...input,
    })) as BoardOutput;
  }

  function entryFor(result: BoardOutput, itemId: string) {
    const entry = result.columns.in_progress.entries.find((e) => e.item.id === itemId);
    if (!entry) throw new Error(`Item ${itemId} was not on the in_progress page.`);
    return entry;
  }

  async function detail(id: string): Promise<ItemDetailOutput> {
    return (await runtime.call("get_item_detail", { id })) as ItemDetailOutput;
  }

  describe("an item with no assignment", () => {
    it("comes back with an empty list on the board, not a missing field", async () => {
      // The distinction #123 established, applied to ownership: "nobody
      // holds this" and "this read does not report ownership" must not
      // render identically. A card can only draw *no presence* if the key
      // is present and empty.
      //
      // Breaks if: `assignments: assignmentsByItem.get(id) ?? []` loses its
      // `?? []` — the field becomes `undefined` and this fails on both the
      // `toEqual` and the `in` check.
      const id = await makeExecutingItem("unheld on the board");
      const entry = entryFor(await board(), id);

      expect(entry.assignments).toEqual([]);
      expect("assignments" in entry).toBe(true);
    });

    it("comes back with both lists empty on the detail read", async () => {
      // Breaks if: either list is initialised to anything but `[]`, or the
      // partition pushes an unheld item's absent row somewhere.
      const id = await makeExecutingItem("unheld on detail");
      const result = await detail(id);

      expect(result.assignments).toEqual([]);
      expect(result.previousHolders).toEqual([]);
    });
  });

  describe("one live holder", () => {
    it("names the holder, the role and the liveness on the board card", async () => {
      // The discrimination that matters: this item's list is NOT the empty
      // list the unheld item above got, and it carries the holder that
      // actually claimed it rather than any holder.
      //
      // Breaks if: the `WHERE a."itemId" = ANY($1::text[])` loses its item
      // predicate — every card would then get every assignment and
      // `holderId` would be some other crew's.
      const id = await makeExecutingItem("held by one");
      await claim({ itemId: id, sessionId: "s-live-1", holderId: "crew-live", role: "builder" });

      const entry = entryFor(await board(), id);
      expect(entry.assignments).toHaveLength(1);
      expect(entry.assignments[0]).toMatchObject({
        holderId: "crew-live",
        holderType: "agent",
        role: "builder",
        liveness: "running",
      });
    });

    it("labels an agent holder with its crew name, because that IS its name", async () => {
      // An agent's `holderId` is the crew name handed out by agent-names.ts,
      // so no `Person` row exists for it and the fallback is the id itself.
      //
      // Breaks if: `displayNameFor` returns `row.personDisplayName` without
      // the `?? row.holderId` fallback — `displayName` becomes null and this
      // fails.
      const id = await makeExecutingItem("agent display name");
      await claim({ itemId: id, sessionId: "s-agent-name", holderId: "crew-named" });

      const entry = entryFor(await board(), id);
      expect(entry.assignments[0]?.displayName).toBe("crew-named");
    });

    it("labels a person holder with their display name, not their id", async () => {
      // The other branch, and the one that stops `displayName` being a
      // synonym for `holderId`. A mutant that dropped the `LEFT JOIN
      // "Person"` entirely passes the agent test above and fails here.
      await prisma.person.create({
        data: { id: "person-holder", displayName: "A Second User" },
      });
      const id = await makeExecutingItem("person display name");
      await claim({
        itemId: id,
        sessionId: "s-person",
        holderType: "person",
        holderId: "person-holder",
        role: "orchestrator",
      });

      const entry = entryFor(await board(), id);
      expect(entry.assignments[0]).toMatchObject({
        holderId: "person-holder",
        holderType: "person",
        displayName: "A Second User",
      });
      // The point of the join: the label is not the id.
      expect(entry.assignments[0]?.displayName).not.toBe("person-holder");
    });

    it("returns every concurrent holder, not just one", async () => {
      // SCHEMA.md §2 allows an orchestrator plus a builder plus reviewers on
      // one item at once. A scalar field would have to pick one and hide the
      // rest.
      //
      // Breaks if: the board attach takes `[0]` of the grouped list, or the
      // group function overwrites rather than appends.
      const id = await makeExecutingItem("held by a crew");
      await claim({
        itemId: id,
        sessionId: "s-crew-orch",
        rootSessionId: "s-crew-orch",
        holderId: "crew-orch",
        role: "orchestrator",
      });
      await claim({
        itemId: id,
        sessionId: "s-crew-build",
        rootSessionId: "s-crew-orch",
        holderId: "crew-build",
        role: "builder",
      });

      const entry = entryFor(await board(), id);
      expect(entry.assignments.map((a) => a.role)).toEqual(["orchestrator", "builder"]);
    });

    it("returns the full shape on the detail read — machine, branch, session and the rest", async () => {
      // The half the board deliberately does not carry. Every field here is
      // one a card cannot show and the ownership block exists to.
      //
      // Breaks if: any column is dropped from
      // `ITEM_DETAIL_ASSIGNMENT_COLUMNS` or from `toItemDetailAssignment`.
      const id = await makeExecutingItem("full detail shape");
      await claim({
        itemId: id,
        sessionId: "s-full",
        rootSessionId: "s-full-root",
        holderId: "crew-full",
        role: "reviewer",
        machine: "laptop",
        branch: "feat/a-branch",
        worktree: "/w/a-worktree",
        model: "a-model",
        effort: "high",
        pid: 4242,
      });

      const result = await detail(id);
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0]).toMatchObject({
        holderId: "crew-full",
        role: "reviewer",
        liveness: "running",
        machine: "laptop",
        branch: "feat/a-branch",
        worktree: "/w/a-worktree",
        model: "a-model",
        effort: "high",
        sessionId: "s-full",
        rootSessionId: "s-full-root",
        pid: 4242,
        releasedAt: null,
      });
      expect(typeof result.assignments[0]?.lastActive).toBe("string");
      expect(typeof result.assignments[0]?.claimedAt).toBe("string");
    });

    it("does NOT carry the detail-only columns on a board card", async () => {
      // The slim shape's whole justification. `get_board` has already
      // overflowed a context window once, so this asserts the columns are
      // *absent*, not merely unused — an assertion that only checked the
      // seven present fields would go green against an implementation that
      // shipped all eighteen.
      //
      // Breaks if: `BOARD_ASSIGNMENT_COLUMNS` is pointed at the full column
      // list, or the board read is switched to `ALL_ITEM_ASSIGNMENTS_SQL`.
      const id = await makeExecutingItem("slim on the board");
      await claim({
        itemId: id,
        sessionId: "s-slim",
        holderId: "crew-slim",
        machine: "desktop",
        branch: "feat/not-on-a-card",
        worktree: "/w/not-on-a-card",
        model: "a-model",
        pid: 99,
      });

      const assignment = entryFor(await board(), id).assignments[0]!;
      for (const absent of [
        "machine",
        "branch",
        "worktree",
        "model",
        "effort",
        "sessionId",
        "rootSessionId",
        "pid",
        "claimedAt",
        "releasedAt",
        "id",
      ]) {
        expect(Object.keys(assignment)).not.toContain(absent);
      }
      // And exactly the seven a card draws, so a field added silently is a
      // failing test rather than a quietly wider payload.
      expect(Object.keys(assignment).sort()).toEqual([
        "displayName",
        "holderId",
        "holderType",
        "lastActive",
        "liveness",
        "role",
        "roleCustom",
      ]);
    });

    it("does not even SELECT the detail-only columns for a board", async () => {
      // The assertion above is about the mapped response, and it is blind to
      // one real regression: pointing the board's SQL at the full column
      // list still produces a correct slim response, because the mapper
      // picks seven fields out of whatever the row carries. That mutant
      // survives an output-only check while making every board read drag ten
      // unused columns — including a worktree path — out of Postgres for
      // every card.
      //
      // So this asserts on the statement itself, which is the layer the
      // mutation touches.
      //
      // Breaks if: `LIVE_BOARD_ASSIGNMENTS_SQL` is built from
      // `ITEM_DETAIL_ASSIGNMENT_COLUMNS`.
      const { LIVE_BOARD_ASSIGNMENTS_SQL, ALL_ITEM_ASSIGNMENTS_SQL } =
        await import("@/lib/service/items/assignment-view");
      for (const column of ["worktree", "machine", "sessionId", "pid", "model", "effort"]) {
        expect(LIVE_BOARD_ASSIGNMENTS_SQL).not.toContain(`"${column}"`);
        // The same column on the detail statement, so this cannot pass by
        // the two statements both being empty of everything.
        expect(ALL_ITEM_ASSIGNMENTS_SQL).toContain(`"${column}"`);
      }
    });
  });

  describe("a stalled holder", () => {
    it("reports stalled as stalled, not as running and not as dead", async () => {
      // Four values, four meanings. A UI that had to guess back from a
      // collapsed pair would report a stalled session as either working or
      // gone, and both are wrong.
      //
      // Breaks if: `liveness` is hardcoded, defaulted, or mapped through
      // anything on the way out.
      const id = await makeExecutingItem("stalled holder");
      await claim({ itemId: id, sessionId: "s-stalled", holderId: "crew-stalled" });
      await prisma.assignment.updateMany({
        where: { itemId: id, sessionId: "s-stalled" },
        data: { liveness: "stalled" },
      });

      const entry = entryFor(await board(), id);
      expect(entry.assignments[0]?.liveness).toBe("stalled");

      const result = await detail(id);
      expect(result.assignments[0]?.liveness).toBe("stalled");
    });

    it("keeps superseded distinct from dead", async () => {
      // `superseded` is the *expected* end state of a row a takeover
      // replaced — not a failure at all — so collapsing it onto `dead`
      // would render a normal handover as a crash.
      //
      // Breaks if: the two are mapped to one value anywhere between the
      // column and the response.
      const deadId = await makeExecutingItem("dead holder");
      await claim({ itemId: deadId, sessionId: "s-dead", holderId: "crew-dead" });
      await prisma.assignment.updateMany({
        where: { itemId: deadId },
        data: { liveness: "dead" },
      });

      const supersededId = await makeExecutingItem("superseded holder");
      await claim({ itemId: supersededId, sessionId: "s-sup", holderId: "crew-sup" });
      await prisma.assignment.updateMany({
        where: { itemId: supersededId },
        data: { liveness: "superseded" },
      });

      const result = await board();
      expect(entryFor(result, deadId).assignments[0]?.liveness).toBe("dead");
      expect(entryFor(result, supersededId).assignments[0]?.liveness).toBe("superseded");
    });

    it("a stalled holder is still a live assignment — it has not been released", async () => {
      // Liveness and release are independent: a stalled session still holds
      // the item, which is exactly why a stale claim needs a sweep to free
      // it. Reporting it under `previousHolders` would say it had let go.
      //
      // Breaks if: the partition tests `liveness` instead of `releasedAt`.
      const id = await makeExecutingItem("stalled is not released");
      await claim({ itemId: id, sessionId: "s-stalled-live", holderId: "crew-stalled-live" });
      await prisma.assignment.updateMany({
        where: { itemId: id },
        data: { liveness: "stalled" },
      });

      const result = await detail(id);
      expect(result.assignments).toHaveLength(1);
      expect(result.previousHolders).toEqual([]);
    });
  });

  describe("a released-then-reclaimed item", () => {
    it("reports only the current holder as current, and the former one as previous", async () => {
      // The question this makes answerable: *who had this before it
      // stalled*. Nothing else in the store records a holder that has let
      // go, so a read that returned only live rows would drop it entirely,
      // and one that merged both lists would report two current holders on
      // an item held by one.
      //
      // Breaks if: `LIVE_BOARD_ASSIGNMENTS_SQL` loses `AND a."releasedAt"
      // IS NULL`, or the detail partition's comparison is flipped.
      const id = await makeExecutingItem("released then reclaimed");
      await claim({ itemId: id, sessionId: "s-first", holderId: "crew-first", role: "builder" });
      await runtime.call("release", { itemId: id, sessionId: "s-first" });
      await claim({ itemId: id, sessionId: "s-second", holderId: "crew-second", role: "builder" });

      const result = await detail(id);
      expect(result.assignments.map((a) => a.holderId)).toEqual(["crew-second"]);
      expect(result.previousHolders.map((a) => a.holderId)).toEqual(["crew-first"]);
      // A previous holder carries the moment it stopped being current —
      // without it the row is a name with no position in time.
      expect(result.previousHolders[0]?.releasedAt).not.toBeNull();
      expect(result.assignments[0]?.releasedAt).toBeNull();
    });

    it("shows only the current holder on the board, never the released one", async () => {
      // The board's slim read has no `previousHolders` at all, so a released
      // row leaking into it would be indistinguishable from a current one —
      // a card claiming an agent is on work they let go of.
      //
      // Breaks if: the live predicate is dropped from the board SQL. This
      // fails on the length as well as the name, so a mutant that merely
      // reordered would not slip through.
      const id = await makeExecutingItem("board shows current only");
      await claim({ itemId: id, sessionId: "s-b-first", holderId: "crew-b-first" });
      await runtime.call("release", { itemId: id, sessionId: "s-b-first" });
      await claim({ itemId: id, sessionId: "s-b-second", holderId: "crew-b-second" });

      const entry = entryFor(await board(), id);
      expect(entry.assignments).toHaveLength(1);
      expect(entry.assignments[0]?.holderId).toBe("crew-b-second");
    });

    it("an item whose only holder released it has no current holder and one previous", async () => {
      // The boundary between the two lists, from the other side: a fully
      // released item is unheld *now* and still has a history. Both halves
      // matter — a read that reported the released row as current would
      // pass the previous-holder assertion alone.
      const id = await makeExecutingItem("released and left");
      await claim({ itemId: id, sessionId: "s-gone", holderId: "crew-gone" });
      await runtime.call("release", { itemId: id, sessionId: "s-gone" });

      const result = await detail(id);
      expect(result.assignments).toEqual([]);
      expect(result.previousHolders.map((a) => a.holderId)).toEqual(["crew-gone"]);

      const entry = entryFor(await board(), id);
      expect(entry.assignments).toEqual([]);
    });
  });

  describe("the board's assignment read does not scale with the page", () => {
    it("costs ONE assignment query for a whole page, however many cards it has", async () => {
      // The N+1 this feature is most likely to have been implemented as: a
      // card-by-card holder fetch, correct in every assertion above and
      // sixty-eight round trips on a real board.
      //
      // Counted rather than inspected: the count is taken from Prisma's own
      // query event stream, so it measures statements that actually reached
      // Postgres.
      //
      // Breaks if: the attach pass is moved inside a per-entry loop — the
      // count becomes one per card and the `toBe(1)` fails.
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        const id = await makeExecutingItem(`n-plus-one ${i}`);
        await claim({
          itemId: id,
          sessionId: `s-npo-${i}`,
          holderId: `crew-npo-${i}`,
        });
        ids.push(id);
      }

      const logged = new PrismaClient({
        datasourceUrl: scratchUrl,
        log: [{ emit: "event", level: "query" }],
      });
      const statements: string[] = [];
      logged.$on("query", (event: { query: string }) => statements.push(event.query));
      const loggedRuntime = new ServiceRuntime({
        transaction: prismaTransactionRunner(logged),
        resolveSnapshot: async () => defaultSnapshot(),
      });

      try {
        const result = (await loggedRuntime.call("get_board", {
          column: "in_progress",
          limit: 200,
        })) as BoardOutput;

        // The page really is large — otherwise "one query" is trivially
        // true and this test proves nothing about scaling.
        expect(result.columns.in_progress.entries.length).toBeGreaterThanOrEqual(25);

        const assignmentQueries = statements.filter((q) => q.includes('FROM "Assignment"'));
        expect(assignmentQueries).toHaveLength(1);
      } finally {
        await logged.$disconnect();
      }
    }, 120_000);

    it("issues no assignment query at all when the page is empty", async () => {
      // The `entryIds.length > 0` guard. Not an optimisation for its own
      // sake: a withheld or filtered-to-nothing board should cost nothing
      // extra, and a query with an empty array parameter is a round trip
      // that can only return zero rows.
      //
      // Breaks if: the guard is removed — the count becomes 1 and this
      // fails.
      const logged = new PrismaClient({
        datasourceUrl: scratchUrl,
        log: [{ emit: "event", level: "query" }],
      });
      const statements: string[] = [];
      logged.$on("query", (event: { query: string }) => statements.push(event.query));
      const loggedRuntime = new ServiceRuntime({
        transaction: prismaTransactionRunner(logged),
        resolveSnapshot: async () => defaultSnapshot(),
      });

      try {
        const result = (await loggedRuntime.call("get_board", {
          column: "in_progress",
          // An area nothing was seeded under, so the page is genuinely empty.
          area: "an-area-with-nothing-in-it",
        })) as BoardOutput;
        expect(result.columns.in_progress.entries).toEqual([]);

        expect(statements.filter((q) => q.includes('FROM "Assignment"'))).toHaveLength(0);
      } finally {
        await logged.$disconnect();
      }
    }, 60_000);
  });

  describe("the assignee filter and the assignment output agree", () => {
    it("every card on a board filtered by assignee names that assignee", async () => {
      // `assignee` was a filter with no matching output — a caller could
      // narrow to one holder and still not be told who held anything. This
      // asserts the two halves are now consistent, which is the defect T3
      // exists to close.
      //
      // Breaks if: the attach pass reads a different predicate than the
      // filter does — e.g. one honours `releasedAt IS NULL` and the other
      // does not.
      const id = await makeExecutingItem("filtered by assignee");
      await claim({ itemId: id, sessionId: "s-filter", holderId: "crew-filter" });

      const result = await board({ assignee: "crew-filter" });
      const entries = result.columns.in_progress.entries;
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.assignments.map((a) => a.holderId)).toContain("crew-filter");
      }
    });
  });
});
