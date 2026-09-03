// Telling a displaced session it was displaced — `src/lib/service/session-displacement.ts`
// and the `enforcement` field `hook_decision` carries it on.
//
// ── What these cases are really protecting ─────────────────────────────
//
// Taking an item over releases a row and records who took it. It cannot
// stop the session it displaced, which keeps running against work it does
// not own — so the useful property is not "the takeover succeeded" but
// **"the displaced session finds out on its next call"**. Four claims carry
// that, and each is written so that removing the feature fails a named case
// rather than quietly passing:
//
//   1. A displaced session is told, and told *on an ordinary call* — the
//      call it is actually most likely to make next.
//   2. The notice names **who** took the item and **when**, because those
//      are the two facts that let it hand over rather than merely stop.
//   3. An undisplaced session is told nothing at all, so the field stays
//      absent on the overwhelming majority of calls.
//   4. Delivery is **not** a dependency of the takeover. A takeover of a
//      session that is genuinely gone — the common case — must still work.
//
// The database-backed cases run against real Postgres because the question
// is which rows the statement selects: `liveness = 'superseded'` versus a
// plain `releasedAt`, and newest-first ordering. A modelled handle would be
// asserting that the test's own `if` matches the SQL, which is the mistake
// rather than the coverage.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { displacedDetail, displacementFor } from "@/lib/service/session-displacement";
import { takeoverAssignment } from "@/lib/takeover";
import { enforcementRefusal, readSessionStatus } from "@/lib/hook/enforcement";
import type { TransactionHandle } from "@/lib/service/context";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A handle that answers the displacement lookup from a described list. */
function handleReturning(rows: readonly unknown[]): TransactionHandle {
  return {
    $queryRawUnsafe: async <T = unknown>(): Promise<T> => rows as T,
    $executeRawUnsafe: async () => {
      throw new Error("the displacement lookup must not write");
    },
  };
}

describe("the sentence a displaced session is shown", () => {
  it("names who took the item and when, which are the two facts it can act on", () => {
    const detail = displacedDetail({
      itemId: "item-a",
      bySessionId: "session-b",
      at: new Date("2026-01-02T03:04:05.000Z"),
    });

    // Asserted as three separate containments rather than one whole-string
    // equality: the wording is allowed to change, and the facts are not.
    expect(detail).toContain("item-a");
    expect(detail).toContain("session-b");
    expect(detail).toContain("2026-01-02T03:04:05.000Z");
  });

  it("says the holder is unknown rather than rendering a shorter sentence", () => {
    // The columns are nullable and a takeover always writes them, so a null
    // here means something upstream is wrong. Saying so is what gives the
    // reader something to go and ask about; silently omitting the clause
    // would hide it.
    const detail = displacedDetail({ itemId: "item-a", bySessionId: null, at: null });

    expect(detail).toContain("item-a");
    expect(detail).toContain("unrecorded");
  });

  it("does not throw on a timestamp that arrived as something other than a Date", () => {
    // A raw query hands back whatever the driver produced. An absent column
    // arrives as `undefined` and a date can arrive unrevived, and both used
    // to reach `.toISOString()` — inside the hook's own path, where the
    // throw becomes an unexplained internal error on a tool call.
    for (const at of [undefined, null, "2026-01-02T03:04:05.000Z" as unknown as Date]) {
      expect(() => displacedDetail({ itemId: "item-a", bySessionId: "s", at })).not.toThrow();
    }
  });
});

describe("what the lookup reports", () => {
  it("says nothing about a session with no superseded assignment", async () => {
    // The ordinary session, and the value that matters most: `undefined` is
    // what the hook reads as "nothing said about this session" and passes
    // through. Anything else here would refuse every call in the system.
    await expect(displacementFor(handleReturning([]), "s1")).resolves.toBeUndefined();
  });

  it("refuses to speak about a row carrying no item", async () => {
    // A notice that named an undefined item would stop a session and give
    // it nothing to hand over, which is worse than staying quiet.
    await expect(
      displacementFor(handleReturning([{ supersededBy: "s2", releasedAt: new Date() }]), "s1"),
    ).resolves.toBeUndefined();
  });

  it("reports a displacement as the status the hook already refuses on", async () => {
    const found = await displacementFor(
      handleReturning([
        {
          itemId: "item-a",
          supersededBy: "session-b",
          releasedAt: new Date("2026-01-02T00:00:00Z"),
        },
      ]),
      "s1",
    );

    expect(found?.status).toBe("displaced");
    expect(found?.detail).toContain("session-b");
  });
});

describe("the notice survives the trip the hook actually makes", () => {
  it("is refused on by the hook once it has crossed the wire as JSON", () => {
    // The end-to-end claim, without a server: the payload is serialised and
    // re-read exactly as `ask-http` re-reads a response body, then handed to
    // the same reader the hook uses. This is what proves the two halves
    // agree on a shape — a field renamed on either side fails here.
    const payload = {
      status: "displaced",
      detail: displacedDetail({
        itemId: "item-a",
        bySessionId: "session-b",
        at: new Date("2026-01-02T03:04:05.000Z"),
      }),
    };

    const read = readSessionStatus(JSON.parse(JSON.stringify(payload)));
    const refusal = enforcementRefusal(read);

    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe("displaced");
    // The session is told to stop, and told which item and who has it.
    expect(refusal?.reason).toContain("item-a");
    expect(refusal?.reason).toContain("session-b");
  });
});

