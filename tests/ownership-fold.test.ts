// `ownership` — the three ownership verbs, proved by writing then reading back.
//
// ── What would make this file hollow, stated first ──────────────────────
//
// A fold's forwarding can be wrong in a way that several kinds of test
// agree with. A refusal assertion passes whether the call was refused for
// the reason the test meant or for a different reason entirely — an
// unrecognised key refuses identically whatever it contains — and a
// comparison against a literal passes when the literal is wrong in the same
// way the builder is.
//
// So every action below is proved by WRITING and READING BACK: a claim is
// made and then found in `my_work`, a release is made and then absent from
// it, a takeover is made and the holder observed to have changed. A payload
// that reached the wrong delegate, or the right delegate under a name it
// ignores, changes WHO HOLDS WHAT — and that is what the assertions look at.
//
// **`takeover` is the one worth the extra care**, because it names both
// sides of the displacement. A fold that swapped `fromSessionId` and
// `bySessionId` would still be a well-formed call to a real operation; it
// would simply displace the wrong session. So it is asserted by reading the
// holder afterwards, not by the call succeeding.
//
// Refusal assertions DO appear, for the cases that are genuinely about
// refusing, and each pins something beyond the `code`.
//
// ── The guard this fold must not weaken ─────────────────────────────────
//
// `claim` carries `claims.one_crew_per_item`, and §22 forbids waiving a
// guard-rejectable operation off an adapter that exposes writes. The
// argument for the waiver is that a fold loses no guard coverage — the
// delegate throws the SAME refusal object through the fold. That is an
// assertion about behaviour, so it is asserted: the refusal is provoked
// THROUGH the folded tool and its `code` and `guard` are compared against
// the refusal the unfolded operation raises for the same situation.
//
// ── The mutations this file was checked against ─────────────────────────
//
//   - swap `fromSessionId` and `bySessionId` on the takeover branch → the
//     holder-after-takeover test fails.
//   - stop forwarding `role` on the claim branch → the claim is refused,
//     and the round-trip test fails.
//   - make action `release` return without reaching its delegate → the
//     release test fails, because the item is still held afterwards.
//
// Each was run; each failed as described.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import { registerSessions } from "./helpers/register-sessions";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A refusal, as a caught value carries it. */
type Refusal = { code?: string; guard?: string; fields?: string[]; message?: string };

/**
 * The refusal a call raised — failing if it did not raise one.
 *
 * The success path throws rather than returning an empty object: an empty
 * object's `code` is `undefined`, and an assertion that `undefined` is not
 * `"conflict"` passes. A refusal test that goes green when nothing was
 * refused is precisely the hollowness this file's header is about.
 */
async function refusalFrom(call: Promise<unknown>): Promise<Refusal> {
  try {
    await call;
  } catch (thrown) {
    return thrown as Refusal;
  }
  throw new Error("the call was expected to be refused and succeeded instead");
}

