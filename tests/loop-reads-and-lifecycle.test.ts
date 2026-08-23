// `loop_list`, `loop_get`, `loop_edit` and `loop_delete` — the read half of
// open loops, and the rest of their lifecycle.
//
// **What would make this file hollow.** Asserting that `loop_list` "returns
// some loops" would pass against a list that ignored every filter, every
// page bound and the preview cut — which is the entire operation. So the
// cases here pin the decisions: that closed loops are absent *by default*,
// that a deleted loop is absent even when closed ones are asked for, that
// the page composes across cursors without dropping or repeating a row, and
// that the text is actually cut. Each names the change to the source that
// breaks it.
//
// Runs against a real Postgres, because the claims are about a fold over
// rows and about two enum labels only a real server accepts. Skips without
// TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { LOOP_TEXT_PREVIEW_CHARS } from "@/lib/service/operations/loop-reads";
import {
  LOOP_DELETE_REASON_MIN_CHARS,
  LOOP_DELETE_REASON_GUARD,
  LOOP_DELETE_ALREADY_GUARD,
  LOOP_EDIT_DELETED_GUARD,
  readsAsClosure,
} from "@/lib/service/operations/loop-lifecycle";
import type { LoopListOutput, LoopGetOutput } from "@/lib/service/operations/loop-reads";
import type { OrientationOutput } from "@/lib/service/operations/orientation";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { claimItem } from "@/lib/claims";
import { registerSessions } from "./helpers/register-sessions";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ServiceError {
  code: string;
  guard?: string;
  fields?: string[];
}

/** Runs `call` and returns the error it threw, failing the test if it did not throw. */
async function rejection(call: Promise<unknown>): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

