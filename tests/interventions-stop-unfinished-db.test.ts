// The unfinished-work producer's query, against a real Postgres —
// `src/lib/interventions/stop-context.ts`.
//
// ── Why this file exists, stated as the failure it exists to catch ─────
//
// The unit tests for this half assert on the *text* of the query, against a
// handle that answers with canned rows. That proves the string was written;
// it cannot prove the string means anything. The sibling file
// `interventions-wind-down-context-db.test.ts` makes the same argument for
// the same reason, and names the mutant that motivated it: a clause that
// still contains the right substring while matching everything.
//
// The equivalent mutant here is worse, because it is the difference between
// a useful nudge and the one thing the row's third criterion forbids. A
// count that dropped its session scoping would still contain every word the
// text assertions look for — `"Event"`, `"Assignment"`, `sessionId` — while
// returning the whole board. Every session would then be told it had
// unfinished work at every stop, which is precisely how
// `nits-merged-with-nothing-tracking-them` became noise.
//
// ── The criterion this file is the evidence for ────────────────────────
//
// Criterion 6: **a real session ending with an open unblocked item it
// minted produces the firing — not a unit test.** The last two cases do
// exactly that. An item is created through the real `create_task`
// operation, carrying a real session on the caller envelope; the real
// producer then runs against the rows that operation wrote, and the real
// client parser and the real `evaluateStopCatch` decide what the session is
// told. Nothing in that path is a fake, and in particular nothing writes
// the `Event` row by hand — if `create-core.ts` ever stops stamping the
// creating session onto the creation event, this file fails and the unit
// tests do not.
//
// Criterion 3's negative case is proved the same way, and it is the more
// important of the two: a session that finished its work gets silence.
//
// Skips without TEST_DATABASE_URL, like every other database-backed file
// here; CI's database job runs it, and `check:db-gated:require` fails there
// if the URL is missing rather than skipping silently.

