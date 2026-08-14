// MILESTONES.md #100 — `loop_add` / `loop_close`, the write half of open
// loops (SCHEMA.md §3a).
//
// The payload validators, the pairing fold and `orientation`'s read path all
// existed already; only the write was missing, so `orientation` could display
// a loop that nothing was able to record.
//
// **What these tests are careful about.** Asserting "a loop event was
// written" is the assertion that would let every interesting bug through: a
// loop is a *pair* correlated by `loopId`, so the write can succeed, the row
// can be present, and the loop can still be unclosable (wrong id), invisible
// (wrong payload shape), or unattributable (null session). Each of those
// passes a test that only counts rows. So these assert the payload the fold
// actually reads, and then assert against `deriveOpenLoops` itself — the same
// function `orientation` calls — rather than against a hand-rolled idea of
// what open means.
//
// Runs against a real Postgres: the claims are about rows and about an enum
// cast that only a real server checks. Skips without TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { deriveOpenLoops, type LoopEventLike } from "@/lib/open-loops";
import type { OrientationOutput } from "@/lib/service/operations/orientation";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface ServiceError {
  code: string;
  fields?: string[];
}

describeIfDb("loop_add and loop_close (#100), against Postgres", () => {
  const dbName = scratchDatabaseName("open_loop_writes");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
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

  afterEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let counter = 0;
  async function seedItem(): Promise<string> {
    counter += 1;
    const id = `loop-item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${counter}`,
        body: "body",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

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

  /** The loop events for an item, in the shape the fold reads. */
  async function loopEvents(itemId: string): Promise<LoopEventLike[]> {
    return prisma.$queryRawUnsafe<LoopEventLike[]>(
      `SELECT "id", "ts", "type", "payload" FROM "Event"
        WHERE "itemId" = $1 AND "type" IN ('open_loop'::"EventType", 'open_loop_closed'::"EventType")
        ORDER BY "id" ASC`,
      itemId,
    );
  }

  /** What `orientation` would report — the real fold, not a local reimplementation. */
  async function openLoops(itemId: string) {
    return deriveOpenLoops(await loopEvents(itemId));
  }

  async function callFails(op: string, input: Record<string, unknown>): Promise<ServiceError> {
    return (await runtime
      .call(op, input)
      .then(() => {
        throw new Error(`expected ${op} to reject, but it resolved`);
      })
      .catch((error: unknown) => error)) as ServiceError;
  }

  describe("loop_add", () => {
    it("writes a loop the read path then reports as open", async () => {
      const itemId = await seedItem();
      const added = (await runtime.call("loop_add", {
        itemId,
        text: "the retry path is untested",
      })) as { loopId: string };

      // Asserted through the real fold, not by counting rows: a row that the
      // fold cannot read is not a loop, however present it is.
      const loops = await openLoops(itemId);
      expect(loops).toHaveLength(1);
      expect(loops[0]?.loopId).toBe(added.loopId);
      expect(loops[0]?.text).toBe("the retry path is untested");
    });

    it("returns the generated loopId, without which the loop could never be closed", async () => {
      const itemId = await seedItem();
      const added = (await runtime.call("loop_add", { itemId, text: "x" })) as { loopId: string };

      expect(typeof added.loopId).toBe("string");
      expect(added.loopId.length).toBeGreaterThan(0);
      // The id is generated server-side, so a caller that is not told it holds
      // a loop it can never close. This is the assertion that catches the
      // return shape being reduced to just the event.
      const closed = await runtime.call("loop_close", { itemId, loopId: added.loopId });
      expect(closed).toBeTruthy();
      expect(await openLoops(itemId)).toHaveLength(0);
    });

    it("uses a caller-supplied loopId verbatim", async () => {
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "my-own-id", text: "x" });

      const loops = await openLoops(itemId);
      expect(loops[0]?.loopId).toBe("my-own-id");
    });

    it("writes the payload shape the fold reads, not merely an event", async () => {
      const itemId = await seedItem();
      const added = (await runtime.call("loop_add", { itemId, text: "cold boot" })) as {
        loopId: string;
      };

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop" } });
      expect(rows).toHaveLength(1);
      // The exact payload. `{loopId, text}` is what `parseOpenLoopPayload`
      // requires and what the fold reads; an event with a differently-shaped
      // payload is silently skipped by the read path, so a test that only
      // checked the row existed would pass while orientation showed nothing.
      expect(rows[0]?.payload).toEqual({ loopId: added.loopId, text: "cold boot" });
    });

    it("records the caller's session and live assignment", async () => {
      const itemId = await seedItem();
      const assignmentId = await claimFor(itemId, "session-1");

      await runtime.call("loop_add", { itemId, text: "x", sessionId: "session-1" });

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop" } });
      expect(rows[0]?.sessionId).toBe("session-1");
      expect(rows[0]?.assignmentId).toBe(assignmentId);
      // The assignment's holder is the more specific answer when the caller
      // did not say otherwise.
      expect(rows[0]?.actorType).toBe("agent");
      expect(rows[0]?.actorId).toBe("agent-a");
    });

    it("does not require an assignment — a person can note a loose end without holding the item", async () => {
      const itemId = await seedItem();
      await runtime.call("loop_add", {
        itemId,
        text: "x",
        actorType: "person",
        actorId: "user-a",
      });

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop" } });
      expect(rows[0]?.actorType).toBe("person");
      expect(rows[0]?.assignmentId).toBeNull();
      // The complement of the test above: requiring a claim would mean only
      // whoever holds the work can record a loose end in it.
      expect(await openLoops(itemId)).toHaveLength(1);
    });

    it("does not credit an assignment held by a different session", async () => {
      const itemId = await seedItem();
      await claimFor(itemId, "session-other");

      await runtime.call("loop_add", { itemId, text: "x", sessionId: "session-1" });

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop" } });
      expect(rows[0]?.assignmentId).toBeNull();
    });

    it("does not credit a released assignment", async () => {
      const itemId = await seedItem();
      const assignmentId = await claimFor(itemId, "session-1");
      await prisma.assignment.update({
        where: { id: assignmentId },
        data: { releasedAt: new Date() },
      });

      await runtime.call("loop_add", { itemId, text: "x", sessionId: "session-1" });

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop" } });
      // Dropping `AND "releasedAt" IS NULL` from `resolveActor`'s lookup makes
      // this the failing test. A finished session's identity must not be
      // attached to work recorded after it let go — and the session-id clause
      // alone does not catch it, because the session id still matches.
      expect(rows[0]?.assignmentId).toBeNull();
      // The session is still recorded: it is who called, which is true
      // regardless of what they hold.
      expect(rows[0]?.sessionId).toBe("session-1");
      // And the holder is NOT inherited from the dead claim.
      expect(rows[0]?.actorType).toBe("system");
      expect(rows[0]?.actorId).toBeNull();
    });

    it("does not credit a released assignment on the close either", async () => {
      const itemId = await seedItem();
      const assignmentId = await claimFor(itemId, "session-1");
      const added = (await runtime.call("loop_add", { itemId, text: "x" })) as { loopId: string };
      await prisma.assignment.update({
        where: { id: assignmentId },
        data: { releasedAt: new Date() },
      });

      await runtime.call("loop_close", { itemId, loopId: added.loopId, sessionId: "session-1" });

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop_closed" } });
      // Both write paths share `resolveActor`, but sharing is not a test —
      // a change to one call site would otherwise be caught only for the open.
      expect(rows[0]?.assignmentId).toBeNull();
    });

    it("refuses empty text", async () => {
      const itemId = await seedItem();
      const error = await callFails("loop_add", { itemId, text: "   " });
      // A loop with no text is a loop nobody can act on.
      expect(error.code).toBe("invalid_input");
    });

    it("refuses an item that does not exist", async () => {
      const error = await callFails("loop_add", { itemId: "no-such-item", text: "x" });
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["itemId"]);
    });

    it("refuses re-opening a loopId that is already open", async () => {
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "dup", text: "first" });

      const error = await callFails("loop_add", { itemId, loopId: "dup", text: "second" });
      // The fold keeps the FIRST occurrence (pinned by its own test below),
      // so a second open is not redundant — it is silently discarded, and a
      // caller who believed it had recorded new text would be wrong with no
      // way to notice.
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["loopId"]);

      const loops = await openLoops(itemId);
      expect(loops).toHaveLength(1);
      expect(loops[0]?.text).toBe("first");
    });

    it("refuses re-using a loopId whose loop was closed", async () => {
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "reuse", text: "first" });
      await runtime.call("loop_close", { itemId, loopId: "reuse" });

      const error = await callFails("loop_add", { itemId, loopId: "reuse", text: "second" });
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["loopId"]);

      // Nothing was written. Allowing this would append a row and return
      // success while producing a loop that can never be seen or closed:
      // `deriveOpenLoops` filters every open against a set of ALL closes, so
      // the earlier close suppresses this open too.
      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop" } });
      expect(rows).toHaveLength(1);
    });

    it("would produce an invisible, unclosable loop if reuse were allowed", async () => {
      // The failure the refusal above exists to prevent, demonstrated against
      // the real fold rather than argued in a comment — so that anyone
      // tempted to relax the rule can see what it costs. Written at the
      // ledger level because the operation now refuses to produce this state.
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "ghost", text: "first" });
      await runtime.call("loop_close", { itemId, loopId: "ghost" });

      // A second open of the same id, as a relaxed `loop_add` would write it.
      await prisma.event.create({
        data: {
          itemId,
          actorType: "system",
          type: "open_loop" as never,
          payload: { loopId: "ghost", text: "second" },
        },
      });

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop" } });
      expect(rows).toHaveLength(2);
      // Two opens in the ledger, and the read path reports nothing.
      expect(await openLoops(itemId)).toHaveLength(0);
      // And it cannot be cleaned up: `loop_close` refuses, because by the
      // only definition of open that exists, it is not open.
      const error = await callFails("loop_close", { itemId, loopId: "ghost" });
      expect(error.code).toBe("not_found");
    });

    it("allows a fresh loopId after an earlier loop on the item was closed", async () => {
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "first-id", text: "first" });
      await runtime.call("loop_close", { itemId, loopId: "first-id" });

      // The rule is one id used once, not one loop per item — a check that
      // rejected any open after any close would also pass the tests above.
      await runtime.call("loop_add", { itemId, loopId: "second-id", text: "second" });
      const loops = await openLoops(itemId);
      expect(loops).toHaveLength(1);
      expect(loops[0]?.loopId).toBe("second-id");
    });

    it("refuses a reused loopId even when the caller omits it on the first open", async () => {
      const itemId = await seedItem();
      const added = (await runtime.call("loop_add", { itemId, text: "first" })) as {
        loopId: string;
      };

      // The generated id is a real id: passing it back must collide like any
      // other. Narrowing the guard to caller-supplied ids only would let this
      // through.
      const error = await callFails("loop_add", { itemId, loopId: added.loopId, text: "second" });
      expect(error.code).toBe("invalid_input");
    });

    it("keeps loops on different items independent", async () => {
      const itemA = await seedItem();
      const itemB = await seedItem();
      await runtime.call("loop_add", { itemId: itemA, loopId: "shared", text: "a" });

      // The same id on another item is a different loop; refusing it would
      // make loopIds globally unique, which they are not.
      await runtime.call("loop_add", { itemId: itemB, loopId: "shared", text: "b" });

      expect(await openLoops(itemA)).toHaveLength(1);
      expect(await openLoops(itemB)).toHaveLength(1);
    });
  });

  describe("loop_close", () => {
    it("closes the loop the read path was reporting", async () => {
      const itemId = await seedItem();
      const added = (await runtime.call("loop_add", { itemId, text: "x" })) as { loopId: string };
      expect(await openLoops(itemId)).toHaveLength(1);

      await runtime.call("loop_close", { itemId, loopId: added.loopId });

      expect(await openLoops(itemId)).toHaveLength(0);
    });

    it("appends the close rather than deleting or updating the open", async () => {
      const itemId = await seedItem();
      const added = (await runtime.call("loop_add", { itemId, text: "x" })) as { loopId: string };
      await runtime.call("loop_close", { itemId, loopId: added.loopId });

      const rows = await loopEvents(itemId);
      // Both events survive. The ledger is append-only, and the loop's history
      // is the point — an implementation that deleted the open would also pass
      // "the loop is absent from the open set".
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.type)).toEqual(["open_loop", "open_loop_closed"]);
    });

    it("writes {loopId} only, not a second copy of the text", async () => {
      const itemId = await seedItem();
      const added = (await runtime.call("loop_add", { itemId, text: "x" })) as { loopId: string };
      await runtime.call("loop_close", { itemId, loopId: added.loopId });

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop_closed" } });
      // A second copy of the text is a second thing that can disagree.
      expect(rows[0]?.payload).toEqual({ loopId: added.loopId });
    });

    it("closes only the loop named, leaving the others open", async () => {
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "one", text: "first" });
      await runtime.call("loop_add", { itemId, loopId: "two", text: "second" });

      await runtime.call("loop_close", { itemId, loopId: "one" });

      const loops = await openLoops(itemId);
      // A close that cleared every loop would pass a single-loop test.
      expect(loops).toHaveLength(1);
      expect(loops[0]?.loopId).toBe("two");
    });

    it("refuses a loopId that was never opened", async () => {
      const itemId = await seedItem();
      const error = await callFails("loop_close", { itemId, loopId: "never-existed" });
      // The READ path deliberately ignores an unknown close (its window may
      // start after the open). The write path can see the whole history, so
      // the same input is a caller mistake here rather than an ordinary gap.
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["loopId"]);
    });

    it("refuses closing a loop that is already closed", async () => {
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "one", text: "x" });
      await runtime.call("loop_close", { itemId, loopId: "one" });

      const error = await callFails("loop_close", { itemId, loopId: "one" });
      expect(error.code).toBe("not_found");

      // And no second close row landed — an inert duplicate in the ledger.
      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop_closed" } });
      expect(rows).toHaveLength(1);
    });

    it("refuses a loop opened on a different item", async () => {
      const itemA = await seedItem();
      const itemB = await seedItem();
      await runtime.call("loop_add", { itemId: itemA, loopId: "only-on-a", text: "x" });

      const error = await callFails("loop_close", { itemId: itemB, loopId: "only-on-a" });
      // Loops are item-scoped. A close that searched globally would let one
      // item's close silence another item's loop.
      expect(error.code).toBe("not_found");
      expect(await openLoops(itemA)).toHaveLength(1);
    });

    it("records the caller's session and live assignment on the close", async () => {
      const itemId = await seedItem();
      const assignmentId = await claimFor(itemId, "session-1");
      const added = (await runtime.call("loop_add", { itemId, text: "x" })) as { loopId: string };

      await runtime.call("loop_close", { itemId, loopId: added.loopId, sessionId: "session-1" });

      const rows = await prisma.event.findMany({ where: { itemId, type: "open_loop_closed" } });
      // Who closed a loop is as much a fact as who opened it.
      expect(rows[0]?.sessionId).toBe("session-1");
      expect(rows[0]?.assignmentId).toBe(assignmentId);
    });

    it("refuses an item that does not exist", async () => {
      const error = await callFails("loop_close", { itemId: "no-such-item", loopId: "x" });
      expect(error.code).toBe("not_found");
      expect(error.fields).toEqual(["itemId"]);
    });
  });

  describe("the fold premises this operation depends on", () => {
    it("keeps the FIRST open of a loopId, which is what makes a duplicate open a silent loss", async () => {
      // `loop_add`'s duplicate refusal rests entirely on this. If the fold
      // kept the LAST occurrence instead, a second open would quietly WIN
      // rather than be discarded — still wrong, but a different wrong, and
      // the refusal's stated reason would then be false. Pinned here, in
      // the file that depends on it, so the coupling is visible from this
      // side rather than only in the fold's own tests.
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "first-wins", text: "first" });
      await prisma.event.create({
        data: {
          itemId,
          actorType: "system",
          type: "open_loop" as never,
          payload: { loopId: "first-wins", text: "second" },
        },
      });

      const loops = await openLoops(itemId);
      expect(loops).toHaveLength(1);
      expect(loops[0]?.text).toBe("first");
    });

    it("suppresses an open that appears after a close of the same id", async () => {
      // The exact behaviour the reuse refusal exists for, at the fold level:
      // the close set is global, so position in the stream does not save a
      // later open. If this ever changed to sequence-pairing, the reuse rule
      // could be relaxed — and this test is where that would first show up.
      const itemId = await seedItem();
      await runtime.call("loop_add", { itemId, loopId: "later", text: "first" });
      await runtime.call("loop_close", { itemId, loopId: "later" });
      await prisma.event.create({
        data: {
          itemId,
          actorType: "system",
          type: "open_loop" as never,
          payload: { loopId: "later", text: "second" },
        },
      });

      expect(await openLoops(itemId)).toHaveLength(0);
    });
  });

  describe("orientation sees what the write path recorded", () => {
    it("reports an open loop, and stops once it is closed", async () => {
      const itemId = await seedItem();
      const added = (await runtime.call("loop_add", {
        itemId,
        text: "the retry path is untested",
      })) as { loopId: string };

      const before = (await runtime.call("orientation", { itemId })) as OrientationOutput;
      // End to end through the real read operation: this is the milestone's
      // own point — orientation could display a loop nothing could record.
      expect(before.openLoops.loops).toHaveLength(1);
      expect(before.openLoops.loops[0]?.text).toBe("the retry path is untested");

      await runtime.call("loop_close", { itemId, loopId: added.loopId });

      const after = (await runtime.call("orientation", { itemId })) as OrientationOutput;
      expect(after.openLoops.loops).toHaveLength(0);
    });
  });
});