describeIfDb("ownership, against Postgres", () => {
  const dbName = scratchDatabaseName("ownership_fold");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let scratchUrl: string | undefined;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (scratchUrl) await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  let counter = 0;
  function nextSession(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  async function makeItem() {
    return (await runtime.call("create_item", {
      title: "An item whose ownership changes",
      body: "The work this item stands for, so the create is well-formed.",
      area: "ownership-fold",
      originType: "auto",
    })) as unknown as { id: string };
  }

  /** The item ids this session holds, read back from the server. */
  async function heldBy(sessionId: string): Promise<string[]> {
    // `my_work` returns an entry per assignment, with the item nested —
    // reached through `entry.item.id` rather than `entry.id`, which is the
    // assignment's. Getting that wrong returns a list of `undefined`, which
    // is why this reads the id out rather than the whole entry.
    const work = (await runtime.call("my_work", { sessionId })) as unknown as {
      items: { item: { id: string } }[];
    };
    return work.items.map((entry) => entry.item.id);
  }

  /** Who holds this item now, as the server reports it. */
  async function holderOf(itemId: string): Promise<string[]> {
    const rows = await prisma.assignment.findMany({
      where: { itemId, releasedAt: null },
      select: { sessionId: true },
    });
    return rows.map((row) => row.sessionId).sort();
  }

  describe("action claim", () => {
    it("takes the item, and the session is found holding it afterwards", async () => {
      // **Write then read back.** Nothing here asserts what the fold built;
      // it asserts that the session now holds an item it did not hold
      // before, which is only true if every field the claim needed arrived
      // under the name the delegate declares.
      const item = await makeItem();
      const sessionId = nextSession("claimer");
      await registerSessions(prisma, [sessionId]);

      expect(await heldBy(sessionId)).not.toContain(item.id);

      await runtime.call("ownership", {
        action: "claim",
        itemId: item.id,
        role: "builder",
        holderType: "agent",
        holderId: "builder-a",
        sessionId,
      });

      expect(await heldBy(sessionId)).toContain(item.id);
      expect(await holderOf(item.id)).toEqual([sessionId]);
    });

    it("refuses a second crew with the same guard the unfolded operation raises", async () => {
      // **The §22 argument, asserted rather than claimed.** The waiver of a
      // guard-rejectable operation is legal because a fold loses no guard
      // coverage: the delegate throws the SAME refusal object. So the
      // refusal is provoked through the fold and compared, field for field,
      // against the one the operation raises directly for the same
      // situation. A fold that caught and re-raised its own error would
      // differ here even while looking correct.
      const item = await makeItem();
      const holder = nextSession("holder");
      const stranger = nextSession("stranger");
      await registerSessions(prisma, [holder, stranger]);

      await runtime.call("ownership", {
        action: "claim",
        itemId: item.id,
        role: "builder",
        holderType: "agent",
        holderId: "builder-a",
        sessionId: holder,
      });

      const throughFold = await refusalFrom(
        runtime.call("ownership", {
          action: "claim",
          itemId: item.id,
          role: "builder",
          holderType: "agent",
          holderId: "builder-b",
          sessionId: stranger,
        }),
      );
      const direct = await refusalFrom(
        runtime.call("claim", {
          itemId: item.id,
          role: "builder",
          holderType: "agent",
          holderId: "builder-b",
          sessionId: stranger,
        }),
      );

      expect(throughFold.code).toBe(direct.code);
      expect(throughFold.guard).toBe(direct.guard);
      expect(throughFold.fields).toEqual(direct.fields);
      // ...and it is the guard this argument is about, not any refusal at
      // all — without this the two could agree by both being `invalid_input`.
      expect(throughFold.guard).toBe("claims.one_crew_per_item");
    });

    it("refuses a claim missing a field it cannot run without, naming it", async () => {
      // `role` is the one field no shape supplies, so its absence is still
      // a plain schema refusal. `holderType`, `holderId` and `sessionId`
      // are deliberately NOT in this list any more: they are carried inside
      // `leaseKey`, so requiring them here would refuse a correct key-only
      // claim before the delegate ever ran.
      const item = await makeItem();
      const refusal = await refusalFrom(
        runtime.call("ownership", {
          action: "claim",
          itemId: item.id,
          leaseKey: "lk1.aaaa.bbbb",
        }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.fields).toEqual(expect.arrayContaining(["role"]));
    });

    it("refuses a claim that states no identity at all, under the lease-key guard", async () => {
      // A presence list cannot express this, which is why the check sits
      // in the delegate instead: asking "is each named field present"
      // accepts a partial legacy shape such as `sessionId` alone, while
      // this asks whether EITHER shape is complete.
      const item = await makeItem();
      const refusal = await refusalFrom(
        runtime.call("ownership", { action: "claim", itemId: item.id, role: "builder" }),
      );
      expect(refusal.code).toBe("guard_rejected");
      expect(refusal.guard).toBe("claims.lease_key_required");
      expect(refusal.fields).toEqual(expect.arrayContaining(["leaseKey"]));
    });
  });

  describe("action release", () => {
    it("gives the item up, and the session is found holding nothing", async () => {
      const item = await makeItem();
      const sessionId = nextSession("releaser");
      await registerSessions(prisma, [sessionId]);

      await runtime.call("ownership", {
        action: "claim",
        itemId: item.id,
        role: "builder",
        holderType: "agent",
        holderId: "builder-a",
        sessionId,
      });
      expect(await heldBy(sessionId)).toContain(item.id);

      await runtime.call("ownership", { action: "release", itemId: item.id, sessionId });

      // Read back rather than trusting the call: an action pointed at the
      // wrong delegate could return successfully and leave the row held.
      expect(await heldBy(sessionId)).not.toContain(item.id);
      expect(await holderOf(item.id)).toEqual([]);
    });
  });

  describe("action takeover", () => {
    it("displaces the session it was told to displace, not the other one", async () => {
      // **The assertion `takeover` actually needs.** Both sessions are real
      // and both are named in the call, so a fold that swapped them would
      // make a well-formed call to a real operation and displace the wrong
      // one. Only reading the holder afterwards can tell.
      const item = await makeItem();
      const holder = nextSession("displaced");
      const taker = nextSession("taker");
      await registerSessions(prisma, [holder, taker]);

      await runtime.call("ownership", {
        action: "claim",
        itemId: item.id,
        role: "builder",
        holderType: "agent",
        holderId: "builder-a",
        sessionId: holder,
      });
      expect(await holderOf(item.id)).toEqual([holder]);

      await runtime.call("ownership", {
        action: "takeover",
        itemId: item.id,
        fromSessionId: holder,
        bySessionId: taker,
        holderType: "agent",
        holderId: "builder-b",
        force: true,
        reason: "the holder has gone quiet and the work is blocking a release",
      });

      // A takeover frees the previous assignment and does NOT assign the
      // item to the caller — which is the operation's own documented
      // behaviour, and asserting it here is what stops this test from
      // passing against a fold that quietly did both.
      expect(await holderOf(item.id)).toEqual([]);
      expect(await heldBy(holder)).not.toContain(item.id);
      expect(await heldBy(taker)).not.toContain(item.id);
    });

    it("refuses a takeover missing the sessions it must name", async () => {
      const item = await makeItem();
      const refusal = await refusalFrom(
        runtime.call("ownership", { action: "takeover", itemId: item.id }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.fields).toEqual(
        expect.arrayContaining(["fromSessionId", "bySessionId", "holderType", "holderId"]),
      );
    });
  });

  describe("the shape of the tool", () => {
    it("refuses an action it does not have", async () => {
      const refusal = await refusalFrom(
        runtime.call("ownership", { action: "abandon", itemId: "item-1" }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.fields).toContain("action");
    });

    it("refuses a field no action of this tool accepts, naming it", async () => {
      // The strict schema is what keeps a typo from being silently dropped.
      // Asserted on the message because an unrecognised key is reported
      // with an empty path, so `fields` is `[]` for this class while the
      // sentence names the key.
      //
      // This used `leaseKey` as its example until that became a real field
      // on this tool. The example has to be a name the schema genuinely
      // does not know, or the test asserts nothing.
      const refusal = await refusalFrom(
        runtime.call("ownership", {
          action: "release",
          itemId: "item-1",
          sessionId: "sess-1",
          leeseKey: "not-a-field-here",
        }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.message).toContain("leeseKey");
    });

    it("refuses `leaseKey` on an action that does not use it, rather than ignoring it", async () => {
      // `leaseKey` is meaningful on `claim` and meaningless on `release`,
      // and the fold's schema is one object shared by all three actions —
      // so without this, a key passed to `release` is accepted and silently
      // dropped. A caller that believed it was releasing a specific lease
      // would get no signal that the field did nothing.
      const refusal = await refusalFrom(
        runtime.call("ownership", {
          action: "release",
          itemId: "item-1",
          sessionId: "sess-1",
          leaseKey: "lk1.aaaa.bbbb",
        }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.message).toContain("leaseKey");
    });
  });
});