import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem, type ClaimInput } from "@/lib/claims";
import { assembleStopContext } from "@/lib/interventions/stop-context";
import { evaluateStopCatch, readStopContext } from "@/lib/hook/stop-catch";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the unfinished-work producer — against Postgres", () => {
  const dbName = scratchDatabaseName("interventions_stop_unfinished");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  const AREA = "stop-nudge-tests";
  const DEAD_AFTER = 900;
  const WAIT_TIMEOUT = 240;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      AREA,
    );
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.assignment.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.itemArea.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let seq = 0;

  /**
   * Mints a project and a task under it **through the real operation**,
   * with `sessionId` on the caller envelope.
   *
   * Deliberately not a hand-written INSERT. The whole point of this file is
   * that the creation `Event` — its type, its payload shape and its
   * `sessionId` — is written by `create-core.ts` rather than by the test,
   * so the query is matched against what the product actually records.
   */
  async function mintTask(sessionId: string, title: string): Promise<string> {
    const project = (await runtime.call(
      "create_project",
      {
        title: `project ${seq++} ${title}`,
        body: "body",
        area: AREA,
        originType: "auto",
      },
      { caller: { sessionId, type: "agent", id: "crew-one" } as never },
    )) as { id: string };

    const task = (await runtime.call(
      "create_task",
      {
        title,
        body: "body",
        area: AREA,
        originType: "auto",
        projectId: project.id,
      },
      { caller: { sessionId, type: "agent", id: "crew-one" } as never },
    )) as { id: string };

    return task.id;
  }

  /** Moves a row to a state, as the product would. */
  async function setState(itemId: string, state: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = $2::"ItemState" WHERE "id" = $1`,
      itemId,
      state,
    );
  }

  function assemble(sessionId: string) {
    return assembleStopContext({
      db: prisma as never,
      sessionId,
      deadAfterSeconds: DEAD_AFTER,
      waitTimeoutMaxSeconds: WAIT_TIMEOUT,
    });
  }

  /** What the session is actually told, through the real client path. */
  function told(context: unknown) {
    const parsed = readStopContext(JSON.parse(JSON.stringify(context)));
    return evaluateStopCatch({ eventType: "Stop", sessionId: "s-stop" }, parsed);
  }

  it("counts an item this session minted and left on the deck", async () => {
    await mintTask("s-stop", "left open");

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(1);
  });

  it("does not count another session's item", async () => {
    // **The mutant this file exists for.** Dropping the session predicate
    // leaves every text assertion in the unit suite passing and makes this
    // return 1 — which is the whole board arriving as "your unfinished
    // work", the noise failure the row forbids.
    await mintTask("s-other", "someone else's");

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(0);
  });

  it("stops counting a row once it reaches a terminal state", async () => {
    const id = await mintTask("s-stop", "finished");
    await setState(id, "merged");

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(0);
  });

  it("does not count a row the session recorded as blocked", async () => {
    // Telling a session to carry on with work it has recorded as undoable
    // is the first thing that would make this channel ignorable.
    const id = await mintTask("s-stop", "genuinely blocked");
    await setState(id, "blocked");

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(0);
  });

  it("does not count a deliberately paused row", async () => {
    const id = await mintTask("s-stop", "parked on purpose");
    await setState(id, "paused");

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(0);
  });

  it("does not count work that has been handed to a reviewer", async () => {
    // The session finished and handed off. That is done, not abandoned.
    const id = await mintTask("s-stop", "in review");
    await setState(id, "in_review");

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(0);
  });

  it("counts a row this session claimed but never minted", async () => {
    // The second ownership route. A session that picked up someone else's
    // row and left it open owns that gap too.
    const id = await mintTask("s-other", "picked up");
    await prisma.$transaction((tx) =>
      claimItem(tx, {
        itemId: id,
        sessionId: "s-stop",
        role: "builder",
        holderType: "agent",
        holderId: "crew-one",
        machine: "desktop",
      } as ClaimInput),
    );

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(1);
  });

  it("still counts a row whose claim the session released while open", async () => {
    // The third route, and the easiest way to stop owning something
    // without finishing it. An `releasedAt IS NULL` filter on the
    // Assignment branch would pass every other case here and fail this one.
    const id = await mintTask("s-other", "dropped");
    await prisma.$transaction((tx) =>
      claimItem(tx, {
        itemId: id,
        sessionId: "s-stop",
        role: "builder",
        holderType: "agent",
        holderId: "crew-one",
        machine: "desktop",
      } as ClaimInput),
    );
    await runtime.call("release", { itemId: id, sessionId: "s-stop" });

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(1);
  });

  it("counts a row once even when the session both minted and claimed it", async () => {
    // `COUNT(DISTINCT)` doing its job. A join instead of the two `EXISTS`
    // branches would report 2 and the message would quote a number twice
    // the truth.
    const id = await mintTask("s-stop", "mine twice over");
    await prisma.$transaction((tx) =>
      claimItem(tx, {
        itemId: id,
        sessionId: "s-stop",
        role: "builder",
        holderType: "agent",
        holderId: "crew-one",
        machine: "desktop",
      } as ClaimInput),
    );

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(1);
  });

  it("does not count an archived row", async () => {
    const id = await mintTask("s-stop", "archived");
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "archivedAt" = now(), "archivedReason" = 'duplicate' WHERE "id" = $1`,
      id,
    );

    expect((await assemble("s-stop"))?.unfinishedWork).toBe(0);
  });

  // ── Criterion 6, and the negative case that matters more ─────────────

  it("a real session ending with an item it minted and left open is told", async () => {
    // Criterion 6, end to end and against real rows: the item is created by
    // the real operation, the count comes from the real query, and the
    // sentence comes from the real client evaluator.
    await mintTask("s-stop", "the thing it walked away from");

    const caught = told(await assemble("s-stop"));

    expect(caught?.reason).toBe("unfinished-work");
    expect(caught?.unfinishedWork).toBe(1);
    // Singular, because one item is one item.
    expect(caught?.text).toMatch(/^1 item you opened or claimed/);
    // The part Ope asked for: the blocker must be tested, not accepted.
    expect(caught?.text).toMatch(/genuinely outside your reach/i);
    expect(caught?.text).toMatch(/scout/i);
    expect(caught?.text).toMatch(/if you can touch it/i);
    // Still advisory — a Stop cannot be refused.
    expect(caught?.text).toMatch(/not a refusal/i);
    expect(caught).not.toHaveProperty("decision");
  });

  it("a real session that finished everything is told nothing at all", async () => {
    // **Criterion 3, the case that decides whether this entry survives.**
    // Same session, same rows, same path as the case above — the only
    // difference is that the work reached a terminal state. An entry that
    // fires here is noise and gets filtered within a week, and once
    // filtered it is gone for the case that mattered.
    const merged = await mintTask("s-stop", "finished and merged");
    await setState(merged, "merged");
    const blocked = await mintTask("s-stop", "genuinely waiting on a person");
    await setState(blocked, "blocked");

    const context = await assemble("s-stop");

    // Zero rather than absent: the query ran and found nothing left.
    expect(context?.unfinishedWork).toBe(0);
    expect(told(context)).toBeNull();
  });

  it("a session that never touched the board is told nothing", async () => {
    // The commonest stop of all. A session with no rows of its own must not
    // be handed the backlog.
    await mintTask("s-other", "not yours");

    const context = await assemble("s-stop");

    expect(context?.unfinishedWork).toBe(0);
    expect(told(context)).toBeNull();
  });
});