describeIfDb("loop reads and the rest of the lifecycle, against Postgres", () => {
  const dbName = scratchDatabaseName("loop_reads");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const scratch = await createMigratedScratchDatabase(testDatabaseUrl!, dbName);
    prisma = new PrismaClient({ datasourceUrl: scratch.url });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let counter = 0;
  async function seedItem(): Promise<string> {
    counter += 1;
    const id = `loop-read-item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Item ${counter}`,
        body: "seeded for the loop read tests",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

  const call = <T>(name: string, input: unknown): Promise<T> =>
    runtime.call(name as never, input, { caller: { actor: "tester" } }) as Promise<T>;

  const list = (input: Record<string, unknown>) => call<LoopListOutput>("loop_list", input);

  describe("loop_list — what it returns by default", () => {
    it("returns open loops with their id, status and opening time", async () => {
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "loop-a", text: "the retry path is untested" });

      const result = await list({ itemId });

      expect(result.total).toBe(1);
      expect(result.loops).toHaveLength(1);
      expect(result.loops[0]).toMatchObject({
        loopId: "loop-a",
        status: "open",
        text: "the retry path is untested",
        textTruncated: false,
        closedAt: null,
        editedAt: null,
      });
      expect(result.loops[0]!.openedAt).toEqual(expect.any(String));
    });

    it("excludes closed loops unless they are asked for", async () => {
      // The default that makes this a bound rather than only a convenience.
      // Killed by changing `includeClosed`'s `.default(false)` to
      // `.default(true)`, or by dropping the `status === "closed"` branch in
      // `selectLoops`.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "still-open", text: "open one" });
      await call("loop_add", { itemId, loopId: "resolved", text: "closed one" });
      await call("loop_close", { itemId, loopId: "resolved" });

      const byDefault = await list({ itemId });
      expect(byDefault.loops.map((l) => l.loopId)).toEqual(["still-open"]);
      expect(byDefault.total).toBe(1);

      const withClosed = await list({ itemId, includeClosed: true });
      expect(withClosed.loops.map((l) => l.loopId).sort()).toEqual(["resolved", "still-open"]);
      expect(withClosed.loops.find((l) => l.loopId === "resolved")?.status).toBe("closed");
    });

    it("excludes a deleted loop even when closed loops are asked for", async () => {
      // `includeClosed` must not imply `includeDeleted` — they are different
      // claims. Killed by folding the two flags into one, or by having
      // `selectLoops` fall through to `includeClosed` for a deleted loop.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "a duplicate" });
      await call("loop_delete", {
        itemId,
        loopId: "gone",
        reason: "duplicate of the retry-path loop",
      });

      expect((await list({ itemId })).loops).toEqual([]);
      expect((await list({ itemId, includeClosed: true })).loops).toEqual([]);

      const withDeleted = await list({ itemId, includeDeleted: true });
      expect(withDeleted.loops.map((l) => l.loopId)).toEqual(["gone"]);
      expect(withDeleted.loops[0]!.status).toBe("deleted");
    });

    it("cuts a long text to the preview length and says that it did", async () => {
      // Killed by returning `loop.text` where `previewText(...)` belongs, or
      // by hard-coding `textTruncated: false`.
      const itemId = await seedItem();
      const long = "x".repeat(LOOP_TEXT_PREVIEW_CHARS + 50);
      await call("loop_add", { itemId, loopId: "wordy", text: long });

      const loop = (await list({ itemId })).loops[0]!;
      expect(loop.text).toHaveLength(LOOP_TEXT_PREVIEW_CHARS);
      expect(loop.textTruncated).toBe(true);
    });

    it("leaves a short text whole and does not claim truncation", async () => {
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "brief", text: "short" });
      const loop = (await list({ itemId })).loops[0]!;
      expect(loop.text).toBe("short");
      expect(loop.textTruncated).toBe(false);
    });

    it("refuses an unknown item rather than returning an empty list", async () => {
      // "No such item" and "that item has no loops" must not look the same —
      // an empty list for a mistyped id reads as "there are none", which is
      // the false negative that caused a duplicate loop to be minted.
      // Killed by removing the `requireItemExists` call.
      const error = await rejection(list({ itemId: "no-such-item" }));
      expect(error.code).toBe("not_found");
      expect(error.fields).toContain("itemId");
    });
  });

  describe("loop_list — pagination", () => {
    async function seedLoops(itemId: string, count: number): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        await call("loop_add", {
          itemId,
          loopId: `loop-${String(index).padStart(2, "0")}`,
          text: `loose end ${index}`,
        });
      }
    }

    it("bounds a page to `limit` and reports the total behind it", async () => {
      const itemId = await seedItem();
      await seedLoops(itemId, 5);

      const page = await list({ itemId, limit: 2 });
      expect(page.loops).toHaveLength(2);
      // `total` is the count behind the page, not the page's own length —
      // killed by returning `page.length` for it.
      expect(page.total).toBe(5);
      expect(page.nextCursor).toBe("loop-01");
    });

    it("walks every loop exactly once across pages", async () => {
      // The property that matters for a cursor: no row dropped, none
      // repeated. Killed by an off-by-one in `start` (`at` instead of
      // `at + 1`), which would repeat the cursor row on every page.
      const itemId = await seedItem();
      await seedLoops(itemId, 7);

      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page: LoopListOutput = await list({
          itemId,
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.loops.map((l) => l.loopId));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toEqual([
        "loop-00",
        "loop-01",
        "loop-02",
        "loop-03",
        "loop-04",
        "loop-05",
        "loop-06",
      ]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("reports no cursor on the last page", async () => {
      // Killed by returning a cursor unconditionally, which would make a
      // caller page forever.
      const itemId = await seedItem();
      await seedLoops(itemId, 2);
      expect((await list({ itemId, limit: 5 })).nextCursor).toBeNull();
    });

    it("returns an empty page for an unrecognised cursor rather than restarting", async () => {
      // Re-serving page one to a caller that asked for page two is a loop
      // that never terminates. Killed by falling back to `start = 0` when
      // the cursor is not found.
      const itemId = await seedItem();
      await seedLoops(itemId, 3);
      const page = await list({ itemId, cursor: "no-such-loop" });
      expect(page.loops).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe("loop_get", () => {
    it("returns one loop in full, uncut", async () => {
      // The complement of the list's preview: killed by applying
      // `previewText` here too.
      const itemId = await seedItem();
      const long = "y".repeat(LOOP_TEXT_PREVIEW_CHARS + 80);
      await call("loop_add", { itemId, loopId: "wordy", text: long });

      const loop = await call<LoopGetOutput>("loop_get", { itemId, loopId: "wordy" });
      expect(loop.text).toBe(long);
      expect(loop.status).toBe("open");
      expect(loop.itemId).toBe(itemId);
    });

    it("resolves a deleted loop, reporting its status and reason", async () => {
      // A held reference must land somewhere real rather than at a hole —
      // the choice `delete_item` makes for an archived item. Killed by
      // filtering deleted loops out before the `find`.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "a mistake" });
      await call("loop_delete", {
        itemId,
        loopId: "gone",
        reason: "recorded against the wrong item",
      });

      const loop = await call<LoopGetOutput>("loop_get", { itemId, loopId: "gone" });
      expect(loop.status).toBe("deleted");
      expect(loop.deletedReason).toBe("recorded against the wrong item");
      expect(loop.deletedAt).toEqual(expect.any(String));
    });

    it("refuses a loopId that does not exist on the item", async () => {
      const itemId = await seedItem();
      const error = await rejection(call("loop_get", { itemId, loopId: "ghost" }));
      expect(error.code).toBe("not_found");
      expect(error.fields).toContain("loopId");
    });
  });

  describe("loop_edit", () => {
    it("sets the new text, keeps openedAt, and returns what it was before", async () => {
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "loop-a", text: "first wording" });
      const before = await call<LoopGetOutput>("loop_get", { itemId, loopId: "loop-a" });

      const edited = await call<{ previousText: string }>("loop_edit", {
        itemId,
        loopId: "loop-a",
        text: "second wording",
      });
      expect(edited.previousText).toBe("first wording");

      const after = await call<LoopGetOutput>("loop_get", { itemId, loopId: "loop-a" });
      expect(after.text).toBe("second wording");
      expect(after.openedAt).toBe(before.openedAt);
      expect(after.editedAt).toEqual(expect.any(String));
      expect(after.status).toBe("open");
    });

    it("writes an event rather than altering the opening one", async () => {
      // The append-only property, asserted against the ledger itself:
      // killed by any implementation that updated the original row.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "loop-a", text: "first wording" });
      await call("loop_edit", { itemId, loopId: "loop-a", text: "second wording" });

      const events = await prisma.event.findMany({
        where: { itemId, type: { in: ["open_loop", "open_loop_edited"] } },
        orderBy: { id: "asc" },
      });
      expect(events.map((e) => e.type)).toEqual(["open_loop", "open_loop_edited"]);
      // The original wording is still in the ledger, untouched.
      expect((events[0]!.payload as { text: string }).text).toBe("first wording");
    });

    it("allows editing a closed loop", async () => {
      // Correcting the record of something resolved is legitimate, and the
      // status must not change. Killed by widening the deleted-loop guard to
      // refuse any non-open loop.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "loop-a", text: "first" });
      await call("loop_close", { itemId, loopId: "loop-a" });
      await call("loop_edit", { itemId, loopId: "loop-a", text: "corrected" });

      const loop = await call<LoopGetOutput>("loop_get", { itemId, loopId: "loop-a" });
      expect(loop.text).toBe("corrected");
      expect(loop.status).toBe("closed");
    });

    it("refuses to edit a deleted loop", async () => {
      // The new text would be invisible to every read — a silent no-op,
      // which a write must never be. Killed by removing the guard.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "a mistake" });
      await call("loop_delete", { itemId, loopId: "gone", reason: "duplicate of the other loop" });

      const error = await rejection(
        call("loop_edit", { itemId, loopId: "gone", text: "new text" }),
      );
      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe(LOOP_EDIT_DELETED_GUARD);
    });

    it("refuses an empty text", async () => {
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "loop-a", text: "first" });
      const error = await rejection(call("loop_edit", { itemId, loopId: "loop-a", text: "   " }));
      expect(error.code).toBe("invalid_input");
    });

    it("refuses a loop that was never opened", async () => {
      const itemId = await seedItem();
      const error = await rejection(call("loop_edit", { itemId, loopId: "ghost", text: "x" }));
      expect(error.code).toBe("not_found");
    });
  });

  describe("loop_delete", () => {
    const goodReason = "a duplicate of the retry-path loop";

    it("retracts the loop and hides it from every ordinary read", async () => {
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "a duplicate" });
      const result = await call<{ text: string; previousStatus: string }>("loop_delete", {
        itemId,
        loopId: "gone",
        reason: goodReason,
      });
      expect(result.text).toBe("a duplicate");
      expect(result.previousStatus).toBe("open");

      expect((await list({ itemId })).loops).toEqual([]);
      const orientation = await call<OrientationOutput>("orientation", { itemId });
      // The assertion that makes deletion mean something across the whole
      // product, not just in `loop_list`.
      expect(orientation.openLoops.loops).toEqual([]);
    });

    it("is absent from EVERY read that surfaces loops, not just the ones nearby", async () => {
      // **This test exists because the narrower version of it was not
      // enough.** The original asserted the deletion guarantee against
      // `loop_list` and `orientation` only, and shipped a `progress_report`
      // that still reported deleted loops as open — the whole DB suite green
      // the entire time. A guarantee stated as "every read" has to be
      // asserted against every read, or it is a guarantee about the two
      // surfaces someone happened to think of.
      //
      // `progress_report` is session-scoped, so it needs a live claim; the
      // other three are item-scoped. Each is killed by narrowing that
      // surface's loop-event slice back to two types.
      const sessionId = "session-delete-sweep";
      const itemId = await seedItem();
      await registerSessions(prisma, [sessionId]);
      await prisma.$transaction((tx) =>
        claimItem(tx, {
          itemId,
          role: "builder",
          holderType: "agent",
          holderId: sessionId,
          sessionId,
          rootSessionId: sessionId,
          machine: "test-machine",
        }),
      );
      await call("loop_add", {
        itemId,
        sessionId,
        loopId: "gone",
        text: "a uniquely phrased retracted loose end",
      });
      await call("loop_delete", {
        itemId,
        loopId: "gone",
        reason: "a duplicate of the loop on the sibling task",
      });

      expect((await list({ itemId })).loops).toEqual([]);

      const orientation = await call<OrientationOutput>("orientation", { itemId });
      expect(orientation.openLoops.loops).toEqual([]);

      const detail = await call<{ history: { type: string }[] }>("get_item_detail", {
        id: itemId,
      });
      // The detail view folds loops client-side from this history, so the
      // guarantee there depends on the deleting event being *present* in it.
      expect(detail.history.map((entry) => entry.type)).toContain("open_loop_deleted");

      const found = await call<{ loopMatches: unknown[] }>("search", {
        query: "uniquely phrased retracted",
        includeLoops: true,
      });
      expect(found.loopMatches).toEqual([]);

      const progress = await call<{ rows: { flags: string[] }[]; report: string }>(
        "progress_report",
        { sessionId },
      );
      expect(progress.rows[0]?.flags ?? []).toEqual([]);
      expect(progress.report).not.toContain("uniquely phrased retracted");
    });

    it("serves an edited loop's current wording on every read", async () => {
      // The edit half of the same sweep. A stale slice cannot see the edit,
      // so each surface would serve superseded text — asserted here against
      // the superseded wording being absent, not merely the current one being
      // present, so a read returning both still fails.
      const sessionId = "session-edit-sweep";
      const itemId = await seedItem();
      await registerSessions(prisma, [sessionId]);
      await prisma.$transaction((tx) =>
        claimItem(tx, {
          itemId,
          role: "builder",
          holderType: "agent",
          holderId: sessionId,
          sessionId,
          rootSessionId: sessionId,
          machine: "test-machine",
        }),
      );
      await call("loop_add", { itemId, sessionId, loopId: "refined", text: "supersededwording" });
      await call("loop_edit", { itemId, loopId: "refined", text: "currentwording" });

      const listed = (await list({ itemId })).loops;
      expect(listed[0]!.text).toBe("currentwording");

      const orientation = await call<OrientationOutput>("orientation", { itemId });
      expect(orientation.openLoops.loops[0]!.text).toBe("currentwording");

      const progress = await call<{ rows: { flags: string[] }[] }>("progress_report", {
        sessionId,
      });
      expect(progress.rows[0]?.flags).toEqual(["currentwording"]);

      const forOld = await call<{ loopMatches: unknown[] }>("search", {
        query: "supersededwording",
        includeLoops: true,
      });
      expect(forOld.loopMatches).toEqual([]);
    });

    it("keeps the events in the ledger", async () => {
      // "It is called delete and it never deletes" — killed by any
      // implementation that removed rows.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "a duplicate" });
      await call("loop_delete", { itemId, loopId: "gone", reason: goodReason });

      const events = await prisma.event.findMany({ where: { itemId }, orderBy: { id: "asc" } });
      expect(events.map((e) => e.type)).toEqual(["open_loop", "open_loop_deleted"]);
    });

    it("refuses a reason shorter than the minimum", async () => {
      // Killed by removing the length check, or by lowering the constant to
      // 0 — the test reads the constant, so it tracks a deliberate change
      // and still fails on the check being dropped.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "x" });
      const error = await rejection(
        call("loop_delete", { itemId, loopId: "gone", reason: "dupe" }),
      );
      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe(LOOP_DELETE_REASON_GUARD);
      expect("dupe".length).toBeLessThan(LOOP_DELETE_REASON_MIN_CHARS);
    });

    it("refuses a reason that describes a resolution, naming loop_close", async () => {
      // The steering that converts the mistake rather than only blocking it.
      // Killed by emptying `CLOSURE_REASON_PHRASES`.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "x" });
      const error = await rejection(
        call("loop_delete", {
          itemId,
          loopId: "gone",
          reason: "this has been resolved in the latest build",
        }),
      );
      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe(LOOP_DELETE_REASON_GUARD);
      expect((error as unknown as { message: string }).message).toContain("loop_close");
    });

    it("refuses a second deletion rather than reporting success", async () => {
      // Returning success would tell a caller who confused two loop ids that
      // they retracted the one they named. Killed by removing the guard.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "x" });
      await call("loop_delete", { itemId, loopId: "gone", reason: goodReason });
      const error = await rejection(
        call("loop_delete", { itemId, loopId: "gone", reason: goodReason }),
      );
      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe(LOOP_DELETE_ALREADY_GUARD);
    });

    it("does not free the loopId for reuse", async () => {
      // The no-reuse rule is load-bearing for the fold's order-independence,
      // so deletion must not become a way around it. Killed by having
      // `loop_add`'s collision check skip deleted loops.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "x" });
      await call("loop_delete", { itemId, loopId: "gone", reason: goodReason });
      const error = await rejection(call("loop_add", { itemId, loopId: "gone", text: "again" }));
      expect(error.code).toBe("invalid_input");
    });

    it("keeps the id reserved even when only a lifecycle row carries it", async () => {
      // **The collision check has to see EVERY event type, not just the two
      // that bracket a loop.** `loop_add`'s own comment claims it checks
      // "every loop event for the id"; a slice naming only `open_loop` and
      // `open_loop_closed` quietly made that false.
      //
      // The nearby "does not free the loopId" case does NOT catch this: it
      // deletes a loop whose `open_loop` row is still inside the two-type
      // slice, so the id collides either way and the narrow slice survives.
      // Proved by mutation — that test passed against the stale query.
      //
      // Here the opening event is removed from the ledger after the fact, so
      // the deleting row is the *only* remaining trace of the id. A stale
      // slice sees nothing, lets the id be re-minted, and produces a loop
      // whose terminal state is already recorded against it — the one thing
      // the fold cannot represent.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "ghosted", text: "a mistake" });
      await call("loop_delete", {
        itemId,
        loopId: "ghosted",
        reason: "a duplicate of the loop on the sibling task",
      });
      await prisma.event.deleteMany({ where: { itemId, type: "open_loop" } });

      const error = await rejection(call("loop_add", { itemId, loopId: "ghosted", text: "again" }));
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toContain("loopId");
    });

    it("can retract a closed loop, reporting what it was", async () => {
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "gone", text: "x" });
      await call("loop_close", { itemId, loopId: "gone" });
      const result = await call<{ previousStatus: string }>("loop_delete", {
        itemId,
        loopId: "gone",
        reason: goodReason,
      });
      expect(result.previousStatus).toBe("closed");
    });
  });

  describe("orientation stays bounded on loops", () => {
    it("caps the loop list at `limit` and says when it did", async () => {
      // The overflow this whole row exists to fix. Killed by removing the
      // slice, or by hard-coding `loopsTruncated: false`.
      const itemId = await seedItem();
      for (let index = 0; index < 6; index += 1) {
        await call("loop_add", { itemId, loopId: `loop-${index}`, text: `loose end ${index}` });
      }

      const result = await call<OrientationOutput>("orientation", { itemId, limit: 3 });
      expect(result.openLoops.loops).toHaveLength(3);
      expect(result.openLoops.loopsTruncated).toBe(true);
    });

    it("cuts each loop's text to the preview and reports it", async () => {
      const itemId = await seedItem();
      await call("loop_add", {
        itemId,
        loopId: "wordy",
        text: "z".repeat(LOOP_TEXT_PREVIEW_CHARS + 40),
      });

      const result = await call<OrientationOutput>("orientation", { itemId });
      expect(result.openLoops.loops[0]!.text).toHaveLength(LOOP_TEXT_PREVIEW_CHARS);
      expect(result.openLoops.loopTextTruncated).toBe(true);
    });

    it("does not claim truncation when everything fitted", async () => {
      // The negative control: a flag that is always true is as useless as
      // one that is always false. Killed by hard-coding either flag to true.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "brief", text: "short" });

      const result = await call<OrientationOutput>("orientation", { itemId });
      expect(result.openLoops.loopsTruncated).toBe(false);
      expect(result.openLoops.loopTextTruncated).toBe(false);
    });
  });

  describe("search reaches loop text", () => {
    it("finds an open loop by its text and names the loop it matched", async () => {
      // The empty-result failure this fixes: before, a phrase recorded only
      // in a loop was findable by nothing. Killed by dropping `loopId` from
      // the result, which would leave a caller unable to act on the hit.
      const itemId = await seedItem();
      await call("loop_add", {
        itemId,
        loopId: "cold-boot",
        text: "never checked the cold boot path",
      });

      const found = await call<{ loopMatches: { itemId: string; loopId: string }[] }>("search", {
        query: "cold boot",
        includeLoops: true,
      });
      expect(found.loopMatches).toHaveLength(1);
      expect(found.loopMatches[0]).toMatchObject({ itemId, loopId: "cold-boot" });
    });

    it("does not search loop text unless asked, and says so", async () => {
      // The notice is what stops an empty result reading as "nothing
      // exists". Killed by removing the `loopRoute` sentence.
      const itemId = await seedItem();
      await call("loop_add", {
        itemId,
        loopId: "cold-boot",
        text: "never checked the cold boot path",
      });

      const found = await call<{ loopMatches: unknown[]; notice: string }>("search", {
        query: "cold boot",
      });
      expect(found.loopMatches).toEqual([]);
      expect(found.notice).toContain("includeLoops");
    });

    it("matches the current wording of an edited loop, not the original", async () => {
      // The reason the match is applied after the fold rather than as SQL
      // ILIKE against the opening event. Killed by matching in SQL.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "loop-a", text: "the original phrasing" });
      await call("loop_edit", { itemId, loopId: "loop-a", text: "the replacement phrasing" });

      const forNew = await call<{ loopMatches: unknown[] }>("search", {
        query: "replacement",
        includeLoops: true,
      });
      expect(forNew.loopMatches).toHaveLength(1);

      const forOld = await call<{ loopMatches: unknown[] }>("search", {
        query: "original",
        includeLoops: true,
      });
      expect(forOld.loopMatches).toEqual([]);
    });

    it("ignores closed and deleted loops", async () => {
      // Killed by removing the `status !== "open"` filter in `searchLoops`.
      const itemId = await seedItem();
      await call("loop_add", { itemId, loopId: "resolved", text: "a distinctive phrase" });
      await call("loop_close", { itemId, loopId: "resolved" });
      await call("loop_add", { itemId, loopId: "gone", text: "a distinctive phrase" });
      await call("loop_delete", { itemId, loopId: "gone", reason: "duplicate of the closed one" });

      const found = await call<{ loopMatches: unknown[] }>("search", {
        query: "distinctive phrase",
        includeLoops: true,
      });
      expect(found.loopMatches).toEqual([]);
    });
  });

  describe("readsAsClosure", () => {
    it("spots a closure word", () => {
      expect(readsAsClosure("this is resolved now")).toBe("resolved");
    });

    it("passes a genuine retraction reason", () => {
      // The false-positive control: a matcher that refused everything would
      // pass the "refuses a closure" test above and be useless.
      expect(readsAsClosure("a duplicate of the retry-path loop")).toBeNull();
    });
  });
});