describeIfDb("against a real database", () => {
  // A scratch database per file, following this tree's own convention: what
  // is under test is which rows the statement selects, and a shared database
  // would let another file's fixtures answer that.
  const dbName = scratchDatabaseName("session_displacement");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
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

  /**
   * A `TransactionHandle` backed by a bare client.
   *
   * Not a transaction: each statement runs in its own. Sufficient here
   * because every case below is sequential, and called out because it would
   * NOT be sufficient for anything asserting on the `FOR UPDATE` lock the
   * takeover takes.
   */
  function dbHandle(): TransactionHandle {
    return {
      $queryRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$queryRawUnsafe(query, ...values),
      $executeRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$executeRawUnsafe(query, ...values),
    };
  }

  const thresholds = { staleAfterSeconds: 900, deadAfterSeconds: 1800 };

  let counter = 0;
  async function seedItem(): Promise<string> {
    counter += 1;
    const id = `item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: "executing",
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function seedAssignment(args: {
    readonly itemId: string;
    readonly sessionId: string;
    readonly lastActive?: Date;
  }): Promise<string> {
    const row = await prisma.assignment.create({
      data: {
        itemId: args.itemId,
        role: "builder",
        holderType: "agent",
        holderId: "holder-a",
        sessionId: args.sessionId,
        rootSessionId: args.sessionId,
        machine: "laptop",
        liveness: "running",
        lastActive: args.lastActive ?? new Date(),
      },
    });
    return row.id;
  }

  /** A forced takeover of a holder that is still live. */
  async function takeFrom(args: {
    readonly itemId: string;
    readonly fromSessionId: string;
    readonly bySessionId: string;
  }) {
    return takeoverAssignment(dbHandle(), thresholds, {
      itemId: args.itemId,
      fromSessionId: args.fromSessionId,
      bySessionId: args.bySessionId,
      byHolderType: "agent",
      byHolderId: "holder-b",
      reason: "the person running this system asked for it",
      force: true,
    });
  }

  it("tells a session that a real takeover displaced it, naming who and when", async () => {
    // The whole point of the row, end to end. The takeover runs through the
    // real library function rather than a hand-written UPDATE, so if it ever
    // stopped writing `supersededBy` or the `superseded` liveness this case
    // would go quiet — which is exactly the coupling worth having.
    const itemId = await seedItem();
    await seedAssignment({ itemId, sessionId: "session-displaced" });

    await takeFrom({ itemId, fromSessionId: "session-displaced", bySessionId: "session-taker" });

    const found = await displacementFor(dbHandle(), "session-displaced");

    expect(found?.status).toBe("displaced");
    expect(found?.detail).toContain(itemId);
    expect(found?.detail).toContain("session-taker");
    // A real timestamp, not the unknown-time fallback: the notice is only
    // actionable if "when" is genuinely answered.
    expect(found?.detail).not.toContain("unrecorded");
  });

  it("says nothing about the session that did the taking", async () => {
    // The counterpart nobody would notice being wrong. A lookup keyed on the
    // item rather than on the session would refuse the *taker* — the one
    // session that definitely should keep working — and every happy-path
    // assertion above would still pass.
    const itemId = await seedItem();
    await seedAssignment({ itemId, sessionId: "session-displaced" });

    await takeFrom({ itemId, fromSessionId: "session-displaced", bySessionId: "session-taker" });

    await expect(displacementFor(dbHandle(), "session-taker")).resolves.toBeUndefined();
  });

  it("does not mistake an ordinary release for a takeover", async () => {
    // The discriminator, and the case that decides whether this notice is
    // rare or constant. A voluntary release also sets `releasedAt`; reading
    // that as a displacement would refuse every session that had politely
    // finished its work, on the highest-volume path in the system.
    const itemId = await seedItem();
    const assignmentId = await seedAssignment({ itemId, sessionId: "session-released" });

    await prisma.assignment.update({
      where: { id: assignmentId },
      data: { releasedAt: new Date(), liveness: "dead" },
    });

    await expect(displacementFor(dbHandle(), "session-released")).resolves.toBeUndefined();
  });

  it("takes over a dead session's item without any notice being deliverable", async () => {
    // Recovering a claim from a session that is genuinely gone is the common
    // case, and it must not depend on anything being delivered. The holder
    // here is quiet well past the dead threshold, so the takeover needs
    // neither force nor a reason — and the notice it leaves behind is simply
    // never collected, because that session will never call again.
    const itemId = await seedItem();
    await seedAssignment({
      itemId,
      sessionId: "session-dead",
      lastActive: new Date(Date.now() - 10 * 60 * 60 * 1000),
    });

    const result = await takeoverAssignment(dbHandle(), thresholds, {
      itemId,
      fromSessionId: "session-dead",
      bySessionId: "session-taker",
      byHolderType: "agent",
      byHolderId: "holder-b",
    });

    expect(result.holderLiveness).toBe("dead");
    expect(result.forced).toBe(false);
    expect(result.superseded.releasedAt).not.toBeNull();
    // The claim is genuinely free for the next session, which is what the
    // takeover was for. Whether anyone ever reads the notice is irrelevant to
    // that, and this asserts the two are not coupled.
    expect(result.superseded.liveness).toBe("superseded");
  });

  it("reports the most recent displacement when a session was displaced twice", async () => {
    // A session that held several items may have been displaced on more than
    // one. The newest is the one it has not yet reacted to; a previous
    // displacement describes work it has already stopped doing.
    const older = await seedItem();
    const newer = await seedItem();
    await seedAssignment({ itemId: older, sessionId: "session-twice" });
    await seedAssignment({ itemId: newer, sessionId: "session-twice" });

    await takeFrom({ itemId: older, fromSessionId: "session-twice", bySessionId: "taker-1" });
    await takeFrom({ itemId: newer, fromSessionId: "session-twice", bySessionId: "taker-2" });

    const found = await displacementFor(dbHandle(), "session-twice");

    expect(found?.detail).toContain(newer);
    expect(found?.detail).not.toContain(older);
  });
});
